#!/usr/bin/env node

import { chromium } from "playwright";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dateMatchesTargetDay,
  dedupeItemsByUrl,
  extractArabNewsDocument,
  isCloudflareChallengeText,
  isLikelyArabNewsArticleUrl,
  normalizeUrl,
  normalizeWhitespace
} from "./extractors.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const SOURCE_URLS = {
  videos: "https://www.arabnews.com/videos",
  home: "https://www.arabnews.com/"
};

const DEFAULT_RECENT24H_LISTING_URLS = [
  SOURCE_URLS.home,
  SOURCE_URLS.videos,
  "https://www.arabnews.com/saudiarabia",
  "https://www.arabnews.com/middleeast",
  "https://www.arabnews.com/world",
  "https://www.arabnews.com/economy",
  "https://www.arabnews.com/sport",
  "https://www.arabnews.com/lifestyle",
  "https://www.arabnews.com/main-category/media",
  "https://www.arabnews.com/opinion"
];

const DEFAULT_RECENT24H_FEED_URLS = [
  "https://www.arabnews.com/rss.xml",
  "https://www.arabnews.com/googlenews.xml",
  "https://www.arabnews.com/cat/1/rss.xml",
  "https://www.arabnews.com/cat/2/rss.xml",
  "https://www.arabnews.com/cat/3/rss.xml",
  "https://www.arabnews.com/cat/4/rss.xml",
  "https://www.arabnews.com/cat/5/rss.xml",
  "https://www.arabnews.com/cat/8/rss.xml",
  "https://www.arabnews.com/cat/2096/rss.xml"
];

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
const recent24hEnabled = process.env.RECENT24H_ENABLED !== "0" && process.env.RECENT24H_ENABLED !== "false";
const recent24hRequireItems =
  process.env.RECENT24H_REQUIRE_ITEMS === "1" || process.env.RECENT24H_REQUIRE_ITEMS === "true";
const recent24hHours = Number(process.env.RECENT24H_HOURS || 24);
const recent24hCandidateLimit = Number(process.env.RECENT24H_CANDIDATE_LIMIT || 220);
const recent24hListingPages = Number(process.env.RECENT24H_LISTING_PAGES || 2);
const recent24hRequestDelayMs = Number(process.env.RECENT24H_REQUEST_DELAY_MS || 250);
const recent24hFutureLeewayMs = Number(process.env.RECENT24H_FUTURE_LEEWAY_MINUTES || 15) * 60_000;
const recent24hListingSourceUrls = expandListingSourceUrls(
  envList("RECENT24H_LISTING_URLS", DEFAULT_RECENT24H_LISTING_URLS),
  recent24hListingPages
);
const recent24hFeedSourceUrls = envList("RECENT24H_FEED_URLS", DEFAULT_RECENT24H_FEED_URLS);

function todayIsoInTimeZone(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return [...fallback];
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function expandListingSourceUrls(urls, pageCount) {
  const result = [];
  const maxPages = Math.max(1, pageCount);

  for (const sourceUrl of urls) {
    result.push(sourceUrl);
    for (let pageIndex = 1; pageIndex < maxPages; pageIndex += 1) {
      try {
        const url = new URL(sourceUrl);
        url.searchParams.set("page", String(pageIndex));
        result.push(url.toString());
      } catch {
        // Keep the configured base URL and skip malformed pagination variants.
      }
    }
  }

  return [...new Set(result)];
}

function parseDateValue(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) return null;

  const variants = [
    raw,
    raw.replace(/([+-]\d{2})$/, "$1:00"),
    raw.replace(/([+-]\d{2})$/, "$100")
  ];

  for (const variant of variants) {
    const date = new Date(variant);
    if (!Number.isNaN(date.valueOf())) return date;
  }

  return null;
}

function sectionFromArticleUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "node" && parts[2]) return parts[2].replaceAll("-", " ");
    return parts[0]?.replaceAll("-", " ") || "";
  } catch {
    return "";
  }
}

function cleanArticleSection(section, url, fallback = "") {
  const value = normalizeWhitespace(section);
  if (
    value &&
    value.length <= 40 &&
    !/^(related|update|video|special|graphic)\b/i.test(value) &&
    !/\b(june|jan|feb|mar|apr|may|jul|aug|sep|oct|nov|dec)\b/i.test(value)
  ) {
    return value;
  }

  return fallback || sectionFromArticleUrl(url);
}

