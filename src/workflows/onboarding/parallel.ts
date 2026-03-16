import { readFile } from "fs/promises";
import { parse } from "yaml";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Mutex } from "async-mutex";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { updateTracker } from "../../tracker/index.js";
import type { TrackerRow } from "../../tracker/index.js";
import { runOnboarding } from "./workflow.js";
import type { OnboardingOptions } from "./workflow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BATCH_FILE = join(__dirname, "batch.yaml");

/**
 * Create a mutex-wrapped version of updateTracker.
 * Ensures only one worker writes to the Excel file at a time.
 */
function createLockedTracker(mutex: Mutex) {
  return async (filePath: string, data: TrackerRow): Promise<void> => {
    const release = await mutex.acquire();
    try {
      await updateTracker(filePath, data);
    } finally {
      release();
    }
  };
}

/**
 * Load and validate the batch file.
 * Returns a list of email addresses.
 */
export async function loadBatchFile(): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(BATCH_FILE, "utf-8");
  } catch {
    throw new Error(`Batch file not found: ${BATCH_FILE}`);
  }

  const emails = parse(content) as unknown;

  if (!Array.isArray(emails) || emails.length === 0) {
    throw new Error(`Batch file is empty or invalid: ${BATCH_FILE}`);
  }

  for (const entry of emails) {
    if (typeof entry !== "string" || !entry.includes("@")) {
      throw new Error(`Invalid email in batch file: ${String(entry)}`);
    }
  }

  return emails as string[];
}

/**
 * Run onboarding for multiple employees in parallel.
 *
 * @param parallelCount - Number of concurrent browser workers
 * @param options - Shared options (dryRun, etc.)
 */
export async function runParallel(
  parallelCount: number,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const emails = await loadBatchFile();
  log.step(`Loaded ${emails.length} email(s) from batch file`);
  log.step(`Starting ${parallelCount} parallel worker(s)`);

  const queue = [...emails];
  const mutex = new Mutex();
  const lockedTracker = createLockedTracker(mutex);

  const workerCount = Math.min(parallelCount, emails.length);
  const workers = Array.from({ length: workerCount }, (_, i) =>
    runWorker(i + 1, queue, lockedTracker, options),
  );

  await Promise.all(workers);
  log.success(`All ${emails.length} employee(s) processed`);
}

/**
 * A single worker that processes emails from the shared queue.
 * Launches its own browser pair and reuses them across employees.
 */
async function runWorker(
  workerId: number,
  queue: string[],
  lockedTracker: (filePath: string, data: TrackerRow) => Promise<void>,
  options: { dryRun?: boolean },
): Promise<void> {
  const prefix = `[Worker ${workerId}]`;

  // Launch browser pair once per worker
  log.step(`${prefix} Launching CRM browser...`);
  const crmBrowser = await launchBrowser();

  let ucpathPage: import("playwright").Page | undefined;
  if (!options.dryRun) {
    log.step(`${prefix} Launching UCPath browser...`);
    const ucpathBrowser = await launchBrowser();
    ucpathPage = ucpathBrowser.page;
  }

  while (queue.length > 0) {
    const email = queue.shift();
    if (!email) break; // queue exhausted between check and shift
    log.step(`${prefix} Processing ${email} (${queue.length} remaining in queue)`);

    try {
      await runOnboarding(email, {
        dryRun: options.dryRun,
        crmPage: crmBrowser.page,
        ucpathPage,
        updateTrackerFn: lockedTracker,
        logPrefix: prefix,
      });
      log.success(`${prefix} Completed ${email}`);
    } catch (error) {
      log.error(`${prefix} Failed ${email}: ${errorMessage(error)}`);
      // Worker continues to next email — error already logged to tracker in workflow.ts
    }
  }

  log.success(`${prefix} Worker finished — browsers left open`);
}
