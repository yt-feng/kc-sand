import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cutoffDateForRetention,
  isoDateInTimeZone,
  pruneRetention,
  shouldPruneDateDirectory
} from "../scripts/prune-retention.mjs";

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("calculates the inclusive retention cutoff", () => {
  assert.equal(cutoffDateForRetention("2026-07-06", 3), "2026-07-04");
  assert.equal(shouldPruneDateDirectory("2026-07-03", { referenceDateIso: "2026-07-06", retentionDays: 3 }), true);
  assert.equal(shouldPruneDateDirectory("2026-07-04", { referenceDateIso: "2026-07-06", retentionDays: 3 }), false);
  assert.equal(shouldPruneDateDirectory("not-a-date", { referenceDateIso: "2026-07-06", retentionDays: 3 }), false);
});

test("formats dates in the configured timezone", () => {
  assert.equal(isoDateInTimeZone(new Date("2026-07-05T21:30:00Z"), "Asia/Riyadh"), "2026-07-06");
});

test("prunes dated generated directories older than the retention window", async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "kc-sand-retention-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));

  const clipsRoot = path.join(repoRoot, "rendered-clips");
  await mkdir(path.join(clipsRoot, "2026-07-03"), { recursive: true });
  await mkdir(path.join(clipsRoot, "2026-07-04"), { recursive: true });
  await mkdir(path.join(clipsRoot, "misc"), { recursive: true });

  const result = await pruneRetention({
    repoRoot,
    roots: ["rendered-clips"],
    retentionDays: 3,
    referenceDateIso: "2026-07-06"
  });

  assert.deepEqual(result.pruned, ["rendered-clips/2026-07-03"]);
  assert.equal(await exists(path.join(clipsRoot, "2026-07-03")), false);
  assert.equal(await exists(path.join(clipsRoot, "2026-07-04")), true);
  assert.equal(await exists(path.join(clipsRoot, "misc")), true);
});
