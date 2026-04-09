import { readFile } from "fs/promises";
import { mkdirSync, existsSync } from "fs";
import { parse } from "yaml";
import { Mutex } from "async-mutex";
import { log, withLogContext } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { launchBrowser } from "../../browser/launch.js";
import { ukgNavigateAndFill, ukgSubmitAndWaitForDuo } from "../../auth/login.js";
import { startDashboard, stopDashboard } from "../../tracker/dashboard.js";
import {
  getGeniesIframe,
  setDateRange,
} from "../../old-kronos/index.js";
import { runKronosForEmployee } from "./workflow.js";
import type { KronosTrackerRow } from "./tracker.js";
import { updateKronosTracker as updateTracker } from "./tracker.js";
import { createLockedTracker } from "../../tracker/locked.js";
import {
  BATCH_FILE,
  SESSION_DIR,
  REPORTS_DIR,
  DEFAULT_START_DATE,
  DEFAULT_END_DATE,
} from "./config.js";
import { computeTileLayout } from "../../browser/tiling.js";

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

  // Validate each entry is a numeric string
  for (const entry of ids) {
    const id = String(entry);
    if (!/^\d{5,}$/.test(id)) {
      throw new Error(`Invalid employee ID in batch file: ${String(entry)}`);
    }
  }

  return ids.map(String);
}

/**
 * Run kronos report downloads for all employees in batch.yaml with parallel workers.
 */
export async function runParallelKronos(
  workerCount: number,
  options: { dryRun?: boolean; startDate?: string; endDate?: string } = {},
): Promise<void> {
  startDashboard("kronos-reports");
  try {
  const employeeIds = await loadBatchFile();
  log.step(`Loaded ${employeeIds.length} employee ID(s) from batch file`);

  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    log.step(`Would process ${employeeIds.length} employees with ${workerCount} workers`);
    log.step(`Date range: ${options.startDate ?? DEFAULT_START_DATE} - ${options.endDate ?? DEFAULT_END_DATE}`);
    for (const id of employeeIds) {
      log.step(`  Employee: ${id}`);
    }
    log.success("Dry run complete — no reports downloaded");
    return;
  }

  // Ensure output directories exist
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

  const actualWorkers = Math.min(workerCount, employeeIds.length);
  log.step(`Starting ${actualWorkers} parallel worker(s)`);

  const queue = [...employeeIds];
  const trackerMutex = new Mutex();
  const reportMutex = new Mutex();
  const lockedTracker = createLockedTracker<KronosTrackerRow>(trackerMutex, updateTracker);

  // Phase 1a: Launch all browsers and fill credentials (5s gap between each)
  const sessionDirs: string[] = [];
  const launched: { context: Awaited<ReturnType<typeof launchBrowser>>["context"]; page: Awaited<ReturnType<typeof launchBrowser>>["page"]; alreadyLoggedIn: boolean }[] = [];

  for (let i = 0; i < actualWorkers; i++) {
    const workerId = i + 1;
    const prefix = `[W${workerId}]`;
    const sessionDir = `${SESSION_DIR}_worker${workerId}`;
    sessionDirs.push(sessionDir);

    const tile = computeTileLayout(i, actualWorkers);
    log.step(`${prefix} Window: ${tile.size.width}x${tile.size.height} at (${tile.position.x},${tile.position.y})`);

    const { context, page } = await launchBrowser({
      sessionDir,
      viewport: tile.viewport,
      args: tile.args,
      acceptDownloads: true,
    });

    const fillResult = await ukgNavigateAndFill(page);
    if (fillResult === false) {
      log.error(`${prefix} Could not fill credentials`);
      await context.close();
      continue;
    }

    launched.push({ context, page, alreadyLoggedIn: fillResult === "already_logged_in" });

    // 5s gap before opening next window
    if (i < actualWorkers - 1) {
      await page.waitForTimeout(5_000);
    }
  }

  // Phase 1b: Submit login on each window sequentially (Duo MFA one at a time)
  const workerContexts: { context: typeof launched[0]["context"]; page: typeof launched[0]["page"] }[] = [];

  for (let i = 0; i < launched.length; i++) {
    const { context, page, alreadyLoggedIn } = launched[i];
    const prefix = `[W${i + 1}]`;

    if (!alreadyLoggedIn) {
      const authOk = await ukgSubmitAndWaitForDuo(page);
      if (!authOk) {
        log.error(`${prefix} UKG authentication failed`);
        await context.close();
        continue;
      }
    }

    const iframe = await getGeniesIframe(page);
    log.step(`${prefix} Dashboard ready`);
    await setDateRange(page, iframe, options.startDate ?? DEFAULT_START_DATE, options.endDate ?? DEFAULT_END_DATE);

    workerContexts.push({ context, page });
  }

  // Phase 2: All workers process employees in parallel
  const workers = workerContexts.map((wc, i) =>
    runWorker(i + 1, queue, wc.context, wc.page, lockedTracker, reportMutex),
  );

  await Promise.all(workers);

  // Cleanup session directories after all workers finish
  const { rmSync } = await import("fs");
  for (const dir of sessionDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
      log.step(`Cleaned up session dir: ${dir}`);
    } catch {
      // Non-fatal
    }
  }

  log.success(`All ${employeeIds.length} employee(s) processed`);
  } finally {
    stopDashboard();
  }
}

/**
 * A single worker that processes employee IDs from the shared queue.
 * Receives a pre-authenticated browser page (login done sequentially in Phase 1).
 */
async function runWorker(
  workerId: number,
  queue: string[],
  context: Awaited<ReturnType<typeof launchBrowser>>["context"],
  page: Awaited<ReturnType<typeof launchBrowser>>["page"],
  lockedTracker: (filePath: string, data: KronosTrackerRow) => Promise<void>,
  reportMutex: Mutex,
): Promise<void> {
  const prefix = `[W${workerId}]`;

  try {
    let consecutiveErrors = 0;

    while (queue.length > 0) {
      const employeeId = queue.shift();
      if (!employeeId) break;

      // Check if browser is still alive before processing
      try {
        await page.evaluate(() => true);
      } catch {
        log.error(`${prefix} Browser session dead — stopping worker (${queue.length} employees remaining in queue)`);
        break;
      }

      log.step(`${prefix} ${"=".repeat(50)}`);
      log.step(`${prefix} PROCESSING: ${employeeId}`);
      log.step(`${prefix} ${"=".repeat(50)}`);

      try {
        await withLogContext("kronos-reports", employeeId, () => runKronosForEmployee(employeeId, {
          page,
          dateRangeSet: true,
          updateTrackerFn: lockedTracker,
          reportLock: reportMutex,
          logPrefix: prefix,
        }));
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        log.error(`${prefix} ${employeeId} threw: ${errorMessage(err).slice(0, 80)}`);
        if (consecutiveErrors >= 3) {
          log.error(`${prefix} 3 consecutive errors — stopping worker (${queue.length} remaining)`);
          break;
        }
      }
    }

    log.success(`${prefix} Worker finished`);
  } catch (error) {
    log.error(`${prefix} Worker error: ${errorMessage(error)}`);
  } finally {
    await context.close();
  }
}
