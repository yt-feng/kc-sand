#!/usr/bin/env node

import { chromium } from "playwright";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dateMatchesTargetDay,
  extractArabNewsDocument,
  isCloudflareChallengeText
} from "./extractors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const SOURCE_URLS = {
  videos: "https://www.arabnews.com/videos",
  home: "https://www.arabnews.com/"
};

const outputDir = path.resolve(repoRoot, process.env.OUTPUT_DIR || "data");
const artifactDir = path.resolve(repoRoot, process.env.ARTIFACT_DIR || "artifacts");
const archiveDir = path.resolve(repoRoot, process.env.ARCHIVE_DIR || "archive/latest");
const renderedClipsRoot = path.resolve(repoRoot, process.env.RENDERED_CLIPS_ROOT || "rendered-clips");
const timeZone = process.env.TIME_ZONE || "Asia/Riyadh";
const videoLimit = Number(process.env.VIDEO_LIMIT || 3);
const extraWaitMs = Number(process.env.EXTRA_WAIT_MS || 8000);
const allowEmpty = process.env.ALLOW_EMPTY === "1" || process.env.ALLOW_EMPTY === "true";
const savePageArtifacts =
  process.env.SAVE_PAGE_ARTIFACTS === "1" || process.env.SAVE_PAGE_ARTIFACTS === "true";
const archiveItems = process.env.ARCHIVE_ITEMS !== "0" && process.env.ARCHIVE_ITEMS !== "false";
const saveArticleHtml =
  process.env.SAVE_ARTICLE_HTML === "1" || process.env.SAVE_ARTICLE_HTML === "true";
const saveVideoFiles = process.env.SAVE_VIDEO_FILES !== "0" && process.env.SAVE_VIDEO_FILES !== "false";
const maxVideoBytes = Number(process.env.MAX_VIDEO_BYTES || 95_000_000);

function todayIsoInTimeZone(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function proxyOptions() {
  const server = process.env.PLAYWRIGHT_PROXY_SERVER || "";
  if (!server) return undefined;

  const options = { server };
  if (process.env.PLAYWRIGHT_PROXY_USERNAME) {
    options.username = process.env.PLAYWRIGHT_PROXY_USERNAME;
  }
  if (process.env.PLAYWRIGHT_PROXY_PASSWORD) {
    options.password = process.env.PLAYWRIGHT_PROXY_PASSWORD;
  }
  return options;
}

function toRelativeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function slugify(value) {
  return String(value || "item")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
}

function itemArchiveName(item, index) {
  const nodeId = item.url?.match(/\/node\/(\d+)/)?.[1];
  const prefix = String(index + 1).padStart(2, "0");
  return [prefix, nodeId, slugify(item.title)].filter(Boolean).join("-");
}

function renderedClipName(item, index) {
  const prefix = String(index + 1).padStart(2, "0");
  return `${prefix}_${slugify(item.title)}.mp4`;
}

function escapeMarkdown(value) {
  return String(value || "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function markdownLink(label, url) {
  return `[${escapeMarkdown(label)}](${url})`;
}

function imageExtension(contentType, url) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const byType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg"
  }[type];
  if (byType) return byType;

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(jpe?g|png|gif|webp|svg)$/.test(ext)) return ext;
  } catch {
    // Use a stable fallback below.
  }

  return ".jpg";
}

function isPotentialVideoUrl(url, contentType = "") {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerType = String(contentType || "").toLowerCase();
  if (lowerUrl.startsWith("blob:")) return false;
  if (lowerUrl.includes("imasdk.googleapis.com")) return false;
  if (lowerUrl.includes("doubleclick.net")) return false;
  if (lowerUrl.includes("googlesyndication.com")) return false;
  if (lowerUrl.includes("recaptcha")) return false;
  if (lowerUrl.includes("addtoany.com")) return false;
  if (/\.(mp4|m4v|mov|webm|m3u8)(\?|$)/i.test(lowerUrl)) return true;
  return (
    lowerType.startsWith("video/") ||
    lowerType.includes("mpegurl") ||
    lowerType.includes("application/vnd.apple.mpegurl")
  );
}