function nodeIdFromUrl(url) {
  const match = String(url || "").match(/\/node\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function jwplayerMediaIdFromUrl(url) {
  const value = String(url || "");
  const match =
    value.match(/\/manifests\/([A-Za-z0-9]+)\.m3u8/i) ||
    value.match(/\/media\/([A-Za-z0-9]+)(?:\/|$)/i) ||
    value.match(/\/videos\/([A-Za-z0-9]+)-[^/]+\.mp4/i);
  return match?.[1] || null;
}

async function expandJwplayerMediaUrls(context, videoUrl) {
  const mediaId = jwplayerMediaIdFromUrl(videoUrl);
  if (!mediaId) return [];

  const response = await context.request.get(`https://content.jwplatform.com/v2/media/${mediaId}`, {
    timeout: Number(process.env.VIDEO_TIMEOUT_MS || 120000)
  });
  if (!response.ok()) {
    throw new Error(`JWPlayer media request failed with ${response.status()}`);
  }

  const media = await response.json();
  const sources = media?.playlist?.flatMap((item) => item.sources || []) || [];
  return sources
    .filter((source) => source?.file)
    .sort((a, b) => Number(b.filesize || b.bitrate || b.height || 0) - Number(a.filesize || a.bitrate || a.height || 0))
    .map((source) => source.file);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const maxBuffer = Number(options.maxBuffer || 0);
    const { maxBuffer: _maxBuffer, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (maxBuffer > 0 && stdout.length > maxBuffer) {
        child.kill("SIGTERM");
        reject(new Error(`${command} stdout exceeded maxBuffer=${maxBuffer}`));
      }
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

async function curlFetch(url, timeoutMs = Number(process.env.CURL_TIMEOUT_MS || 90000)) {
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const { stdout } = await runCommand(
    "curl",
    [
      "-fsSL",
      "--compressed",
      "--max-time",
      String(timeoutSeconds),
      "-A",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      url
    ],
    {
      maxBuffer: Number(process.env.CURL_MAX_BUFFER || 25_000_000)
    }
  );
  return stdout;
}

async function extractFromHtml(context, { url, html, mode, limit }) {
  const page = await context.newPage();

  try {
    await page.route("**/*", (route) => route.abort()).catch(() => {});
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.HTML_PARSE_TIMEOUT_MS || 30000)
    });

    const extracted = await page.evaluate(extractArabNewsDocument, {
      mode,
      limit,
      baseUrl: url
    });
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const title = await page.title().catch(() => "");

    return {
      ...extracted,
      pageUrl: url,
      responseStatus: 200,
      responseUrl: url,
      challengeDetected: extracted.challengeDetected || isCloudflareChallengeText(bodyText, title),
      html
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractWithCurlFallback(context, { url, mode, limit, reason }) {
  if (process.env.CURL_FALLBACK === "0" || process.env.CURL_FALLBACK === "false") return null;

  try {
    const html = await curlFetch(url);
    const extracted = await extractFromHtml(context, { url, html, mode, limit });
    const diagnostics = {
      ...extracted.diagnostics,
      extraction: "curl-html",
      fallbackReason: reason
    };
    const details = {
      url,
      responseUrl: extracted.responseUrl,
      responseStatus: extracted.responseStatus,
      mode,
      challengeDetected: extracted.challengeDetected,
      diagnostics,
      itemCount: extracted.items.length
    };

    if (savePageArtifacts || extracted.challengeDetected || extracted.items.length === 0) {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, `arabnews-${mode}-curl.json`), `${JSON.stringify(details, null, 2)}\n`);
      await writeFile(path.join(artifactDir, `arabnews-${mode}-curl.html`), html);
    }

    return {
      ...extracted,
      diagnostics
    };
  } catch (error) {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, `arabnews-${mode}-curl-error.json`),
      `${JSON.stringify(
        {
          url,
          mode,
          reason,
          error: String(error?.stack || error)
        },
        null,
        2
      )}\n`
    );
    return null;
  }
}

