import { readFile } from "fs/promises";
import { mkdirSync, existsSync } from "fs";
import { parse } from "yaml";
import { Mutex } from "async-mutex";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { launchBrowser } from "../../browser/launch.js";
import { loginToUKG } from "../../auth/login.js";
import {
  getGeniesIframe,
  setDateRange,
} from "../../old-kronos/index.js";
import { runKronosForEmployee } from "./workflow.js";
import type { KronosTrackerRow } from "./tracker.js";
import { updateKronosTracker as updateTracker } from "./tracker.js";
import {
  BATCH_FILE,
  SESSION_DIR,
  REPORTS_DIR,
  DEFAULT_START_DATE,
  DEFAULT_END_DATE,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
} from "./config.js";

/**
 * Create a mutex-wrapped version of updateTracker.
 * Ensures only one worker writes to the Excel file at a time.
 */
function createLockedTracker(mutex: Mutex) {
  return async (filePath: string, data: KronosTrackerRow): Promise<void> => {
    const release = await mutex.acquire();
    try {
      await updateTracker(filePath, data);
    } finally {
      release();
    }
  };
}

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
  const lockedTracker = createLockedTracker(trackerMutex);

  const sessionDirs: string[] = [];
  const workers = Array.from({ length: actualWorkers }, (_, i) => {
    sessionDirs.push(`${SESSION_DIR}_worker${i + 1}`);
    return runWorker(
      i + 1,
      actualWorkers,
      queue,
      lockedTracker,
      reportMutex,
      options.startDate ?? DEFAULT_START_DATE,
      options.endDate ?? DEFAULT_END_DATE,
    );
  });

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
}

/**
 * A single worker that processes employee IDs from the shared queue.
 * Launches its own persistent browser session and reuses it across employees.
 */
async function runWorker(
  workerId: number,
  totalWorkers: number,
  queue: string[],
  lockedTracker: (filePath: string, data: KronosTrackerRow) => Promise<void>,
  reportMutex: Mutex,
  startDate: string,
  endDate: string,
): Promise<void> {
  const prefix = `[W${workerId}]`;
  const sessionDir = `${SESSION_DIR}_worker${workerId}`;

  // Calculate tiled window position
  const cols = Math.ceil(Math.sqrt(totalWorkers));
  const rows = Math.ceil(totalWorkers / cols);
  const winW = Math.floor(SCREEN_WIDTH / cols);
  const winH = Math.floor(SCREEN_HEIGHT / rows);
  const col = (workerId - 1) % cols;
  const rowIdx = Math.floor((workerId - 1) / cols);
  const x = col * winW;
  const y = rowIdx * winH;

  log.step(`${prefix} Window: ${winW}x${winH} at (${x},${y})`);

  // Launch persistent browser
  const { context, page } = await launchBrowser({
    sessionDir,
    viewport: { width: winW, height: winH },
    args: [`--window-position=${x},${y}`, `--window-size=${winW},${winH}`],
    acceptDownloads: true,
  });

  try {
    // Login
    const authOk = await loginToUKG(page);
    if (!authOk) {
      log.error(`${prefix} UKG authentication failed`);
      return;
    }

    // Get iframe and set date range
    const iframe = await getGeniesIframe(page);
    log.step(`${prefix} Dashboard ready`);
    await setDateRange(page, iframe, startDate, endDate);

    // Process employees from queue
    while (queue.length > 0) {
      const employeeId = queue.shift();
      if (!employeeId) break;

      log.step(`${prefix} ${"=".repeat(50)}`);
      log.step(`${prefix} PROCESSING: ${employeeId}`);
      log.step(`${prefix} ${"=".repeat(50)}`);

      await runKronosForEmployee(employeeId, {
        page,
        dateRangeSet: true,
        updateTrackerFn: lockedTracker,
        reportLock: reportMutex,
        logPrefix: prefix,
      });
    }

    log.success(`${prefix} Worker finished`);
  } catch (error) {
    log.error(`${prefix} Worker error: ${errorMessage(error)}`);
  } finally {
    await context.close();
  }
}