function videoExtension(contentType, url) {
  const type = String(contentType || "").split(";")[0].trim().toLowerCase();
  const byType = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "application/vnd.apple.mpegurl": ".m3u8",
    "application/x-mpegurl": ".m3u8"
  }[type];
  if (byType) return byType;

  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.(mp4|m4v|mov|webm|m3u8)$/.test(ext)) return ext;
  } catch {
    // Use a stable fallback below.
  }

  return ".mp4";
}

function dedupeUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${command} exited with ${code}: ${stderr || stdout}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function findFfmpegExecutable() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.join(repoRoot, "node_modules", "playwright-core", ".local-browsers", "ffmpeg"),
    path.join(repoRoot, "node_modules", "playwright", ".local-browsers", "ffmpeg")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  const cacheRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright")
  ].filter(Boolean);

  for (const root of cacheRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("ffmpeg-")) continue;
        const directory = path.join(root, entry.name);
        const files = await readdir(directory, { recursive: true });
        for (const file of files) {
          const basename = path.basename(file);
          if (basename === "ffmpeg" || basename === "ffmpeg.exe" || basename.startsWith("ffmpeg-")) {
            return path.join(directory, file);
          }
        }
      }
    } catch {
      // Try the next cache root.
    }
  }

  return "ffmpeg";
}

async function maybeRemoveOversizeFile(filePath) {
  const info = await stat(filePath);
  if (info.size <= maxVideoBytes) return info.size;

  await unlink(filePath).catch(() => {});
  throw new Error(`Downloaded video is ${info.size} bytes, above MAX_VIDEO_BYTES=${maxVideoBytes}`);
}

async function downloadDirectVideo(context, videoUrl, filePath) {
  const response = await context.request.get(videoUrl, {
    timeout: Number(process.env.VIDEO_TIMEOUT_MS || 120000)
  });
  if (!response.ok()) {
    throw new Error(`Video request failed with ${response.status()}`);
  }

  const contentType = response.headers()["content-type"] || "";
  const extension = videoExtension(contentType, videoUrl);
  if (extension === ".m3u8") return null;

  const finalPath = extension === ".mp4" ? filePath : filePath.replace(/\.mp4$/i, extension);
  const body = await response.body();
  if (body.length > maxVideoBytes) {
    throw new Error(`Video is ${body.length} bytes, above MAX_VIDEO_BYTES=${maxVideoBytes}`);
  }

  await writeFile(finalPath, body);
  return {
    path: toRelativeRepoPath(finalPath),
    url: videoUrl,
    contentType,
    bytes: body.length,
    method: "direct"
  };
}

async function downloadHlsVideo(videoUrl, filePath) {
  const ffmpeg = await findFfmpegExecutable();
  const timeoutSeconds = Math.ceil(Number(process.env.VIDEO_TIMEOUT_MS || 180000) / 1000);
  await runCommand(ffmpeg, [
    "-y",
    "-nostdin",
    "-loglevel",
    "warning",
    "-rw_timeout",
    String(timeoutSeconds * 1_000_000),
    "-i",
    videoUrl,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    filePath
  ]);

  const bytes = await maybeRemoveOversizeFile(filePath);
  return {
    path: toRelativeRepoPath(filePath),
    url: videoUrl,
    contentType: "application/vnd.apple.mpegurl",
    bytes,
    method: "ffmpeg-hls"
  };
}

async function downloadVideoFile(context, videoUrls, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const errors = [];
  for (const videoUrl of dedupeUrls(videoUrls)) {
    try {
      if (/\.m3u8(\?|$)/i.test(videoUrl)) {
        return await downloadHlsVideo(videoUrl, filePath);
      }

      const direct = await downloadDirectVideo(context, videoUrl, filePath);
      if (direct) return direct;
    } catch (error) {
      errors.push({
        url: videoUrl,
        error: String(error?.message || error)
      });
    }
  }

  return {
    skipped: true,
    reason: errors.length > 0 ? "No candidate video URL could be downloaded." : "No candidate video URL found.",
    errors
  };
}

async function saveDebug(page, name, details) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, `${name}.json`), JSON.stringify(details, null, 2));

  try {
    await writeFile(path.join(artifactDir, `${name}.html`), await page.content());
  } catch (error) {
    await writeFile(path.join(artifactDir, `${name}.html.error.txt`), String(error?.stack || error));
  }

  try {
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
  } catch (error) {
    await writeFile(path.join(artifactDir, `${name}.png.error.txt`), String(error?.stack || error));
  }
}