async function parseXmlCandidates(context, { url, xml }) {
  const page = await context.newPage();

  try {
    await page.route("**/*", (route) => route.abort()).catch(() => {});
    await page.setContent("<!doctype html><title>XML parser</title>", {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.HTML_PARSE_TIMEOUT_MS || 30000)
    });

    return await page.evaluate(
      ({ sourceUrl, xmlText }) => {
        function clean(value) {
          return String(value ?? "")
            .replace(/\s+/g, " ")
            .trim();
        }

        function nodeText(root, names) {
          for (const name of names) {
            const element = root.getElementsByTagName(name)[0];
            const text = clean(element?.textContent || "");
            if (text) return text;
          }
          return "";
        }

        function toUrl(value) {
          if (!value) return "";
          try {
            const parsed = new URL(value, sourceUrl);
            parsed.hash = "";
            return parsed.toString();
          } catch {
            return "";
          }
        }

        const doc = new DOMParser().parseFromString(xmlText, "application/xml");
        const parserError = clean(doc.getElementsByTagName("parsererror")[0]?.textContent || "");
        const items = [];

        for (const item of doc.getElementsByTagName("item")) {
          items.push({
            title: nodeText(item, ["title"]),
            url: toUrl(nodeText(item, ["link", "guid"])),
            datePublished: nodeText(item, ["pubDate", "dc:date"]),
            description: nodeText(item, ["description"]),
            source: "rss-feed"
          });
        }

        for (const item of doc.getElementsByTagName("url")) {
          items.push({
            title: nodeText(item, ["news:title", "image:title", "video:title"]),
            url: toUrl(nodeText(item, ["loc"])),
            datePublished: nodeText(item, ["news:publication_date", "lastmod"]),
            description: "",
            source: "xml-urlset"
          });
        }

        return {
          parserError,
          itemCount: items.length,
          items
        };
      },
      { sourceUrl: url, xmlText: xml }
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function collectRecentFeedCandidates(context, sourceUrl) {
  const xml = await curlFetch(sourceUrl, Number(process.env.RECENT24H_SOURCE_TIMEOUT_MS || 45000));
  const parsed = await parseXmlCandidates(context, { url: sourceUrl, xml });
  const items = parsed.items
    .map((item, index) => ({
      ...item,
      url: normalizeUrl(item.url),
      title: normalizeWhitespace(item.title),
      section: sectionFromArticleUrl(item.url),
      sourceUrl,
      order: index
    }))
    .filter((item) => item.title && isLikelyArabNewsArticleUrl(item.url));

  return {
    sourceUrl,
    type: "feed",
    parserError: parsed.parserError,
    itemCount: items.length,
    items
  };
}

async function collectRecentListingCandidates(context, sourceUrl) {
  const html = await curlFetch(sourceUrl, Number(process.env.RECENT24H_SOURCE_TIMEOUT_MS || 45000));
  const extracted = await extractFromHtml(context, {
    url: sourceUrl,
    html,
    mode: "content",
    limit: 0
  });
  const items = extracted.items
    .map((item, index) => ({
      ...item,
      url: normalizeUrl(item.url),
      title: normalizeWhitespace(item.title),
      section: item.section || sectionFromArticleUrl(item.url),
      sourceUrl,
      source: item.source || "listing",
      order: index
    }))
    .filter((item) => item.title && isLikelyArabNewsArticleUrl(item.url));

  return {
    sourceUrl,
    type: "listing",
    responseStatus: extracted.responseStatus,
    challengeDetected: extracted.challengeDetected,
    itemCount: items.length,
    items
  };
}

function mergeRecentCandidates(candidates) {
  const byUrl = new Map();

  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    const title = normalizeWhitespace(candidate.title);
    if (!url || !title || !isLikelyArabNewsArticleUrl(url)) continue;

    const source = {
      source: candidate.source || "unknown",
      sourceUrl: candidate.sourceUrl || "",
      datePublished: candidate.datePublished || null,
      order: candidate.order ?? null
    };
    const existing = byUrl.get(url);

    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.datePublished && candidate.datePublished) existing.datePublished = candidate.datePublished;
      if (!existing.section && candidate.section) existing.section = candidate.section;
      existing.sources.push(source);
      continue;
    }

    byUrl.set(url, {
      title,
      url,
      section: candidate.section || sectionFromArticleUrl(url),
      datePublished: candidate.datePublished || null,
      description: candidate.description || "",
      nodeId: nodeIdFromUrl(url),
      sources: [source]
    });
  }

  return [...byUrl.values()].sort((a, b) => {
    const nodeDiff = b.nodeId - a.nodeId;
    if (nodeDiff !== 0) return nodeDiff;
    return a.title.localeCompare(b.title);
  });
}

