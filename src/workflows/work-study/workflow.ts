import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath } from "../../auth/login.js";
import { buildWorkStudyPlan, type WorkStudyContext } from "./enter.js";
import { WorkStudyInputSchema, type WorkStudyInput } from "./schema.js";
import { updateWorkStudyTracker } from "./tracker.js";

export interface WorkStudyOptions {
  dryRun?: boolean;
}

const workStudySteps = ["ucpath-auth", "transaction"] as const;

/**
 * Kernel definition for the work-study PayPath workflow.
 *
 * Exports a RegisteredWorkflow. Run it via `runWorkflow(workStudyWorkflow, input)`
 * or invoke the CLI adapter `runWorkStudy` below (which handles dry-run + failure
 * tracker writes).
 */
export const workStudyWorkflow = defineWorkflow({
  name: "work-study",
  systems: [
    { id: "ucpath", login: async (page, instance) => { await loginToUCPath(page, instance); } },
  ],
  steps: workStudySteps,
  schema: WorkStudyInputSchema,
  tiling: "single",
  authChain: "sequential",
  detailFields: ["emplId", "effectiveDate"],
  handler: async (ctx, input) => {
    const wsCtx: WorkStudyContext = { employeeName: "" };

    // Surface input data to the dashboard before the first step fires.
    ctx.updateData({ emplId: input.emplId, effectiveDate: input.effectiveDate });

    // Step 1: auth — Session already kicked off loginToUCPath; the first
    // ctx.page() call blocks until that promise resolves, so wrapping it in
    // a step gives the dashboard a clean "ucpath-auth" phase.
    await ctx.step("ucpath-auth", async () => {
      await ctx.page("ucpath");
    });

    // Step 2: execute the PayPath transaction plan.
    await ctx.step("transaction", async () => {
      const page = await ctx.page("ucpath");
      const plan = buildWorkStudyPlan(input, page, wsCtx);
      await plan.execute();
      ctx.updateData({ name: wsCtx.employeeName });
    });

    // Success tracker row. Non-fatal if Excel write fails.
    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: wsCtx.employeeName,
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: "Done",
        error: "",
        timestamp: new Date().toISOString(),
      });
      log.success("Tracker updated: work-study-tracker.xlsx");
    } catch (trackerErr) {
      log.error(`Tracker update failed (non-fatal): ${errorMessage(trackerErr)}`);
    }
  },
});

/**
 * CLI adapter. Handles --dry-run (preview only, no browser) and failure-path
 * Excel tracker writes. Real runs delegate to the kernel.
 */
export async function runWorkStudy(
  input: WorkStudyInput,
  options: WorkStudyOptions = {},
): Promise<void> {
  if (options.dryRun) {
    const wsCtx: WorkStudyContext = { employeeName: "" };
    const plan = buildWorkStudyPlan(input, null as never, wsCtx);
    log.step("=== DRY RUN MODE ===");
    plan.preview();
    log.success("Dry run complete -- no changes made to UCPath");
    return;
  }

  try {
    await runWorkflow(workStudyWorkflow, input);
    log.success("Work study transaction completed successfully");
  } catch (err) {
    // Failure tracker row — name is unknown here (kernel boundary), so we
    // write "" for employeeName. Dashboard JSONL has the richer record.
    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: "",
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: "Failed",
        error: errorMessage(err),
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Non-fatal — original tracker error already logged.
    }

    log.error(`Work study failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