function extractArticleSnapshot() {
  function clean(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function attr(selector, name) {
    return document.querySelector(selector)?.getAttribute(name) || "";
  }

  function absoluteUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, document.location.href);
      url.hash = "";
      return url.toString();
    } catch {
      return "";
    }
  }

  const title =
    clean(document.querySelector("h1")?.innerText) ||
    clean(attr("meta[property='og:title']", "content")) ||
    clean(document.title);
  const description =
    clean(attr("meta[name='description']", "content")) ||
    clean(attr("meta[property='og:description']", "content"));
  const image =
    absoluteUrl(attr("meta[property='og:image']", "content")) ||
    absoluteUrl(document.querySelector("article img, main img")?.getAttribute("src"));
  const published =
    attr("meta[property='article:published_time']", "content") ||
    attr("meta[name='pubdate']", "content") ||
    attr("time[datetime]", "datetime");
  const modified = attr("meta[property='article:modified_time']", "content");
  const author =
    clean(attr("meta[name='author']", "content")) ||
    clean(document.querySelector("[rel='author'], .author, [class*='author']")?.textContent);

  const contentRoot =
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.querySelector("[class*='article']") ||
    document.body;

  const paragraphs = [...contentRoot.querySelectorAll("p, li")]
    .map((element) => clean(element.innerText))
    .filter((text) => text.length >= 20)
    .filter((text, index, values) => values.indexOf(text) === index);

  const text = paragraphs.join("\n\n");
  const videoUrls = [
    ...document.querySelectorAll("video[src], video source[src], iframe[src], embed[src]")
  ]
    .map((element) => absoluteUrl(element.getAttribute("src")))
    .filter(Boolean)
    .filter((url, index, values) => values.indexOf(url) === index);

  return {
    title,
    description,
    image,
    published,
    modified,
    author,
    canonical: absoluteUrl(attr("link[rel='canonical']", "href")) || document.location.href,
    text,
    textLength: text.length,
    videoUrls,
    pageTitle: document.title,
    bodyText: clean(document.body?.innerText || "")
  };
}

async function downloadImage(context, imageUrl, directory) {
  if (!imageUrl) return null;

  const response = await context.request.get(imageUrl, {
    timeout: Number(process.env.IMAGE_TIMEOUT_MS || 30000)
  });
  if (!response.ok()) {
    throw new Error(`Image request failed with ${response.status()}`);
  }

  const contentType = response.headers()["content-type"] || "";
  const extension = imageExtension(contentType, imageUrl);
  const filePath = path.join(directory, `image${extension}`);
  const body = await response.body();
  await writeFile(filePath, body);

  return {
    path: toRelativeRepoPath(filePath),
    url: imageUrl,
    contentType,
    bytes: body.length
  };
}

function articleMarkdown({ item, snapshot, imageArchive, videoArchive }) {
  const lines = [
    `# ${snapshot.title || item.title}`,
    "",
    `Source: ${item.url}`,
    `Captured source: ${snapshot.canonical || item.url}`
  ];

  if (snapshot.published) lines.push(`Published: ${snapshot.published}`);
  if (snapshot.modified) lines.push(`Modified: ${snapshot.modified}`);
  if (snapshot.author) lines.push(`Author: ${snapshot.author}`);
  if (snapshot.description) {
    lines.push("", "## Summary", "", snapshot.description);
  }
  if (imageArchive?.path) {
    lines.push("", "## Image", "", `![main image](./${path.basename(imageArchive.path)})`);
  } else if (snapshot.image || item.image) {
    lines.push("", "## Image", "", snapshot.image || item.image);
  }
  if (snapshot.videoUrls?.length) {
    lines.push("", "## Video Or Embed URLs", "");
    for (const url of snapshot.videoUrls) lines.push(`- ${url}`);
  }
  if (videoArchive?.path) {
    lines.push("", "## Downloaded Video", "", `- [${path.basename(videoArchive.path)}](../../../${videoArchive.path})`);
  } else if (videoArchive?.skipped) {
    lines.push("", "## Downloaded Video", "", `- Skipped: ${videoArchive.reason}`);
  }

  lines.push("", "## Text", "", snapshot.text || "_No article body text captured._", "");
  return lines.join("\n");
}