async function extractArticleMetadataFromHtml(context, itemUrl, html) {
  const page = await context.newPage();

  try {
    await page.route("**/*", (route) => route.abort()).catch(() => {});
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.HTML_PARSE_TIMEOUT_MS || 30000)
    });
    await page
      .evaluate((url) => {
        window.history.replaceState(null, "", url);
      }, itemUrl)
      .catch(() => {});

    return await page.evaluate(
      ({ baseUrl }) => {
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
            const url = new URL(value, baseUrl);
            url.hash = "";
            return url.toString();
          } catch {
            return "";
          }
        }

        const published =
          attr("meta[property='article:published_time']", "content") ||
          attr("meta[name='pubdate']", "content") ||
          attr("meta[itemprop='datePublished']", "content") ||
          attr("time[datetime]", "datetime");

        const modified =
          attr("meta[property='article:modified_time']", "content") ||
          attr("meta[itemprop='dateModified']", "content");

        const title =
          clean(attr("meta[property='og:title']", "content")) ||
          clean(document.querySelector("h1")?.innerText) ||
          clean(document.title);

        return {
          title,
          description:
            clean(attr("meta[name='description']", "content")) ||
            clean(attr("meta[property='og:description']", "content")),
          image:
            absoluteUrl(attr("meta[property='og:image']", "content")) ||
            absoluteUrl(document.querySelector("article img, main img")?.getAttribute("src")),
          published,
          modified,
          author:
            clean(attr("meta[name='author']", "content")) ||
            clean(document.querySelector("[rel='author'], .author, [class*='author']")?.textContent),
          section: clean(attr("meta[property='article:section']", "content")),
          canonical: absoluteUrl(attr("link[rel='canonical']", "href")) || baseUrl,
          pageTitle: document.title,
          bodyText: clean(document.body?.innerText || "")
        };
      },
      { baseUrl: itemUrl }
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function verifyRecentCandidate(context, candidate, windowStart, windowEnd) {
  const sourceDate = parseDateValue(candidate.datePublished);
  if (sourceDate && sourceDate < windowStart) {
    return {
      status: "skipped",
      reason: "source-date-older-than-window",
      candidate
    };
  }
  if (sourceDate && sourceDate > windowEnd) {
    return {
      status: "skipped",
      reason: "source-date-after-window",
      candidate
    };
  }

  const html = await curlFetch(candidate.url, Number(process.env.RECENT24H_ARTICLE_TIMEOUT_MS || 60000));
  const metadata = await extractArticleMetadataFromHtml(context, candidate.url, html);
  const challengeDetected = isCloudflareChallengeText(metadata.bodyText, metadata.pageTitle);
  if (challengeDetected) {
    return {
      status: "skipped",
      reason: "article-challenge",
      candidate
    };
  }

  const publishedDate = parseDateValue(metadata.published) || sourceDate;
  if (!publishedDate) {
    return {
      status: "skipped",
      reason: "no-published-date",
      candidate,
      metadata
    };
  }
  if (publishedDate < windowStart) {
    return {
      status: "skipped",
      reason: "article-older-than-window",
      candidate,
      metadata
    };
  }
  if (publishedDate > windowEnd) {
    return {
      status: "skipped",
      reason: "article-after-window",
      candidate,
      metadata
    };
  }

  const canonical = normalizeUrl(metadata.canonical);
  const url = isLikelyArabNewsArticleUrl(canonical) ? canonical : candidate.url;

  return {
    status: "ok",
    item: {
      title: normalizeWhitespace(metadata.title || candidate.title),
      url,
      section: cleanArticleSection(metadata.section, url, candidate.section),
      publishedAt: publishedDate.toISOString(),
      publishedRaw: metadata.published || candidate.datePublished || null,
      modifiedAt: parseDateValue(metadata.modified)?.toISOString() || null,
      modifiedRaw: metadata.modified || null,
      description: normalizeWhitespace(metadata.description || candidate.description || ""),
      image: metadata.image || null,
      author: normalizeWhitespace(metadata.author || ""),
      nodeId: nodeIdFromUrl(url),
      candidateUrl: candidate.url,
      sources: candidate.sources
    }
  };
}

