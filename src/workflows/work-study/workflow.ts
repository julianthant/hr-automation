import {
  defineWorkflow,
  runWorkflow,
  hashKey,
  hasRecentlySucceeded,
  recordSuccess,
  findRecentTransactionId,
} from "../../core/index.js";
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
  label: "Work Study",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: workStudySteps,
  schema: WorkStudyInputSchema,
  tiling: "single",
  authChain: "sequential",
  // Matches pre-subsystem-D WF_CONFIG["work-study"].detailFields:
  // Employee/EmplId are rendered by the dashboard from name + id; Started/Elapsed
  // are synthesized from firstLogTs/lastLogTs. Only `emplId` is a raw data key
  // here — `name` is populated at line 56 below once PayPath extracts it.
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "emplId", label: "Empl ID" },
    { key: "effectiveDate", label: "Effective Date" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.emplId ?? "",
  handler: async (ctx, input) => {
    const wsCtx: WorkStudyContext = { employeeName: "" };

    // Surface input data to the dashboard before the first step fires.
    ctx.updateData({ emplId: input.emplId, effectiveDate: input.effectiveDate });

    // Step 1: auth — Session already kicked off loginToUCPath; we just
    // announce the phase for the dashboard, then let the first ctx.page()
    // call below block until that auth promise resolves. markStep is the
    // announce-only variant of step — no body to wrap.
    ctx.markStep("ucpath-auth");
    await ctx.page("ucpath");

    // Idempotency skip flips to true if hasRecentlySucceeded matches — the
    // tracker row then records the skip instead of a successful run.
    let skipped = false;

    // Step 2: execute the PayPath transaction plan.
    await ctx.step("transaction", async () => {
      // Idempotency: key on (workflow, emplId, effectiveDate, positionPool).
      // Prevents re-submitting the same award if the worker crashes between
      // plan.execute() success and the tracker write.
      const idempKey = hashKey({
        workflow: "work-study",
        emplId: input.emplId,
        effectiveDate: input.effectiveDate,
        positionPool: "F",
      });
      if (hasRecentlySucceeded(idempKey)) {
        const existingTxId = findRecentTransactionId(idempKey);
        const note = existingTxId
          ? `work-study update already submitted recently (txId ${existingTxId}) — skipping (idempotency)`
          : "work-study update already submitted recently — skipping (idempotency)";
        log.warn(note);
        ctx.updateData({
          status: "Skipped (Duplicate)",
          idempotencySkip: "true",
          ...(existingTxId ? { transactionId: existingTxId } : {}),
        });
        skipped = true;
        return;
      }

      const page = await ctx.page("ucpath");
      const plan = buildWorkStudyPlan(input, page, wsCtx);
      await plan.execute();
      recordSuccess(idempKey, "", "work-study");
      ctx.updateData({ name: wsCtx.employeeName });
    });

    // Tracker row — reflect skip vs success. Non-fatal if Excel write fails.
    try {
      await updateWorkStudyTracker({
        emplId: input.emplId,
        employeeName: wsCtx.employeeName,
        effectiveDate: input.effectiveDate,
        positionPool: "F",
        status: skipped ? "Skipped (Duplicate)" : "Done",
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

/**
 * Daemon-mode CLI adapter. Dispatches a single work-study item through the
 * shared daemon queue instead of running an in-process single-item kernel
 * call: first call spawns a detached daemon (1 Duo), subsequent calls
 * enqueue + wake alive daemons.
 *
 * See `src/core/daemon-client.ts::ensureDaemonsAndEnqueue` for flag
 * semantics and `src/workflows/work-study/CLAUDE.md` ("Daemon mode") for
 * user-facing docs. `runWorkStudy` above remains untouched so tests and
 * scripting can still run the work-study workflow directly without the
 * daemon.
 */
export async function runWorkStudyCli(
  emplId: string,
  effectiveDate: string,
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (!emplId || !effectiveDate) {
    log.error("runWorkStudyCli: emplId and effectiveDate are required");
    process.exitCode = 1;
    return;
  }
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  await ensureDaemonsAndEnqueue(
    workStudyWorkflow,
    [{ emplId, effectiveDate }],
    { new: options.new, parallel: options.parallel },
  );
}
