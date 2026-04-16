import { readFile } from "fs/promises";
import { parse } from "yaml";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { launchBrowser } from "../../browser/launch.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToI9 } from "../../systems/i9/index.js";
import { runOnboardingLegacy } from "./workflow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BATCH_FILE = join(__dirname, "batch.yaml");

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

export async function runParallel(
  parallelCount: number,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const emails = await loadBatchFile();
  log.step(`Loaded ${emails.length} email(s) from batch file`);
  log.step(`Starting ${parallelCount} parallel worker(s)`);

  const queue = [...emails];
  const workerCount = Math.min(parallelCount, emails.length);
  const workers = Array.from({ length: workerCount }, (_, i) =>
    runWorker(i + 1, queue, options),
  );

  await Promise.all(workers);
  log.success(`All ${emails.length} employee(s) processed`);
}

async function runWorker(
  workerId: number,
  queue: string[],
  options: { dryRun?: boolean },
): Promise<void> {
  const prefix = `[Worker ${workerId}]`;

  log.step(`${prefix} Launching CRM browser...`);
  const crmBrowser = await launchBrowser();

  let ucpathPage: import("playwright").Page | undefined;
  let i9Page: import("playwright").Page | undefined;

  if (!options.dryRun) {
    log.step(`${prefix} Launching UCPath browser...`);
    ucpathPage = (await launchBrowser()).page;

    log.step(`${prefix} Launching I-9 browser...`);
    i9Page = (await launchBrowser()).page;
    try {
      const ok = await loginToI9(i9Page);
      if (!ok) throw new Error("loginToI9 returned false");
      log.success(`${prefix} I-9 pre-auth complete`);
    } catch (err) {
      log.error(`${prefix} I-9 pre-auth failed: ${errorMessage(err)}`);
      i9Page = undefined;
    }
  }

  while (queue.length > 0) {
    const email = queue.shift();
    if (!email) break;
    log.step(`${prefix} Processing ${email} (${queue.length} remaining in queue)`);

    try {
      await runOnboardingLegacy(email, {
        dryRun: options.dryRun,
        crmPage: crmBrowser.page,
        ucpathPage,
        i9Page,
        logPrefix: prefix,
      });
      log.success(`${prefix} Completed ${email}`);
    } catch (error) {
      log.error(`${prefix} Failed ${email}: ${errorMessage(error)}`);
      // Worker continues to next email — error already captured in dashboard
    }
  }

  log.success(`${prefix} Worker finished — browsers left open`);
}