function summarizeSkip(counts, reason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

async function collectRecent24h(context, fetchedAt) {
  const fetchedDate = new Date(fetchedAt);
  const windowStart = new Date(fetchedDate.valueOf() - recent24hHours * 60 * 60 * 1000);
  const windowEnd = new Date(fetchedDate.valueOf() + recent24hFutureLeewayMs);
  const diagnostics = {
    enabled: recent24hEnabled,
    hours: recent24hHours,
    candidateLimit: recent24hCandidateLimit,
    listingSources: [],
    feedSources: [],
    sourceErrors: [],
    skipped: {},
    articleErrors: [],
    candidateCountBeforeLimit: 0,
    candidateCountAfterLimit: 0,
    verifiedCount: 0
  };
  const rawCandidates = [];

  for (const sourceUrl of recent24hFeedSourceUrls) {
    try {
      const result = await collectRecentFeedCandidates(context, sourceUrl);
      diagnostics.feedSources.push({
        sourceUrl,
        itemCount: result.itemCount,
        parserError: result.parserError || null
      });
      rawCandidates.push(...result.items);
    } catch (error) {
      diagnostics.sourceErrors.push({
        sourceUrl,
        type: "feed",
        error: String(error?.message || error)
      });
    }
  }

  for (const sourceUrl of recent24hListingSourceUrls) {
    try {
      const result = await collectRecentListingCandidates(context, sourceUrl);
      diagnostics.listingSources.push({
        sourceUrl,
        itemCount: result.itemCount,
        challengeDetected: result.challengeDetected
      });
      if (!result.challengeDetected) rawCandidates.push(...result.items);
    } catch (error) {
      diagnostics.sourceErrors.push({
        sourceUrl,
        type: "listing",
        error: String(error?.message || error)
      });
    }
  }

  diagnostics.candidateCountBeforeLimit = rawCandidates.length;
  const mergedCandidates = mergeRecentCandidates(rawCandidates);
  const candidates = mergedCandidates.slice(0, Math.max(1, recent24hCandidateLimit));
  diagnostics.uniqueCandidateCount = mergedCandidates.length;
  diagnostics.candidateCountAfterLimit = candidates.length;

  const verifiedItems = [];
  for (const candidate of candidates) {
    await sleep(recent24hRequestDelayMs);
    try {
      const result = await verifyRecentCandidate(context, candidate, windowStart, windowEnd);
      if (result.status === "ok") {
        verifiedItems.push(result.item);
        diagnostics.verifiedCount += 1;
      } else {
        summarizeSkip(diagnostics.skipped, result.reason);
      }
    } catch (error) {
      diagnostics.articleErrors.push({
        url: candidate.url,
        title: candidate.title,
        error: String(error?.message || error)
      });
    }
  }

  const items = dedupeItemsByUrl(verifiedItems)
    .map((item) => ({
      ...item,
      section: item.section || sectionFromArticleUrl(item.url),
      nodeId: nodeIdFromUrl(item.url)
    }))
    .sort((a, b) => {
      const timeDiff = new Date(b.publishedAt).valueOf() - new Date(a.publishedAt).valueOf();
      if (timeDiff !== 0) return timeDiff;
      return b.nodeId - a.nodeId;
    });

  return {
    fetchedAt,
    window: {
      hours: recent24hHours,
      start: windowStart.toISOString(),
      end: fetchedDate.toISOString(),
      futureLeewayMinutes: Math.round(recent24hFutureLeewayMs / 60_000)
    },
    itemCount: items.length,
    items,
    diagnostics
  };
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
    method: "ffmpeg-hls",
    ffmpeg
  };
}

