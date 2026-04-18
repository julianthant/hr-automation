import { readFile } from "fs/promises";
import { mkdirSync, existsSync, rmSync } from "fs";
import { parse } from "yaml";
import { Mutex } from "async-mutex";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { runWorkflowBatch } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { launchBrowser } from "../../browser/launch.js";
import { computeTileLayout } from "../../browser/tiling.js";
import { createLockedTracker } from "../../tracker/locked.js";
import {
  kronosReportsWorkflow,
  setKronosRuntime,
  clearKronosRuntime,
  type KronosItem,
} from "./workflow.js";
import {
  BATCH_FILE,
  SESSION_DIR,
  REPORTS_DIR,
  DEFAULT_START_DATE,
  DEFAULT_END_DATE,
} from "./config.js";
import {
  updateKronosTracker as updateTracker,
  TRACKER_PATH,
  type KronosTrackerRow,
} from "./tracker.js";

/**
 * Load employee IDs from the batch YAML file.
 */
export async function loadBatchFile(): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(BATCH_FILE, "utf-8");
  } catch {
    throw new Error(`Batch file not found: ${BATCH_FILE}`);
  }

  const ids = parse(content) as unknown;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`Batch file is empty or invalid: ${BATCH_FILE}`);
  }

  for (const entry of ids) {
    const id = String(entry);
    if (!/^\d{5,}$/.test(id)) {
      throw new Error(`Invalid employee ID in batch file: ${String(entry)}`);
    }
  }

  return ids.map(String);
}

/**
 * CLI adapter for `npm run kronos`. Thin shim over `runWorkflowBatch`
 * (pool mode). Owns the pre-kernel phases:
 *
 *   1. Load + validate batch YAML.
 *   2. Dry-run short-circuit: log planned employee list + workers + date range,
 *      exit 0 without launching any browsers.
 *   3. Ensure reports dir exists.
 *   4. Initialize module-scoped runtime (tracker mutex, report-lock mutex,
 *      date range, reports dir) so the kernel handler can read them.
 *   5. Build a per-worker `launchFn` that picks a unique `ukg_session_workerN`
 *      sessionDir per worker — UKG uses Playwright's persistent-context mode,
 *      so two workers sharing one sessionDir would collide on the lock.
 *   6. Delegate to `runWorkflowBatch(kronosReportsWorkflow, items, { poolSize,
 *      launchFn, onPreEmitPending, deriveItemId })`.
 *   7. Clean up per-worker session dirs after the batch resolves.
 */
export async function runParallelKronos(
  workerCount: number,
  options: { dryRun?: boolean; startDate?: string; endDate?: string } = {},
): Promise<void> {
  const employeeIds = await loadBatchFile();
  log.step(`Loaded ${employeeIds.length} employee ID(s) from batch file`);

  const startDate = options.startDate ?? DEFAULT_START_DATE;
  const endDate = options.endDate ?? DEFAULT_END_DATE;

  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    log.step(`Would process ${employeeIds.length} employees with ${workerCount} workers`);
    log.step(`Date range: ${startDate} - ${endDate}`);
    for (const id of employeeIds) {
      log.step(`  Employee: ${id}`);
    }
    log.success("Dry run complete — no reports downloaded");
    return;
  }

  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  const items: KronosItem[] = employeeIds.map((id) => ({ employeeId: id }));
  const actualWorkers = Math.min(workerCount, employeeIds.length);
  log.step(`Starting ${actualWorkers} parallel worker(s)`);

  // Initialize module-scoped runtime so the kernel handler can read mutexes,
  // date range, and tracker writer. Cleared in the finally block so a later
  // import can't read stale state.
  const trackerMutex = new Mutex();
  const reportMutex = new Mutex();
  const lockedTracker = createLockedTracker<KronosTrackerRow>(trackerMutex, updateTracker);
  const writeTracker = (row: KronosTrackerRow): Promise<void> =>
    lockedTracker(TRACKER_PATH, row);

  setKronosRuntime({
    trackerMutex,
    reportMutex,
    startDate,
    endDate,
    reportsDir: REPORTS_DIR,
    writeTracker,
  });

  // Per-worker sessionDir assignment: the kernel's pool mode calls launchFn
  // once per worker. We track a counter so the N-th invocation picks
  // `${SESSION_DIR}_workerN`. Workers are launched in the order 1..N during
  // Session.launch; in a pool-mode run there's exactly one system ("old-kronos")
  // so each launchFn call corresponds to a distinct worker.
  const sessionDirs: string[] = [];
  let workerCounter = 0;
  const launchFn: NonNullable<Parameters<typeof runWorkflowBatch<KronosItem, typeof kronosReportsWorkflow.config.steps>>[2]>["launchFn"] =
    async ({ system: _system, tileIndex: _tileIndex, tileCount: _tileCount, tiling: _tiling }) => {
      workerCounter += 1;
      const workerId = workerCounter;
      const prefix = `[W${workerId}]`;
      const sessionDir = `${SESSION_DIR}_worker${workerId}`;
      sessionDirs.push(sessionDir);

      const tile = computeTileLayout(workerId - 1, actualWorkers);
      log.step(`${prefix} Window: ${tile.size.width}x${tile.size.height} at (${tile.position.x},${tile.position.y})`);

      const { browser, context, page } = await launchBrowser({
        sessionDir,
        viewport: tile.viewport,
        args: tile.args,
        acceptDownloads: true,
      });
      return { browser: browser as never, context, page };
    };

  const now = new Date().toISOString();

  try {
    const result = await runWorkflowBatch(
      kronosReportsWorkflow,
      items,
      {
        poolSize: actualWorkers,
        launchFn,
        // Each item's dashboard ID is the employeeId itself (not the default
        // UUID). Without this override, onPreEmitPending's ID wouldn't match
        // the kernel's derived itemId and the dashboard would show duplicate
        // rows per employee.
        deriveItemId: (item) => (item as KronosItem).employeeId,
        onPreEmitPending: (item, runId) => {
          const { employeeId } = item as KronosItem;
          trackEvent({
            workflow: "kronos-reports",
            timestamp: now,
            id: employeeId,
            runId,
            status: "pending",
            data: { id: employeeId },
          });
        },
      },
    );

    log.success(
      `Kronos batch complete — ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`,
    );
    if (result.failed > 0) {
      const summary = result.errors
        .slice(0, 3)
        .map((e) => `  - ${errorMessage(e.error)}`)
        .join("\n");
      log.error(`Failures (first 3):\n${summary}`);
    }
  } finally {
    clearKronosRuntime();

    // Cleanup session directories after all workers finish. Best-effort —
    // a running process elsewhere could lock a dir; the next run will
    // reassign and Playwright handles stale contexts on launch.
    for (const dir of sessionDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
        log.step(`Cleaned up session dir: ${dir}`);
      } catch { /* non-fatal */ }
    }

    log.success(`All ${employeeIds.length} employee(s) processed`);
  }
}
