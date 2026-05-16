import { randomUUID } from "node:crypto";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import type { Ctx } from "../../core/kernel/types.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { PATHS } from "../../config.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { deriveActiveCheckOutcome } from "../../domain/active-check-outcome.js";
import { searchByEid, searchByName } from "../../systems/ucpath/person-org-summary.js";
import { allocateLowestBatchDisplayOrdinal } from "../../tracker/batch-display-ordinal.js";
import { log } from "../../utils/log.js";
import {
  ActiveCheckItemSchema,
  buildActiveCheckCliInput,
  deriveActiveCheckItemId,
  displayActiveCheckInput,
  isActiveCheckEidInput,
  type ActiveCheckItem,
} from "./schema.js";

const steps = ["checking"] as const;

export const activeCheckWorkflow = defineWorkflow({
  name: "active-check",
  label: "Active Check",
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
  queueTitle: { kind: "single" },
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "emplId", label: "EID" },
    { key: "hrStatus", label: "HR Status" },
    { key: "effdt", label: "EFFDT" },
    { key: "terminationDate", label: "End Date" },
    { key: "department", label: "Dept" },
  ],
  getName: (d) => d.name || d.searchName || "",
  getId: (d) => d.emplId || d.searchName || "",
  operatorSubject: (input) =>
    isActiveCheckEidInput(input)
      ? buildOperatorSubject({ kind: "eid", value: input.emplId, prefix: "Active Check" })
      : buildOperatorSubject({ kind: "person", value: input.name, prefix: "Active Check" }),
  initialData: (input) => ({ searchName: displayActiveCheckInput(input) }),
  deriveItemId: deriveActiveCheckItemId,
  handler: async (ctx: Ctx<typeof steps, ActiveCheckItem>, input) => {
    ctx.updateData({ searchName: displayActiveCheckInput(input) });
    await ctx.step("checking", async () => {
      const page = await ctx.page("ucpath");
      const results = isActiveCheckEidInput(input)
        ? await searchByEid(page, input.emplId).then((result) => (result ? [result] : []))
        : (await searchByName(page, input.name, { keepNonHdh: true })).sdcmpResults;
      const deriveIn = isActiveCheckEidInput(input)
        ? ({ kind: "by-eid", emplId: input.emplId } as const)
        : ({ kind: "by-name", name: input.name } as const);
      const outcome = deriveActiveCheckOutcome(deriveIn, results);
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
      if (results.length > 0) await ctx.captureAndStampScreenshot("person-org-summary-active-check", "personOrgScreenshot");
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

export type { ActiveCheckOutcome, ActiveCheckStatus } from "../../domain/active-check-outcome.js";
export { deriveActiveCheckOutcome };
