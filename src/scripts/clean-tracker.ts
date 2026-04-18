// Prune stale .tracker/ JSONL files.
// Usage:
//   npm run clean:tracker                 # default 7 days
//   npm run clean:tracker -- --days 14    # custom age
//   npm run clean:tracker -- --dir .tracker-test --days 1

import { cleanOldTrackerFiles, DEFAULT_DIR } from "../tracker/jsonl.js";
import { log } from "../utils/log.js";

function parseArgs(argv: string[]): { days: number; dir: string } {
  let days = 7;
  let dir = DEFAULT_DIR;
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
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: clean-tracker [--days N] [--dir path]\n" +
          "  --days N   delete JSONL files older than N days (default: 7)\n" +
          "  --dir P    tracker directory to scan (default: .tracker)"
      );
      process.exit(0);
    } else if (a) {
      log.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { days, dir };
}

export function cleanTrackerMain(argv: string[] = process.argv.slice(2)): number {
  const { days, dir } = parseArgs(argv);
  const deleted = cleanOldTrackerFiles(days, dir);
  log.success(
    `Deleted ${deleted} stale tracker file${deleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`
  );
  return deleted;
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
