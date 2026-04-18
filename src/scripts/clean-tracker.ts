// Prune stale .tracker/ JSONL files and .screenshots/ PNG files.
// Usage:
//   npm run clean:tracker                      # default 7 days — cleans both
//   npm run clean:tracker -- --days 14         # custom age
//   npm run clean:tracker -- --dir .tracker-test --days 1
//   npm run clean:tracker -- --no-screenshots  # tracker only
//   npm run clean:tracker -- --screenshots-only  # screenshots only

import {
  cleanOldTrackerFiles,
  cleanOldScreenshots,
  DEFAULT_DIR,
} from "../tracker/jsonl.js";
import { log } from "../utils/log.js";

export const DEFAULT_SCREENSHOTS_DIR = ".screenshots";

interface Args {
  days: number;
  dir: string;
  screenshotsDir: string;
  cleanTracker: boolean;
  cleanScreenshots: boolean;
}

function parseArgs(argv: string[]): Args {
  let days = 7;
  let dir = DEFAULT_DIR;
  let screenshotsDir = DEFAULT_SCREENSHOTS_DIR;
  let cleanTracker = true;
  let cleanScreenshots = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") {
      const next = argv[++i];
      const parsed = Number.parseInt(next ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        log.error(`--days requires a positive integer, got: ${next}`);
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
        "Usage: clean-tracker [--days N] [--dir path] [--screenshots-dir path] [--no-screenshots | --screenshots-only]\n" +
          "  --days N              delete entries older than N days (default: 7)\n" +
          "  --dir P               tracker directory to scan (default: .tracker)\n" +
          "  --screenshots-dir P   screenshots directory to scan (default: .screenshots)\n" +
          "  --no-screenshots      clean tracker JSONL only\n" +
          "  --screenshots-only    clean screenshots only"
      );
      process.exit(0);
    } else if (a) {
      log.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { days, dir, screenshotsDir, cleanTracker, cleanScreenshots };
}

export function cleanTrackerMain(argv: string[] = process.argv.slice(2)): {
  trackerDeleted: number;
  screenshotsDeleted: number;
} {
  const { days, dir, screenshotsDir, cleanTracker, cleanScreenshots } = parseArgs(argv);
  let trackerDeleted = 0;
  let screenshotsDeleted = 0;
  if (cleanTracker) {
    trackerDeleted = cleanOldTrackerFiles(days, dir);
    log.success(
      `Deleted ${trackerDeleted} stale tracker file${trackerDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`
    );
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
