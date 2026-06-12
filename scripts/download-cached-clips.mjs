#!/usr/bin/env node

import { copyFile, cp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const outputDir = path.resolve(repoRoot, process.env.OUTPUT_DIR || "data");
const artifactDir = path.resolve(repoRoot, process.env.ARTIFACT_DIR || "artifacts");
const archiveDir = path.resolve(repoRoot, process.env.ARCHIVE_DIR || "archive/latest");
const renderedClipsRoot = path.resolve(repoRoot, process.env.RENDERED_CLIPS_ROOT || "rendered-clips");
const timeZone = process.env.TIME_ZONE || "Asia/Riyadh";
const videoLimit = Number(process.env.VIDEO_LIMIT || 3);
const maxVideoBytes = Number(process.env.MAX_VIDEO_BYTES || 95_000_000);
const videoTimeoutMs = Number(process.env.VIDEO_TIMEOUT_MS || 180000);

const cacheDir = path.join(artifactDir, "cache");
const userAgent =
  process.env.VIDEO_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function todayIsoInTimeZone(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function toRelativeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function resolveArchivePath(filePath) {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return filePath;

  const normalized = filePath.replaceAll("\\", "/");
  const archivePrefix = "archive/latest/";
  if (normalized === "archive/latest") return archiveDir;
  if (normalized.startsWith(archivePrefix)) {
    return path.join(archiveDir, normalized.slice(archivePrefix.length));
  }

  return path.join(repoRoot, filePath);
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

function renderedClipName(item, index) {
  const prefix = String(index + 1).padStart(2, "0");
  return `${prefix}_${slugify(item.title)}.mp4`;
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
  const candidates = [process.env.FFMPEG_PATH, "/usr/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"].filter(Boolean);

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

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function restoreCachedArchive() {
  const cachedArchive = path.join(cacheDir, "archive-latest");
  try {
    const info = await stat(cachedArchive);
    if (!info.isDirectory()) return false;
  } catch {
    return false;
  }

  await rm(archiveDir, { recursive: true, force: true });
  await mkdir(path.dirname(archiveDir), { recursive: true });
  await cp(cachedArchive, archiveDir, { recursive: true });
  return true;
}

async function firstJson(paths) {
  for (const filePath of paths.filter(Boolean)) {
    const json = await readJsonIfExists(filePath);
    if (json) return { filePath, json };
  }
  return { filePath: null, json: null };
}

function collectVideoItems(latest, archiveIndex) {
  const archiveResults =
    archiveIndex?.results?.filter((item) => item.group === "videos") ||
    latest?.archive?.results?.filter((item) => item.group === "videos") ||
    [];
  const latestVideos = Array.isArray(latest?.videos) ? latest.videos : [];
  const latestByUrl = new Map(latestVideos.map((item) => [item.url, item]));

  return archiveResults
    .map((item, fallbackIndex) => {
      const index = Number.isInteger(item.index) ? item.index : fallbackIndex;
      const latestItem = latestByUrl.get(item.url) || latestVideos[index] || {};
      const videoUrls = dedupeUrls([...(item.videoUrls || []), ...(item.snapshot?.videoUrls || []), ...(latestItem.videoUrls || [])]);
      return {
        ...latestItem,
        ...item,
        index,
        title: item.title || latestItem.title,
        url: item.url || latestItem.url,
        videoUrls
      };
    })
    .filter((item) => item.title && item.videoUrls.length > 0)
    .slice(0, videoLimit);
}

async function downloadHlsClip(ffmpeg, videoUrl, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await unlink(filePath).catch(() => {});

  const timeoutSeconds = Math.ceil(videoTimeoutMs / 1000);
  await runCommand(ffmpeg, [
    "-y",
    "-nostdin",
    "-loglevel",
    "warning",
    "-rw_timeout",
    String(timeoutSeconds * 1_000_000),
    "-user_agent",
    userAgent,
    "-headers",
    "Referer: https://www.arabnews.com/\r\nOrigin: https://www.arabnews.com\r\n",
    "-i",
    videoUrl,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    filePath
  ]);

  const info = await stat(filePath);
  if (info.size > maxVideoBytes) {
    await unlink(filePath).catch(() => {});
    throw new Error(`Downloaded video is ${info.size} bytes, above MAX_VIDEO_BYTES=${maxVideoBytes}`);
  }

  return {
    path: toRelativeRepoPath(filePath),
    url: videoUrl,
    contentType: "application/vnd.apple.mpegurl",
    bytes: info.size,
    method: "ffmpeg-hls",
    ffmpeg
  };
}

async function downloadOneClip(ffmpeg, item, targetDate) {
  const clipPath = path.join(renderedClipsRoot, targetDate, renderedClipName(item, item.index));
  const errors = [];

  for (const videoUrl of item.videoUrls) {
    try {
      const video = await downloadHlsClip(ffmpeg, videoUrl, clipPath);
      return {
        item,
        video,
        errors
      };
    } catch (error) {
      errors.push({
        url: videoUrl,
        error: String(error?.message || error)
      });
    }
  }

  return {
    item,
    video: null,
    errors
  };
}

function updateLatestWithDownloads(latest, downloads, targetDate) {
  if (!latest || typeof latest !== "object") return;
  latest.cachedClipDownload = {
    updatedAt: new Date().toISOString(),
    targetDate,
    renderedClipsDirectory: toRelativeRepoPath(path.join(renderedClipsRoot, targetDate)),
    note: "Rendered clips were downloaded from video URLs already stored in the repository."
  };

  const byUrl = new Map(downloads.filter((entry) => entry.video?.path).map((entry) => [entry.item.url, entry.video]));

  for (const item of latest.videos || []) {
    const video = byUrl.get(item.url);
    if (!video) continue;
    item.archive ||= {};
    item.archive.files ||= {};
    item.archive.files.video = video.path;
  }

  if (latest.archive?.results) {
    latest.archive.renderedClipsDirectory = toRelativeRepoPath(path.join(renderedClipsRoot, targetDate));
    for (const item of latest.archive.results) {
      if (item.group !== "videos") continue;
      const video = byUrl.get(item.url);
      if (!video) continue;
      item.video = video;
      item.files ||= {};
      item.files.video = video.path;
    }
  }
}

async function updateArchiveWithDownloads(archiveIndex, downloads, targetDate) {
  if (!archiveIndex?.results) return;

  archiveIndex.renderedClipsDirectory = toRelativeRepoPath(path.join(renderedClipsRoot, targetDate));
  const byUrl = new Map(downloads.filter((entry) => entry.video?.path).map((entry) => [entry.item.url, entry.video]));

  for (const item of archiveIndex.results) {
    if (item.group !== "videos") continue;
    const video = byUrl.get(item.url);
    if (!video) continue;
    item.video = video;
    item.files ||= {};
    item.files.video = video.path;

    if (item.files.metadata) {
      const metadataPath = resolveArchivePath(item.files.metadata);
      const metadata = await readJsonIfExists(metadataPath);
      if (metadata) {
        metadata.videoDownload = video;
        metadata.files ||= {};
        metadata.files.video = video.path;
        await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      }
    }
  }

  await writeFile(path.join(archiveDir, "index.json"), `${JSON.stringify(archiveIndex, null, 2)}\n`);
}

async function restoreCachedMarkdown(downloads, targetDate) {
  const cachedMarkdown = path.join(cacheDir, "latest.md");
  const latestMarkdown = path.join(outputDir, "latest.md");
  await copyFile(cachedMarkdown, latestMarkdown).catch(() => {});

  let markdown = "";
  try {
    markdown = await readFile(latestMarkdown, "utf8");
  } catch {
    return;
  }

  const marker = "\n## Downloaded Rendered Clips\n";
  const base = markdown.includes(marker) ? markdown.split(marker)[0].trimEnd() : markdown.trimEnd();
  const lines = downloads
    .filter((entry) => entry.video?.path)
    .map((entry, index) => `${index + 1}. [${entry.item.title}](../${entry.video.path})`);

  await writeFile(
    latestMarkdown,
    [
      base,
      "",
      "## Downloaded Rendered Clips",
      "",
      `Target date: ${targetDate}`,
      "",
      lines.length > 0 ? lines.join("\n") : "_No clips downloaded._",
      ""
    ].join("\n")
  );
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });

  const latestSource = await firstJson([
    process.env.CACHED_LATEST_JSON,
    path.join(cacheDir, "latest.json"),
    path.join(outputDir, "latest.json")
  ]);
  const archiveSource = await firstJson([
    process.env.CACHED_ARCHIVE_INDEX_JSON,
    path.join(cacheDir, "archive-latest", "index.json"),
    path.join(archiveDir, "index.json")
  ]);

  const latest = latestSource.json;
  const archiveIndex = archiveSource.json || latest?.archive || null;
  const targetDate = process.env.TARGET_DATE || latest?.targetDate?.iso || todayIsoInTimeZone();
  const items = collectVideoItems(latest, archiveIndex);

  if (items.length < videoLimit) {
    throw new Error(`Expected ${videoLimit} cached video item(s), found ${items.length}.`);
  }

  const ffmpeg = await findFfmpegExecutable();
  const restoredCachedArchive = await restoreCachedArchive();
  const downloads = [];
  for (const item of items) {
    downloads.push(await downloadOneClip(ffmpeg, item, targetDate));
  }

  const missing = downloads.filter((entry) => !entry.video?.path);
  const debug = {
    updatedAt: new Date().toISOString(),
    latestSource: latestSource.filePath ? toRelativeRepoPath(latestSource.filePath) : null,
    archiveSource: archiveSource.filePath ? toRelativeRepoPath(archiveSource.filePath) : null,
    restoredCachedArchive,
    targetDate,
    renderedClipsDirectory: toRelativeRepoPath(path.join(renderedClipsRoot, targetDate)),
    downloads
  };
  await writeFile(path.join(artifactDir, "cached-video-downloads.json"), `${JSON.stringify(debug, null, 2)}\n`);

  if (missing.length > 0) {
    throw new Error(`Missing downloaded video files for ${missing.length} cached video item(s).`);
  }

  updateLatestWithDownloads(latest, downloads, targetDate);
  await writeFile(path.join(outputDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);
  await updateArchiveWithDownloads(archiveIndex, downloads, targetDate);
  await restoreCachedMarkdown(downloads, targetDate);

  console.log(`Downloaded cached clips to ${debug.renderedClipsDirectory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
