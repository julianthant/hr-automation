import { randomUUID } from "node:crypto";
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { PATHS } from "../../config.js";
import { buildOperatorSubject, operatorSubjectData } from "../../domain/operator-subject.js";
import { deriveActiveCheckOutcome } from "../../domain/active-check-outcome.js";
import { searchByEid, searchByName } from "../../systems/ucpath/person-org-summary.js";
import { allocateLowestBatchDisplayOrdinal } from "../../tracker/batch-display-ordinal.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
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

async function captureAndStampScreenshot<TSteps extends readonly string[]>(
  ctx: Ctx<TSteps, ActiveCheckItem>,
): Promise<void> {
  try {
    const cap = await ctx.screenshot({ kind: "form", label: "person-org-summary-active-check" });
    const filename = cap.files?.[0]?.path.split("/").pop();
    if (filename) ctx.updateData({ personOrgScreenshot: filename });
  } catch (err) {
    log.warn(`Active Check screenshot failed: ${errorMessage(err)}`);
  }
}

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
      if (results.length > 0) await captureAndStampScreenshot(ctx);
    });
  },
});

export async function runActiveCheck(input: ActiveCheckItem): Promise<void> {
  await runWorkflow(activeCheckWorkflow, input);
}

export async function runActiveCheckCli(
  queries: string[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (queries.length === 0) {
    log.error("runActiveCheckCli: provide at least one name or EID");
    process.exitCode = 1;
    return;
  }
  const inputs = queries.map(buildActiveCheckCliInput);
  const parsed = inputs.map((input) => ActiveCheckItemSchema.parse(input));
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon/client.js");
  const now = new Date().toISOString();
  const batchParentRunId = parsed.length > 1 ? randomUUID() : undefined;
  const batchDisplayOrdinal =
    batchParentRunId !== undefined
      ? allocateLowestBatchDisplayOrdinal("active-check", PATHS.trackerDir)
      : undefined;
  await ensureDaemonsAndEnqueue(
    activeCheckWorkflow,
    parsed,
    { new: options.new, parallel: options.parallel },
    {
      deriveItemId: deriveActiveCheckItemId,
      ...(batchParentRunId ? { parentRunId: batchParentRunId } : {}),
      onPreEmitPending: (item, runId, _parentRunId, itemId) => {
        const subject = activeCheckWorkflow.config.operatorSubject?.(item);
        const display = displayActiveCheckInput(item);
        trackEvent({
          workflow: "active-check",
          timestamp: now,
          id: itemId,
          runId,
          status: "pending",
          data: {
            searchName: display,
            __name: display,
            __id: itemId,
            ...(batchDisplayOrdinal !== undefined
              ? { batchDisplayOrdinal: String(batchDisplayOrdinal) }
              : {}),
            ...operatorSubjectData(subject),
          },
          ...(batchParentRunId ? { parentRunId: batchParentRunId } : {}),
        });
      },
    },
  );
}

export type { ActiveCheckOutcome, ActiveCheckStatus } from "../../domain/active-check-outcome.js";
export { deriveActiveCheckOutcome };
