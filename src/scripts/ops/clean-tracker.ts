// Prune stale .tracker/ JSONL files and runtime screenshot PNG files.
// Usage:
//   npm run clean:tracker                           # default 30 days — cleans both
//   npm run clean:tracker -- --days 14              # custom age
//   npm run clean:tracker -- --dir generated/.tests/tracker --days 1
//   npm run clean:tracker -- --no-screenshots       # tracker only
//   npm run clean:tracker -- --screenshots-only     # screenshots only

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";

import {
  cleanOldTrackerFiles,
  cleanOldSessionFiles,
  cleanOldDaemonLogs,
  cleanOldScreenshots,
  dateLocal,
  DEFAULT_DIR,
  readJsonlStream,
} from "../../tracker/jsonl.js";
import { rowsDir, parseWorkflowDateFilename } from "../../tracker/paths.js";
import { pruneStateDb } from "../../tracker/state/cleanup.js";
import { PATHS } from "../../config.js";
import { log } from "../../utils/log.js";
import { isMainModule } from "../main-module.js";

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
export async function sweepOrphanUploadDirs(dir: string): Promise<number> {
  const uploadsRoot = join(dir, "uploads");
  if (!existsSync(uploadsRoot)) return 0;
  let removed = 0;
  let knownRunIds: Set<string>;
  try {
    knownRunIds = await readPrepRunIds(dir);
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
async function readPrepRunIds(dir: string): Promise<Set<string>> {
  const runIds = new Set<string>();
  const rows = rowsDir(dir);
  if (!existsSync(rows)) return runIds;
  let files: string[];
  try {
    files = readdirSync(rows).filter(
      (f) =>
        (f.startsWith("emergency-contact-") || f.startsWith("oath-signature-")) &&
        parseWorkflowDateFilename(f) !== null,
    );
  } catch {
    return runIds;
  }
  for (const file of files) {
    try {
      for await (const entry of readJsonlStream<{
        runId?: string;
        data?: { mode?: string };
      }>(join(rows, file))) {
        if (entry.data?.mode === "prepare" && entry.runId) {
          runIds.add(entry.runId);
        }
      }
    } catch {
      continue;
    }
  }
  return runIds;
}

export const DEFAULT_SCREENSHOTS_DIR = PATHS.screenshotDir;

interface Args {
  days: number;
  dir: string;
  screenshotsDir: string;
  cleanTracker: boolean;
  cleanScreenshots: boolean;
}

function parseArgs(argv: string[]): Args {
  let parsedArgs: ReturnType<typeof parseNodeArgs>;
  try {
    parsedArgs = parseNodeArgs({
      args: argv,
      options: {
        days: { type: "string" },
        dir: { type: "string" },
        "screenshots-dir": { type: "string" },
        "no-screenshots": { type: "boolean", default: false },
        "screenshots-only": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { values } = parsedArgs;
  if (values.help) {
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
  }
  const rawDays = typeof values.days === "string" ? values.days : undefined;
  const days = rawDays === undefined ? 30 : Number.parseInt(rawDays, 10);
  if (!Number.isFinite(days) || days < 0) {
    log.error(`--days requires a non-negative integer, got: ${rawDays}`);
    process.exit(1);
  }
  const screenshotsOnly = values["screenshots-only"] === true;
  return {
    days,
    dir: typeof values.dir === "string" ? values.dir : DEFAULT_DIR,
    screenshotsDir: typeof values["screenshots-dir"] === "string" ? values["screenshots-dir"] : DEFAULT_SCREENSHOTS_DIR,
    cleanTracker: !screenshotsOnly,
    cleanScreenshots: screenshotsOnly || values["no-screenshots"] !== true,
  };
}

export async function cleanTrackerMain(argv: string[] = process.argv.slice(2)): Promise<{
  trackerDeleted: number;
  screenshotsDeleted: number;
  sessionsDeleted: number;
  sqlRowsDeleted: number;
}> {
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
  let sessionsDeleted = 0;
  let sqlRowsDeleted = 0;
  if (cleanTracker) {
    trackerDeleted = cleanOldTrackerFiles(days, dir);
    log.success(
      `Deleted ${trackerDeleted} stale tracker file${trackerDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`
    );
    sessionsDeleted = cleanOldSessionFiles(days, dir);
    if (sessionsDeleted > 0) {
      log.success(
        `Deleted ${sessionsDeleted} stale sessions file${sessionsDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`,
      );
    }
    // Daemon process logs (`daemons/<workflow>-<ISO>.log`) accumulate one file
    // per daemon launch and are not date-rotated — prune them by mtime here.
    const daemonLogsDeleted = cleanOldDaemonLogs(days, dir);
    if (daemonLogsDeleted > 0) {
      log.success(
        `Deleted ${daemonLogsDeleted} stale daemon log${daemonLogsDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}/daemons`,
      );
    }
    // Prune SQLite projection rows in lockstep with JSONL pruning. Use the
    // shared local-date helper so the cutoff matches `cleanOldTrackerFiles`
    // and `cleanOldSessionFiles` (both `dateLocal`-based since 2026-04-27).
    // `.toISOString().slice(0, 10)` would diverge by a day in timezones
    // west of UTC after local 5pm and prune one extra day's projection rows.
    const cutoffDate = dateLocal(new Date(Date.now() - days * 24 * 3600 * 1000));
    const sqlPrune = pruneStateDb(dir, cutoffDate);
    sqlRowsDeleted =
      sqlPrune.runEventsDeleted +
      sqlPrune.runsDeleted +
      sqlPrune.itemsDeleted +
      sqlPrune.logsDeleted +
      sqlPrune.sessionEventsDeleted +
      sqlPrune.filesDeleted +
      sqlPrune.taskAttemptsDeleted +
      sqlPrune.workerCommandsDeleted;
    if (sqlRowsDeleted > 0) {
      log.success(
        `Deleted ${sqlRowsDeleted} SQLite row${sqlRowsDeleted === 1 ? "" : "s"} ` +
          `(run_events=${sqlPrune.runEventsDeleted} runs=${sqlPrune.runsDeleted} ` +
          `items=${sqlPrune.itemsDeleted} logs=${sqlPrune.logsDeleted} ` +
          `session_events=${sqlPrune.sessionEventsDeleted} files=${sqlPrune.filesDeleted} ` +
          `task_attempts=${sqlPrune.taskAttemptsDeleted} worker_commands=${sqlPrune.workerCommandsDeleted}) ` +
          `older than ${days} day${days === 1 ? "" : "s"}`,
      );
    }
    // Orphan upload-dir sweep runs alongside the tracker prune — same
    // working-directory assumption, same target.
    const uploadsRemoved = await sweepOrphanUploadDirs(dir);
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
  return { trackerDeleted, screenshotsDeleted, sessionsDeleted, sqlRowsDeleted };
}

// Only run when invoked directly (not when imported by tests)
if (isMainModule(import.meta.url)) {
  cleanTrackerMain()
    .then(() => process.exit(0))
    .catch((err) => {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
