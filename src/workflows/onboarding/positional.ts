import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { runWorkflowBatch } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { onboardingWorkflow } from "./workflow.js";

/**
 * Run onboarding for N emails in pool mode. Pool size defaults to min(N, 4),
 * overridable via `opts.poolSize` (wired to the `--workers N` CLI flag).
 *
 * Unlike `runParallel` (which reads `batch.yaml`), this takes emails directly
 * from the CLI: `npm run onboarding <email1> <email2> ...`.
 */
export async function runOnboardingPositional(
  emails: string[],
  opts: { dryRun?: boolean; poolSize?: number } = {},
): Promise<void> {
  if (opts.dryRun) {
    log.step(`Dry run: would onboard ${emails.length} email(s): ${emails.join(", ")}`);
    return;
  }

  const poolSize = opts.poolSize ?? Math.min(emails.length, 4);
  const now = new Date().toISOString();
  const items = emails.map((email) => ({ email }));

  try {
    const result = await runWorkflowBatch(onboardingWorkflow, items, {
      poolSize,
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
      process.exitCode = 1;
    }
  } catch (error) {
    log.error(`Onboarding batch failed: ${errorMessage(error)}`);
    throw error;
  }
}
