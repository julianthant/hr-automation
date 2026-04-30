// Prune stale .tracker/ JSONL files and .screenshots/ PNG files.
// Usage:
//   npm run clean:tracker                           # default 30 days — cleans both
//   npm run clean:tracker -- --days 14              # custom age
//   npm run clean:tracker -- --dir .tracker-test --days 1
//   npm run clean:tracker -- --no-screenshots       # tracker only
//   npm run clean:tracker -- --screenshots-only     # screenshots only

import { existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanOldTrackerFiles,
  cleanOldScreenshots,
  DEFAULT_DIR,
} from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";

/**
 * Sweep `.tracker/uploads/` for parentRunId-named subdirectories that
 * are not referenced by any prep row in the tracker JSONL files. Returns
 * the count removed.
 *
 * A "live" parentRunId is any runId appearing on a `data.mode === "prepare"`
 * tracker entry across emergency-contact and oath-signature workflows. Anything
 * else under `uploads/` is orphan disk debris (e.g. crashed runs that never
 * recorded a tracker row, or debris from a prior schema). Removed
 * recursively.
 *
 * Errors during enumeration / deletion are logged at warn and don't
 * throw — startup must never fail because of disk hygiene.
 */
export function sweepOrphanUploadDirs(dir: string): number {
  const uploadsRoot = join(dir, "uploads");
  if (!existsSync(uploadsRoot)) return 0;
  let removed = 0;
  let knownRunIds: Set<string>;
  try {
    knownRunIds = readPrepRunIds(dir);
  } catch (err) {
    log.warn(
      `sweepOrphanUploadDirs: failed to read prep tracker rows: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
  let entries: string[];
  try {
    entries = readdirSync(uploadsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (knownRunIds.has(name)) continue;
    try {
      rmSync(join(uploadsRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      log.warn(
        `sweepOrphanUploadDirs: failed to remove ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return removed;
}

/**
 * Read every `runId` that appears on a `data.mode === "prepare"` tracker
 * entry across the two prep-using workflows. Used by the orphan-upload
 * sweep to decide which `.tracker/uploads/<runId>/` dirs are still live.
 */
function readPrepRunIds(dir: string): Set<string> {
  const runIds = new Set<string>();
  if (!existsSync(dir)) return runIds;
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (f) =>
        (f.startsWith("emergency-contact-") || f.startsWith("oath-signature-")) &&
        f.endsWith(".jsonl") &&
        !f.endsWith("-logs.jsonl"),
    );
  } catch {
    return runIds;
  }
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          runId?: string;
          data?: { mode?: string };
        };
        if (entry.data?.mode === "prepare" && entry.runId) {
          runIds.add(entry.runId);
        }
      } catch {
        continue;
      }
    }
  }
  return runIds;
}

export const DEFAULT_SCREENSHOTS_DIR = ".screenshots";

interface Args {
  days: number;
  dir: string;
  screenshotsDir: string;
  cleanTracker: boolean;
  cleanScreenshots: boolean;
}

function parseArgs(argv: string[]): Args {
  let days = 30;
  let dir = DEFAULT_DIR;
  let screenshotsDir = DEFAULT_SCREENSHOTS_DIR;
  let cleanTracker = true;
  let cleanScreenshots = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") {
      const next = argv[++i];
      const parsed = Number.parseInt(next ?? "", 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        log.error(`--days requires a non-negative integer, got: ${next}`);
        process.exit(1);
      }
      days = parsed;
    } else if (a === "--dir") {
      const next = argv[++i];
      if (!next) {
        log.error("--dir requires a directory path");
        process.exit(1);
      }
      dir = next;
    } else if (a === "--screenshots-dir") {
      const next = argv[++i];
      if (!next) {
        log.error("--screenshots-dir requires a directory path");
        process.exit(1);
      }
      screenshotsDir = next;
    } else if (a === "--no-screenshots") {
      cleanScreenshots = false;
    } else if (a === "--screenshots-only") {
      cleanTracker = false;
      cleanScreenshots = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: clean-tracker [--days N] [--dir path] [--screenshots-dir path]\n" +
          "                    [--no-screenshots | --screenshots-only]\n" +
          "  --days N               delete entries older than N days (default: 30)\n" +
          "  --dir P                tracker directory to scan (default: .tracker)\n" +
          "  --screenshots-dir P    screenshots directory to scan (default: .screenshots)\n" +
          "  --no-screenshots       skip screenshot prune\n" +
          "  --screenshots-only     only prune screenshots"
      );
      process.exit(0);
    } else if (a) {
      log.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return {
    days,
    dir,
    screenshotsDir,
    cleanTracker,
    cleanScreenshots,
  };
}

export function cleanTrackerMain(argv: string[] = process.argv.slice(2)): {
  trackerDeleted: number;
  screenshotsDeleted: number;
} {
  const {
    days,
    dir,
    screenshotsDir,
    cleanTracker,
    cleanScreenshots,
  } = parseArgs(argv);
  if (!cleanTracker && !cleanScreenshots) {
    log.error("No prune targets selected — --no-screenshots with a tracker-skipping combo disabled every target. Nothing to do.");
    process.exit(1);
  }
  let trackerDeleted = 0;
  let screenshotsDeleted = 0;
  let uploadsRemoved = 0;
  if (cleanTracker) {
    trackerDeleted = cleanOldTrackerFiles(days, dir);
    log.success(
      `Deleted ${trackerDeleted} stale tracker file${trackerDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`
    );
    // Orphan upload-dir sweep runs alongside the tracker prune — same
    // working-directory assumption, same target.
    uploadsRemoved = sweepOrphanUploadDirs(dir);
    if (uploadsRemoved > 0) {
      log.success(
        `Removed ${uploadsRemoved} orphan upload dir${uploadsRemoved === 1 ? "" : "s"} from ${dir}/uploads`
      );
    }
  }
  if (cleanScreenshots) {
    screenshotsDeleted = cleanOldScreenshots(days, screenshotsDir);
    log.success(
      `Deleted ${screenshotsDeleted} stale screenshot${screenshotsDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${screenshotsDir}`
    );
  }
  return { trackerDeleted, screenshotsDeleted };
}

// Only run when invoked directly (not when imported by tests)
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("clean-tracker.ts") ||
  process.argv[1]?.endsWith("clean-tracker.js");

if (isMainModule) {
  cleanTrackerMain();
  process.exit(0);
}