async function archiveOneItem(context, group, item, index, targetDate) {
  const directory = path.join(archiveDir, group, itemArchiveName(item, index));
  await mkdir(directory, { recursive: true });

  const page = await context.newPage();
  const result = {
    group,
    index,
    title: item.title,
    url: item.url,
    directory: toRelativeRepoPath(directory),
    status: "pending"
  };

  try {
    const mediaUrls = [];
    page.on("response", async (response) => {
      try {
        const headers = response.headers();
        const url = response.url();
        if (isPotentialVideoUrl(url, headers["content-type"] || "")) {
          mediaUrls.push(url);
        }
      } catch {
        // Ignore response inspection failures.
      }
    });

    const response = await page.goto(item.url, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.ARTICLE_TIMEOUT_MS || 90000)
    });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(Number(process.env.ARTICLE_WAIT_MS || 1500));

    const snapshot = await page.evaluate(extractArticleSnapshot);
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const pageTitle = await page.title().catch(() => "");
    const challengeDetected = isCloudflareChallengeText(bodyText, pageTitle) || response?.status() === 403;
    const candidateVideoUrls = dedupeUrls([
      ...mediaUrls,
      ...(snapshot.videoUrls || [])
    ]).filter((url) => isPotentialVideoUrl(url));

    let imageArchive = null;
    const imageUrl = snapshot.image || item.image;
    if (imageUrl && !challengeDetected) {
      try {
        imageArchive = await downloadImage(context, imageUrl, directory);
      } catch (error) {
        result.imageError = String(error?.message || error);
      }
    }

    let videoArchive = null;
    if (group === "videos" && saveVideoFiles && !challengeDetected) {
      const clipPath = path.join(renderedClipsRoot, targetDate, renderedClipName(item, index));
      videoArchive = await downloadVideoFile(context, candidateVideoUrls, clipPath);
    }

    const metadata = {
      ...item,
      capturedAt: new Date().toISOString(),
      responseStatus: response?.status() ?? null,
      responseUrl: response?.url() || page.url(),
      challengeDetected,
      snapshot: {
        title: snapshot.title,
        description: snapshot.description,
        image: snapshot.image,
        published: snapshot.published,
        modified: snapshot.modified,
        author: snapshot.author,
        canonical: snapshot.canonical,
        textLength: snapshot.textLength,
        videoUrls: candidateVideoUrls,
        pageTitle: snapshot.pageTitle
      },
      videoDownload: videoArchive,
      files: {
        metadata: toRelativeRepoPath(path.join(directory, "metadata.json")),
        content: toRelativeRepoPath(path.join(directory, "content.md")),
        text: toRelativeRepoPath(path.join(directory, "page-text.txt")),
        html: saveArticleHtml ? toRelativeRepoPath(path.join(directory, "page.html")) : null,
        image: imageArchive?.path || null,
        video: videoArchive?.path || null
      }
    };

    await writeFile(path.join(directory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(path.join(directory, "content.md"), articleMarkdown({ item, snapshot, imageArchive, videoArchive }));
    await writeFile(path.join(directory, "page-text.txt"), `${snapshot.bodyText || snapshot.text || ""}\n`);
    if (saveArticleHtml) {
      await writeFile(path.join(directory, "page.html"), await page.content());
    }

    result.status = challengeDetected ? "challenge" : "ok";
    result.files = metadata.files;
    result.videoUrls = candidateVideoUrls;
    result.image = imageArchive;
    result.video = videoArchive;
  } catch (error) {
    result.status = "error";
    result.error = String(error?.stack || error);
    await writeFile(path.join(directory, "error.json"), `${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await page.close().catch(() => {});
  }

  item.archive = {
    directory: result.directory,
    status: result.status,
    files: result.files || null
  };

  return result;
}

async function archiveLatestItemsToRepo(context, output) {
  const groups = [
    ["videos", output.videos],
    ["headlines", output.headlines.items]
  ];
  const results = [];

  await rm(archiveDir, { recursive: true, force: true });
  await rm(path.join(renderedClipsRoot, output.targetDate.iso), { recursive: true, force: true });
  await mkdir(archiveDir, { recursive: true });

  for (const [group, items] of groups) {
    for (const [index, item] of items.entries()) {
      results.push(await archiveOneItem(context, group, item, index, output.targetDate.iso));
    }
  }

  const summary = {
    capturedAt: new Date().toISOString(),
    directory: toRelativeRepoPath(archiveDir),
    renderedClipsDirectory: toRelativeRepoPath(path.join(renderedClipsRoot, output.targetDate.iso)),
    itemCount: results.length,
    okCount: results.filter((item) => item.status === "ok").length,
    challengeCount: results.filter((item) => item.status === "challenge").length,
    errorCount: results.filter((item) => item.status === "error").length,
    results
  };

  await writeFile(path.join(archiveDir, "index.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    path.join(archiveDir, "index.md"),
    [
      "# Arab News Archive",
      "",
      `Captured at: ${summary.capturedAt}`,
      `Items: ${summary.itemCount}`,
      `OK: ${summary.okCount}`,
      `Challenges: ${summary.challengeCount}`,
      `Errors: ${summary.errorCount}`,
      "",
      ...results.map(
        (item) =>
          `- ${markdownLink(item.title, item.url)} - ${item.status} - \`${item.directory}/content.md\`${item.video?.path ? ` - video: \`${item.video.path}\`` : ""}`
      ),
      ""
    ].join("\n")
  );

  return summary;
}

async function gotoAndExtract(context, { url, mode, limit }) {
  const page = await context.newPage();
  let responseStatus = null;
  let responseUrl = url;
  let navigationError = null;

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.NAVIGATION_TIMEOUT_MS || 90000)
    });
    responseStatus = response?.status() ?? null;
    responseUrl = response?.url() || page.url();

    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (extraWaitMs > 0) await page.waitForTimeout(extraWaitMs);

    const extracted = await page.evaluate(extractArabNewsDocument, {
      mode,
      limit
    });
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const title = await page.title().catch(() => "");
    const challengeDetected =
      extracted.challengeDetected || isCloudflareChallengeText(bodyText, title) || responseStatus === 403;

    const details = {
      url,
      responseUrl,
      responseStatus,
      mode,
      challengeDetected,
      diagnostics: extracted.diagnostics,
      itemCount: extracted.items.length
    };

    if (savePageArtifacts || challengeDetected || extracted.items.length === 0 || responseStatus >= 400) {
      await saveDebug(page, `arabnews-${mode}`, details);
    }

    await page.close();
    return {
      ...extracted,
      responseStatus,
      responseUrl,
      challengeDetected
    };
  } catch (error) {
    navigationError = String(error?.stack || error);
    await saveDebug(page, `arabnews-${mode}`, {
      url,
      responseUrl,
      responseStatus,
      mode,
      navigationError
    });
    await page.close().catch(() => {});
    return {
      pageUrl: responseUrl,
      pageTitle: "",
      responseStatus,
      responseUrl,
      challengeDetected: false,
      itemCount: 0,
      items: [],
      diagnostics: { mode, navigationError }
    };
  }
}

function selectTodayHeadlines(items, targetISO) {
  const datedToday = [];
  const datedOther = [];
  const undated = [];

  for (const item of items) {
    if (item.datePublished) {
      if (dateMatchesTargetDay(item.datePublished, targetISO, timeZone)) {
        datedToday.push(item);
      } else {
        datedOther.push(item);
      }
    } else {
      undated.push(item);
    }
  }

  if (datedToday.length > 0) {
    return {
      mode: "dated-items-plus-undated-homepage-items",
      items: [...datedToday, ...undated],
      excludedDatedItems: datedOther.length,
      note:
        "Items with a parseable date were filtered to the target day; undated homepage Top Headlines are kept because Arab News often omits dates in listing cards."
    };
  }

  return {
    mode: "current-homepage-top-headlines",
    items,
    excludedDatedItems: datedOther.length,
    note:
      "No parseable item-level dates were found, so the output is the current Top Headlines block from the homepage at fetch time."
  };
}

function markdownList(items) {
  if (items.length === 0) return "_No items captured._";
  return items
    .map((item, index) => {
      const parts = [`${index + 1}. [${item.title}](${item.url})`];
      if (item.section) parts.push(`section: ${item.section}`);
      if (item.datePublished) parts.push(`published: ${item.datePublished}`);
      if (item.archive?.files?.content) parts.push(`archive: ${item.archive.files.content}`);
      return parts.join(" - ");
    })
    .join("\n");
}

async function main() {
  const fetchedAt = new Date().toISOString();
  const targetDate = todayIsoInTimeZone();
  await mkdir(outputDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    proxy: proxyOptions()
  });

  const context = await browser.newContext({
    locale: "en-US",
    timezoneId: timeZone,
    viewport: { width: 1440, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined
    });
  });

  const [videosResult, homeResult] = await Promise.all([
    gotoAndExtract(context, {
      url: SOURCE_URLS.videos,
      mode: "videos",
      limit: videoLimit
    }),
    gotoAndExtract(context, {
      url: SOURCE_URLS.home,
      mode: "home-top-headlines",
      limit: 0
    })
  ]);

  const headlineSelection = selectTodayHeadlines(homeResult.items, targetDate);
  const output = {
    fetchedAt,
    targetDate: {
      iso: targetDate,
      timeZone
    },
    sources: SOURCE_URLS,
    videos: videosResult.items.slice(0, videoLimit),
    headlines: {
      ...headlineSelection,
      sourceUrl: SOURCE_URLS.home
    },
    diagnostics: {
      videos: {
        responseStatus: videosResult.responseStatus,
        responseUrl: videosResult.responseUrl,
        challengeDetected: videosResult.challengeDetected,
        itemCount: videosResult.items.length
      },
      home: {
        responseStatus: homeResult.responseStatus,
        responseUrl: homeResult.responseUrl,
        challengeDetected: homeResult.challengeDetected,
        itemCount: homeResult.items.length
      }
    }
  };

  if (archiveItems && output.videos.length >= videoLimit && output.headlines.items.length > 0) {
    output.archive = await archiveLatestItemsToRepo(context, output);
  } else {
    output.archive = {
      enabled: archiveItems,
      skipped: true,
      reason: archiveItems ? "Primary scrape did not capture all required listing items." : "ARCHIVE_ITEMS disabled."
    };
  }

  await browser.close();

  await writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(
    path.join(outputDir, "latest.md"),
    [
      "# Arab News Latest",
      "",
      `Fetched at: ${fetchedAt}`,
      `Target date: ${targetDate} (${timeZone})`,
      "",
      "## Latest Videos",
      "",
      markdownList(output.videos),
      "",
      "## Homepage Top Headlines",
      "",
      headlineSelection.note,
      "",
      markdownList(output.headlines.items),
      ""
    ].join("\n")
  );

  const failures = [];
  if (videosResult.challengeDetected || homeResult.challengeDetected) {
    failures.push("Arab News returned a Cloudflare challenge page.");
  }
  if (output.videos.length < videoLimit) {
    failures.push(`Expected ${videoLimit} videos, captured ${output.videos.length}.`);
  }
  if (output.headlines.items.length === 0) {
    failures.push("No homepage Top Headlines were captured.");
  }
  if (archiveItems && output.archive?.errorCount > 0) {
    failures.push(`Archive had ${output.archive.errorCount} item errors.`);
  }
  if (archiveItems && output.archive?.challengeCount > 0) {
    failures.push(`Archive had ${output.archive.challengeCount} challenged item pages.`);
  }
  if (saveVideoFiles && output.archive?.results) {
    const missingVideos = output.archive.results.filter((item) => item.group === "videos" && !item.video?.path);
    if (missingVideos.length > 0) {
      failures.push(`Missing downloaded video files for ${missingVideos.length} video item(s).`);
    }
  }

  if (failures.length > 0 && !allowEmpty) {
    console.error(failures.join("\n"));
    console.error(`Debug files were written to ${path.relative(repoRoot, artifactDir)}/.`);
    process.exitCode = 2;
    return;
  }

  console.log(`Wrote ${path.relative(repoRoot, path.join(outputDir, "latest.json"))}`);
  console.log(`Videos: ${output.videos.length}`);
  console.log(`Headlines: ${output.headlines.items.length}`);
  if (output.archive && !output.archive.skipped) {
    console.log(`Archived: ${output.archive.okCount}/${output.archive.itemCount}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
