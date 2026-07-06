import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value) {
  if (!isoDatePattern.test(value)) return null;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatIsoDate(date) {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function isoDateInTimeZone(date = new Date(), timeZone = "UTC") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function cutoffDateForRetention(referenceDateIso, retentionDays) {
  const parsedReferenceDate = parseIsoDate(referenceDateIso);
  if (!parsedReferenceDate) {
    throw new Error(`Invalid retention reference date: ${referenceDateIso}`);
  }

  const parsedRetentionDays = Number(retentionDays);
  if (!Number.isInteger(parsedRetentionDays) || parsedRetentionDays < 1) {
    throw new Error(`RETENTION_DAYS must be a positive integer, got: ${retentionDays}`);
  }

  const cutoffDate = new Date(parsedReferenceDate);
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - parsedRetentionDays + 1);
  return formatIsoDate(cutoffDate);
}

export function shouldPruneDateDirectory(directoryName, options) {
  if (!parseIsoDate(directoryName)) return false;
  const cutoffDate = cutoffDateForRetention(options.referenceDateIso, options.retentionDays);
  return directoryName < cutoffDate;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function toRepoRelative(filePath, rootDirectory) {
  return path.relative(rootDirectory, filePath).split(path.sep).join("/");
}

export async function pruneRetention(options = {}) {
  const timeZone = options.timeZone || process.env.TIME_ZONE || "Asia/Riyadh";
  const retentionDays = Number(options.retentionDays ?? process.env.RETENTION_DAYS ?? 3);
  const referenceDateIso =
    options.referenceDateIso ||
    process.env.RETENTION_REFERENCE_DATE ||
    isoDateInTimeZone(new Date(), timeZone);
  const roots = options.roots || ["rendered-clips"];
  const rootDirectory = path.resolve(options.repoRoot || repoRoot);
  const dryRun = Boolean(options.dryRun);
  const cutoffDateIso = cutoffDateForRetention(referenceDateIso, retentionDays);
  const result = {
    referenceDateIso,
    retentionDays,
    cutoffDateIso,
    pruned: [],
    kept: [],
    skipped: []
  };

  for (const root of roots) {
    const absoluteRoot = path.resolve(rootDirectory, root);
    if (!(await pathExists(absoluteRoot))) {
      result.skipped.push({ path: root, reason: "missing" });
      continue;
    }

    const entries = await readdir(absoluteRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !parseIsoDate(entry.name)) continue;

      const absoluteEntry = path.join(absoluteRoot, entry.name);
      const relativeEntry = toRepoRelative(absoluteEntry, rootDirectory);
      if (shouldPruneDateDirectory(entry.name, { referenceDateIso, retentionDays })) {
        if (!dryRun) {
          await rm(absoluteEntry, { recursive: true, force: true });
        }
        result.pruned.push(relativeEntry);
      } else {
        result.kept.push(relativeEntry);
      }
    }
  }

  result.pruned.sort();
  result.kept.sort();
  return result;
}

function parseCliArgs(argv) {
  return {
    dryRun: argv.includes("--dry-run"),
    roots: (process.env.RETENTION_PATHS || "rendered-clips")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await pruneRetention(options);

  console.log(
    `Retention: keeping ${result.retentionDays} day(s), reference date ${result.referenceDateIso}, cutoff ${result.cutoffDateIso}`
  );
  if (result.pruned.length === 0) {
    console.log("No old generated directories to prune.");
  } else {
    for (const directory of result.pruned) {
      console.log(`${options.dryRun ? "Would prune" : "Pruned"} ${directory}`);
    }
  }
  if (result.kept.length > 0) {
    console.log(`Kept ${result.kept.length} recent generated director${result.kept.length === 1 ? "y" : "ies"}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