async function downloadVideoFile(context, videoUrls, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const errors = [];
  const candidates = [];

  for (const videoUrl of dedupeUrls(videoUrls)) {
    try {
      candidates.push(...(await expandJwplayerMediaUrls(context, videoUrl)));
    } catch (error) {
      errors.push({
        url: videoUrl,
        error: String(error?.message || error)
      });
    }
    candidates.push(videoUrl);
  }

  for (const videoUrl of dedupeUrls(candidates)) {
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

async function writeVideoDownloadDebug(result) {
  const videoResults = result.results?.filter((item) => item.group === "videos") || [];
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, "video-downloads.json"),
    `${JSON.stringify(
      videoResults.map((item) => ({
        title: item.title,
        url: item.url,
        directory: item.directory,
        videoUrls: item.videoUrls,
        video: item.video
      })),
      null,
      2
    )}\n`
  );
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

function extractArticleSnapshot(options = {}) {
  const baseUrl = options.baseUrl || document.location.href;

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
      const url = new URL(value, baseUrl);
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
    canonical: absoluteUrl(attr("link[rel='canonical']", "href")) || baseUrl,
    text,
    textLength: text.length,
    videoUrls,
    pageTitle: document.title,
    bodyText: clean(document.body?.innerText || "")
  };
}

async function extractArticleSnapshotFromHtml(context, itemUrl, html) {
  const extracted = await extractFromHtml(context, {
    url: itemUrl,
    html,
    mode: "article",
    limit: 0
  });

  const page = await context.newPage();
  try {
    await page.route("**/*", (route) => route.abort()).catch(() => {});
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: Number(process.env.HTML_PARSE_TIMEOUT_MS || 30000)
    });
    await page.evaluate((url) => {
      window.history.replaceState(null, "", url);
    }, itemUrl).catch(() => {});
    const snapshot = await page.evaluate(extractArticleSnapshot, {
      baseUrl: itemUrl
    });

    const htmlVideoUrls = dedupeUrls([
      ...[...html.matchAll(/https?:\\?\/\\?\/[^"' <>)]+?(?:\.mp4|\.m3u8)(?:\?[^"' <>)]+)?/gi)].map((match) =>
        match[0].replaceAll("\\/", "/")
      ),
      ...[...html.matchAll(/cdn\.jwplayer\.com\\?\/players\\?\/([A-Za-z0-9]+)-[A-Za-z0-9]+\.js/gi)].map(
        (match) => `https://cdn.jwplayer.com/manifests/${match[1]}.m3u8`
      ),
      ...[...html.matchAll(/cdn\.jwplayer\.com\\?\/v2\\?\/media\\?\/([A-Za-z0-9]+)/gi)].map(
        (match) => `https://cdn.jwplayer.com/manifests/${match[1]}.m3u8`
      ),
      ...[...html.matchAll(/content\.jwplatform\.com\\?\/videos\\?\/([A-Za-z0-9]+)-[^"' <>)]+?\.mp4/gi)].map(
        (match) => `https://cdn.jwplayer.com/manifests/${match[1]}.m3u8`
      )
    ]).filter((url) => isPotentialVideoUrl(url));

    return {
      ...snapshot,
      bodyText: snapshot.bodyText || extracted.items.map((candidate) => candidate.title).join("\n"),
      videoUrls: dedupeUrls([...(snapshot.videoUrls || []), ...htmlVideoUrls])
    };
  } finally {
    await page.close().catch(() => {});
  }
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

    let snapshot = await page.evaluate(extractArticleSnapshot, {
      baseUrl: item.url
    });
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const pageTitle = await page.title().catch(() => "");
    let challengeDetected = isCloudflareChallengeText(bodyText, pageTitle) || response?.status() === 403;
    let candidateVideoUrls = dedupeUrls([
      ...mediaUrls,
      ...(snapshot.videoUrls || [])
    ]).filter((url) => isPotentialVideoUrl(url));

    let articleHtmlFallbackUsed = false;
    if (challengeDetected || (group === "videos" && candidateVideoUrls.length === 0)) {
      try {
        const html = await curlFetch(item.url, Number(process.env.ARTICLE_TIMEOUT_MS || 90000));
        const fallbackSnapshot = await extractArticleSnapshotFromHtml(context, item.url, html);
        const fallbackChallengeDetected = isCloudflareChallengeText(
          fallbackSnapshot.bodyText || fallbackSnapshot.text,
          fallbackSnapshot.pageTitle
        );
        if (!fallbackChallengeDetected && (fallbackSnapshot.title || fallbackSnapshot.text || fallbackSnapshot.videoUrls?.length)) {
          snapshot = fallbackSnapshot;
          challengeDetected = false;
          articleHtmlFallbackUsed = true;
          candidateVideoUrls = dedupeUrls([...(snapshot.videoUrls || [])]).filter((url) => isPotentialVideoUrl(url));
        }
      } catch (error) {
        result.articleHtmlFallbackError = String(error?.message || error);
      }
    }

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
      articleHtmlFallbackUsed,
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

  await writeVideoDownloadDebug(summary);

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
    if (challengeDetected || extracted.items.length === 0 || responseStatus >= 400) {
      const fallback = await extractWithCurlFallback(context, {
        url,
        mode,
        limit,
        reason: challengeDetected ? "playwright-challenge" : `playwright-status-or-empty:${responseStatus}`
      });
      if (fallback && !fallback.challengeDetected && fallback.items.length > 0) {
        return fallback;
      }
    }

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
    const fallback = await extractWithCurlFallback(context, {
      url,
      mode,
      limit,
      reason: "playwright-navigation-error"
    });
    if (fallback && !fallback.challengeDetected && fallback.items.length > 0) {
      return fallback;
    }

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

function recent24hMarkdown(recent) {
  const lines = [
    "# Arab News Recent 24 Hours",
    "",
    `Fetched at: ${recent.fetchedAt}`,
    `Window: ${recent.window.start} to ${recent.window.end} (${recent.window.hours}h)`,
    `Items: ${recent.itemCount}`,
    "",
    "## Items",
    ""
  ];

  if (recent.items.length === 0) {
    lines.push("_No recent items captured._");
  } else {
    for (const [index, item] of recent.items.entries()) {
      const parts = [`${index + 1}. [${item.title}](${item.url})`, `published: ${item.publishedAt}`];
      if (item.section) parts.push(`section: ${item.section}`);
      if (item.author) parts.push(`author: ${item.author}`);
      lines.push(parts.join(" - "));
    }
  }

  lines.push(
    "",
    "## Diagnostics",
    "",
    `Unique candidates: ${recent.diagnostics.uniqueCandidateCount ?? 0}`,
    `Candidates verified: ${recent.diagnostics.verifiedCount}`,
    `Candidates after limit: ${recent.diagnostics.candidateCountAfterLimit}`,
    `Source errors: ${recent.diagnostics.sourceErrors.length}`,
    `Article errors: ${recent.diagnostics.articleErrors.length}`,
    ""
  );

  const skippedEntries = Object.entries(recent.diagnostics.skipped || {});
  if (skippedEntries.length > 0) {
    lines.push("Skipped:", "");
    for (const [reason, count] of skippedEntries) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }

  return lines.join("\n");
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
  let recent24h = {
    fetchedAt,
    window: {
      hours: recent24hHours,
      start: new Date(new Date(fetchedAt).valueOf() - recent24hHours * 60 * 60 * 1000).toISOString(),
      end: fetchedAt,
      futureLeewayMinutes: Math.round(recent24hFutureLeewayMs / 60_000)
    },
    itemCount: 0,
    items: [],
    diagnostics: {
      enabled: false,
      skipped: {},
      sourceErrors: [],
      articleErrors: [],
      verifiedCount: 0,
      candidateCountAfterLimit: 0
    }
  };
  if (recent24hEnabled) {
    recent24h = await collectRecent24h(context, fetchedAt);
  }

  const output = {
    fetchedAt,
    targetDate: {
      iso: targetDate,
      timeZone
    },
    sources: SOURCE_URLS,
    videos: videosResult.items.slice(0, videoLimit),
    recent24hSummary: {
      sourceFile: "data/recent-24h.json",
      itemCount: recent24h.itemCount,
      window: recent24h.window
    },
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
  await writeFile(path.join(outputDir, "recent-24h.json"), `${JSON.stringify(recent24h, null, 2)}\n`);
  await writeFile(path.join(outputDir, "recent-24h.md"), recent24hMarkdown(recent24h));
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
  if (recent24hEnabled && recent24hRequireItems && recent24h.itemCount === 0) {
    failures.push("No Arab News items were captured in the recent 24 hour list.");
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
  console.log(`Wrote ${path.relative(repoRoot, path.join(outputDir, "recent-24h.json"))}`);
  console.log(`Videos: ${output.videos.length}`);
  console.log(`Headlines: ${output.headlines.items.length}`);
  console.log(`Recent 24h: ${recent24h.itemCount}`);
  if (output.archive && !output.archive.skipped) {
    console.log(`Archived: ${output.archive.okCount}/${output.archive.itemCount}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
