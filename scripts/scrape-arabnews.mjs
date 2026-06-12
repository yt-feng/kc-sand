#!/usr/bin/env node

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
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
const timeZone = process.env.TIME_ZONE || "Asia/Riyadh";
const videoLimit = Number(process.env.VIDEO_LIMIT || 3);
const extraWaitMs = Number(process.env.EXTRA_WAIT_MS || 8000);
const allowEmpty = process.env.ALLOW_EMPTY === "1" || process.env.ALLOW_EMPTY === "true";

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

    if (challengeDetected || extracted.items.length === 0 || responseStatus >= 400) {
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

  await browser.close();

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

  if (failures.length > 0 && !allowEmpty) {
    console.error(failures.join("\n"));
    console.error(`Debug files were written to ${path.relative(repoRoot, artifactDir)}/.`);
    process.exitCode = 2;
    return;
  }

  console.log(`Wrote ${path.relative(repoRoot, path.join(outputDir, "latest.json"))}`);
  console.log(`Videos: ${output.videos.length}`);
  console.log(`Headlines: ${output.headlines.items.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
