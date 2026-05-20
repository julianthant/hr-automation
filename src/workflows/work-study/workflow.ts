import {
  defineWorkflow,
  runWorkflow,
} from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { buildWorkStudyPlan, type WorkStudyContext } from "./enter.js";
import { WorkStudyInputSchema, type WorkStudyInput } from "./schema.js";

const workStudySteps = ["ucpath-auth", "transaction"] as const;

export const WORK_STUDY_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy =
  DEFAULT_WORKFLOW_RUNTIME_POLICY;

/**
 * Kernel definition for the work-study PayPath workflow.
 *
 * Exports a RegisteredWorkflow. Run it via `runWorkflow(workStudyWorkflow, input)`
 * or invoke the CLI adapter `runWorkStudy` below.
 */
export const workStudyWorkflow = defineWorkflow({
  name: "work-study",
  label: "Work Study",
  archetype: "single",
  category: "Work Study",
  iconName: "Briefcase",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance, context) => {
        const ok = await loginToUCPath(page, instance, context?.abortSignal);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: workStudySteps,
  schema: WorkStudyInputSchema,
  runtimePolicy: WORK_STUDY_WORKFLOW_RUNTIME_POLICY,
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
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "eid", value: input.emplId, prefix: "Work Study" }),
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

    // Step 2: execute the PayPath transaction plan.
    await ctx.step("transaction", async () => {
      const page = await ctx.page("ucpath");
      const plan = buildWorkStudyPlan(input, page, wsCtx);
      await plan.execute();
      ctx.updateData({ name: wsCtx.employeeName });
    });
  },
});

/**
 * CLI adapter. Real runs delegate to the kernel.
 */
export async function runWorkStudy(input: WorkStudyInput): Promise<void> {
  try {
    await runWorkflow(workStudyWorkflow, input);
    log.success("Work study transaction completed successfully");
  } catch (err) {
    log.error(`Work study failed: ${errorMessage(err)}`);
    throw err;
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
export const runWorkStudyCli = buildCliAdapter<[string, string], WorkStudyInput>({
  workflow: workStudyWorkflow,
  emptyMessage: "runWorkStudyCli: emplId and effectiveDate are required",
  buildInputs: (emplId, effectiveDate) => (emplId && effectiveDate ? [{ emplId, effectiveDate }] : []),
  deriveItemId: (item) => item.emplId,
  buildPendingData: (item) => ({ emplId: item.emplId, effectiveDate: item.effectiveDate }),
});
