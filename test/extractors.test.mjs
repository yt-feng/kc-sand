import test from "node:test";
import assert from "node:assert/strict";
import {
  dateMatchesTargetDay,
  dedupeItemsByUrl,
  isCloudflareChallengeText,
  isLikelyArabNewsArticleUrl,
  normalizeUrl
} from "../scripts/extractors.mjs";

test("normalizes Arab News URLs and strips tracking noise", () => {
  assert.equal(
    normalizeUrl("/node/123/media?utm_source=x#comments", "https://www.arabnews.com/videos"),
    "https://www.arabnews.com/node/123/media"
  );
});

test("accepts article-like Arab News URLs and rejects listing or utility URLs", () => {
  assert.equal(isLikelyArabNewsArticleUrl("https://www.arabnews.com/node/123/media"), true);
  assert.equal(isLikelyArabNewsArticleUrl("https://www.arabnews.com/middle-east/example-story"), false);
  assert.equal(isLikelyArabNewsArticleUrl("https://www.arabnews.com/videos"), false);
  assert.equal(isLikelyArabNewsArticleUrl("https://www.arabnews.com/search/site/foo"), false);
});

test("dedupes items by normalized URL", () => {
  const items = dedupeItemsByUrl([
    { title: "One", url: "https://www.arabnews.com/node/123/media?utm_source=x" },
    { title: "Duplicate", url: "https://www.arabnews.com/node/123/media" },
    { title: "Two", url: "https://www.arabnews.com/node/456/media" }
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, "One");
});

test("detects Cloudflare challenge text", () => {
  assert.equal(isCloudflareChallengeText("Please enable JavaScript and cookies", "Just a moment..."), true);
  assert.equal(isCloudflareChallengeText("Arab News latest headlines", "Arab News"), false);
});

test("compares dates in a target timezone", () => {
  assert.equal(dateMatchesTargetDay("2026-06-11T22:00:00Z", "2026-06-12", "Asia/Riyadh"), true);
  assert.equal(dateMatchesTargetDay("2026-06-11T20:00:00Z", "2026-06-12", "Asia/Riyadh"), false);
});
