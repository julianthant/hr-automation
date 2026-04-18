import { readFile } from "fs/promises";
import { parse } from "yaml";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { runWorkflowBatch } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { onboardingWorkflow } from "./workflow.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BATCH_FILE = join(__dirname, "batch.yaml");

/** Load + validate the email list from `batch.yaml`. */
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
 * CLI adapter for `npm run start-onboarding:batch -- <N>`. Thin shim over
 * `runWorkflowBatch` (pool mode). Owns only pre-kernel concerns:
 *
 *   1. Load + validate `batch.yaml`.
 *   2. Warn if `--dry-run` is combined with `--parallel` (dry-run stays
 *      single-mode-only; see single-mode `runOnboardingDryRun`).
 *   3. Build `items: { email }[]` for the kernel schema and delegate to
 *      `runWorkflowBatch(onboardingWorkflow, items, { poolSize, deriveItemId,
 *      onPreEmitPending })`.
 *
 * The kernel owns: per-worker Session launch (CRM + UCPath + I9), sequential
 * auth chain (CRM Duo → UCPath Duo → I9 SSO-no-Duo), queue fan-out,
 * per-item `withTrackedWorkflow` wrapping, SIGINT cleanup, screenshot on
 * failure. `deriveItemId: (i) => i.email` pairs with `onPreEmitPending` so
 * the dashboard shows one row per email (keyed on the email) before any
 * worker authenticates.
 */
export async function runParallel(
  parallelCount: number,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  const emails = await loadBatchFile();
  log.step(`Loaded ${emails.length} email(s) from batch file`);
  log.step(`Starting ${parallelCount} worker(s)`);

  if (options.dryRun) {
    log.warn("Dry-run not supported in parallel/batch mode — run single-mode `npm run start-onboarding:dry <email>` instead.");
    return;
  }

  const items = emails.map((email) => ({ email }));
  const now = new Date().toISOString();

  try {
    const result = await runWorkflowBatch(onboardingWorkflow, items, {
      poolSize: parallelCount,
      deriveItemId: (item) => (item as { email: string }).email,
      onPreEmitPending: (item, runId) => {
        const { email } = item as { email: string };
        trackEvent({
          workflow: "onboarding",
          timestamp: now,
          id: email,
          runId,
          status: "pending",
          data: { email },
        });
      },
    });

    log.success(
      `Onboarding batch complete — ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`,
    );
    if (result.failed > 0) {
      const summary = result.errors
        .slice(0, 3)
        .map((e) => `  - ${errorMessage(e.error)}`)
        .join("\n");
      log.error(`Failures (first 3):\n${summary}`);
    }
  } catch (error) {
    log.error(`Onboarding batch failed: ${errorMessage(error)}`);
    throw error;
  }
}
