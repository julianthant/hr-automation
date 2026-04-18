// Prune stale .tracker/ JSONL files, .screenshots/ PNG files, and
// .tracker/step-cache/ JSON files.
// Usage:
//   npm run clean:tracker                           # default 7 days — cleans all three
//   npm run clean:tracker -- --days 14              # custom age
//   npm run clean:tracker -- --dir .tracker-test --days 1
//   npm run clean:tracker -- --no-screenshots       # tracker + step-cache only
//   npm run clean:tracker -- --no-step-cache        # tracker + screenshots only
//   npm run clean:tracker -- --screenshots-only     # screenshots only
//   npm run clean:tracker -- --step-cache-only      # step-cache only

import {
  cleanOldTrackerFiles,
  cleanOldScreenshots,
  DEFAULT_DIR,
} from "../tracker/jsonl.js";
import {
  pruneOldStepCache,
  DEFAULT_STEP_CACHE_DIR,
} from "../core/index.js";
import { log } from "../utils/log.js";

export const DEFAULT_SCREENSHOTS_DIR = ".screenshots";

interface Args {
  days: number;
  dir: string;
  screenshotsDir: string;
  stepCacheDir: string;
  cleanTracker: boolean;
  cleanScreenshots: boolean;
  cleanStepCache: boolean;
}

function parseArgs(argv: string[]): Args {
  let days = 7;
  let dir = DEFAULT_DIR;
  let screenshotsDir = DEFAULT_SCREENSHOTS_DIR;
  let stepCacheDir = DEFAULT_STEP_CACHE_DIR;
  let cleanTracker = true;
  let cleanScreenshots = true;
  let cleanStepCache = true;
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
    } else if (a === "--step-cache-dir") {
      const next = argv[++i];
      if (!next) {
        log.error("--step-cache-dir requires a directory path");
        process.exit(1);
      }
      stepCacheDir = next;
    } else if (a === "--no-screenshots") {
      cleanScreenshots = false;
    } else if (a === "--no-step-cache") {
      cleanStepCache = false;
    } else if (a === "--screenshots-only") {
      cleanTracker = false;
      cleanScreenshots = true;
      cleanStepCache = false;
    } else if (a === "--step-cache-only") {
      cleanTracker = false;
      cleanScreenshots = false;
      cleanStepCache = true;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: clean-tracker [--days N] [--dir path] [--screenshots-dir path] [--step-cache-dir path]\n" +
          "                    [--no-screenshots | --no-step-cache | --screenshots-only | --step-cache-only]\n" +
          "  --days N               delete entries older than N days (default: 7)\n" +
          "  --dir P                tracker directory to scan (default: .tracker)\n" +
          "  --screenshots-dir P    screenshots directory to scan (default: .screenshots)\n" +
          "  --step-cache-dir P     step-cache directory to scan (default: .tracker/step-cache)\n" +
          "  --no-screenshots       skip screenshot prune\n" +
          "  --no-step-cache        skip step-cache prune\n" +
          "  --screenshots-only     only prune screenshots\n" +
          "  --step-cache-only      only prune step-cache"
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
    stepCacheDir,
    cleanTracker,
    cleanScreenshots,
    cleanStepCache,
  };
}

export function cleanTrackerMain(argv: string[] = process.argv.slice(2)): {
  trackerDeleted: number;
  screenshotsDeleted: number;
  stepCacheDeleted: number;
} {
  const {
    days,
    dir,
    screenshotsDir,
    stepCacheDir,
    cleanTracker,
    cleanScreenshots,
    cleanStepCache,
  } = parseArgs(argv);
  let trackerDeleted = 0;
  let screenshotsDeleted = 0;
  let stepCacheDeleted = 0;
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
  if (cleanStepCache) {
    stepCacheDeleted = pruneOldStepCache(days * 24, stepCacheDir);
    log.success(
      `Deleted ${stepCacheDeleted} stale step-cache file${stepCacheDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${stepCacheDir}`
    );
  }
  return { trackerDeleted, screenshotsDeleted, stepCacheDeleted };
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
