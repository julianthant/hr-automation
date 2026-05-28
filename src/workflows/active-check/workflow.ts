import { randomUUID } from "node:crypto";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import type { Ctx } from "../../core/kernel/types.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { PATHS } from "../../config.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { allocateLowestBatchDisplayOrdinal } from "../../tracker/batch-display-ordinal.js";
import { log } from "../../utils/log.js";
import { deriveActiveCheckOutcome, lookupPersonInUcpath } from "../person-lookup/index.js";
import {
  ActiveCheckItemSchema,
  buildActiveCheckCliInput,
  deriveActiveCheckItemId,
  displayActiveCheckInput,
  isActiveCheckEidInput,
  type ActiveCheckItem,
} from "./schema.js";

const steps = ["checking"] as const;

/** Direct input runs use normal defaults; OCR fan-out children title by person/EID. */
export const ACTIVE_CHECK_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
};

export const activeCheckWorkflow = defineWorkflow({
  name: "active-check",
  label: "Active Check",
  archetype: "single",
  category: "Utils",
  iconName: "Search",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance, context) => {
        const ok = await loginToUCPath(page, instance, context?.abortSignal);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  steps,
  schema: ActiveCheckItemSchema,
  runtimePolicy: ACTIVE_CHECK_WORKFLOW_RUNTIME_POLICY,
  queueTitle: { kind: "single" },
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "emplId", label: "EID" },
    { key: "hrStatus", label: "HR Status" },
    { key: "effdt", label: "EFFDT" },
    { key: "terminationDate", label: "End Date" },
    { key: "department", label: "Dept" },
  ],
  getName: (d) => d.searchName || d.name || "",
  getId: (d) => d.emplId || d.searchName || "",
  operatorSubject: (input) =>
    isActiveCheckEidInput(input)
      ? buildOperatorSubject({ kind: "eid", value: input.emplId })
      : buildOperatorSubject({ kind: "person", value: input.name }),
  initialData: (input) => ({ searchName: displayActiveCheckInput(input) }),
  deriveItemId: deriveActiveCheckItemId,
  handler: async (ctx: Ctx<typeof steps, ActiveCheckItem>, input) => {
    ctx.updateData({ searchName: displayActiveCheckInput(input) });
    await ctx.step("checking", async () => {
      const page = await ctx.page("ucpath");
      const lookup = await lookupPersonInUcpath(
        page,
        isActiveCheckEidInput(input)
          ? { kind: "by-eid", emplId: input.emplId }
          : { kind: "by-name", name: input.name },
        { keepNonHdh: true },
      );
      const outcome = deriveActiveCheckOutcome(lookup.input, lookup.results);
      ctx.updateData({
        ...outcome,
        isActive: String(outcome.isActive),
        isHdhAccepted: String(outcome.isHdhAccepted),
        candidateEids: outcome.candidateEids.join(", "),
      });
      if (outcome.activeStatus === "active") {
        log.success(`Active Check: ${outcome.emplId} is active`);
      } else {
        log.step(`Active Check: ${displayActiveCheckInput(input)} -> ${outcome.activeStatus}`);
      }
      if (lookup.results.length > 0) await ctx.captureAndStampScreenshot("person-org-summary-active-check", "personOrgScreenshot");
    });
  },
});

export async function runActiveCheck(input: ActiveCheckItem): Promise<void> {
  await runWorkflow(activeCheckWorkflow, input);
}

const activeCheckBatchOrdinals = new Map<string, string>();

export const runActiveCheckCli = buildCliAdapter<[string[]], ActiveCheckItem>({
  workflow: activeCheckWorkflow,
  emptyMessage: "runActiveCheckCli: provide at least one name or EID",
  buildInputs: (queries) =>
    queries.map(buildActiveCheckCliInput).map((input) => ActiveCheckItemSchema.parse(input)),
  deriveItemId: deriveActiveCheckItemId,
  parentRunId: (inputs) => (inputs.length > 1 ? randomUUID() : undefined),
  buildPendingData: (input, itemId) => {
    const display = displayActiveCheckInput(input);
    return {
      searchName: display,
      __name: display,
      __id: itemId,
    };
  },
  pendingExtras: (_input, _itemId, _runId, parentRunId): Record<string, string> => {
    if (!parentRunId) return {};
    let batchDisplayOrdinal = activeCheckBatchOrdinals.get(parentRunId);
    if (!batchDisplayOrdinal) {
      batchDisplayOrdinal = String(allocateLowestBatchDisplayOrdinal("active-check", PATHS.trackerDir));
      activeCheckBatchOrdinals.set(parentRunId, batchDisplayOrdinal);
    }
    return { batchDisplayOrdinal };
  },
});

export type { ActiveCheckOutcome, ActiveCheckStatus } from "../person-lookup/index.js";
export { deriveActiveCheckOutcome };
