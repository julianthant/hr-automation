import { defineWorkflow, runWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { loginToUCPath } from "../../auth/login.js";
import { buildOperatorSubject, operatorSubjectData } from "../../domain/operator-subject.js";
import { isAcceptedHdhDepartment } from "../../domain/hdh/departments.js";
import {
  searchByEid,
  searchByName,
  type EidResult,
} from "../../systems/ucpath/person-org-summary.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import {
  ActiveCheckItemSchema,
  deriveActiveCheckItemId,
  displayActiveCheckInput,
  isActiveCheckEidInput,
  type ActiveCheckItem,
} from "./schema.js";

const steps = ["checking"] as const;

export type ActiveCheckStatus = "active" | "inactive" | "not-found" | "non-hdh" | "ambiguous";

export interface ActiveCheckOutcome {
  activeStatus: ActiveCheckStatus;
  isActive: boolean;
  isHdhAccepted: boolean;
  searchName: string;
  emplId: string;
  name: string;
  department: string;
  hrStatus: string;
  terminationDate: string;
  expectedJobEndDate: string;
  candidateEids: string[];
}

export function deriveActiveCheckOutcome(
  input: ActiveCheckItem,
  results: EidResult[],
): ActiveCheckOutcome {
  const searchName = displayActiveCheckInput(input);
  if (results.length === 0) {
    return {
      activeStatus: "not-found",
      isActive: false,
      isHdhAccepted: false,
      searchName,
      emplId: isActiveCheckEidInput(input) ? input.emplId : "",
      name: "",
      department: "",
      hrStatus: "Not found",
      terminationDate: "",
      expectedJobEndDate: "",
      candidateEids: [],
    };
  }

  if (!isActiveCheckEidInput(input) && results.length > 1) {
    return {
      activeStatus: "ambiguous",
      isActive: false,
      isHdhAccepted: false,
      searchName,
      emplId: "",
      name: "",
      department: "",
      hrStatus: "Ambiguous",
      terminationDate: "",
      expectedJobEndDate: "",
      candidateEids: results.map((result) => result.emplId),
    };
  }

  const result = results[0];
  const terminationDate = normalizeDate(
    result.terminationDate ?? legacyTerminationDate(result.expectedEndDate),
  );
  const expectedJobEndDate = normalizeDate(result.expectedJobEndDate);
  const hrStatus = result.hrStatus || "";
  const isInactiveStatus = /inactive|terminated|separated/i.test(hrStatus);
  const isActive = !terminationDate && !isInactiveStatus;
  const isHdhAccepted = isAcceptedHdhDepartment(result.department);
  const activeStatus: ActiveCheckStatus = !isActive
    ? "inactive"
    : isHdhAccepted
      ? "active"
      : "non-hdh";

  return {
    activeStatus,
    isActive,
    isHdhAccepted,
    searchName,
    emplId: result.emplId,
    name: result.name,
    department: result.department ?? "",
    hrStatus,
    terminationDate,
    expectedJobEndDate,
    candidateEids: [result.emplId],
  };
}

function normalizeDate(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed && trimmed !== "Active" ? trimmed : "";
}

function legacyTerminationDate(expectedEndDate: string | undefined): string {
  const trimmed = expectedEndDate?.trim() ?? "";
  return trimmed && trimmed !== "Active" ? trimmed : "";
}

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
    { key: "searchName", label: "Search" },
    { key: "name", label: "Employee" },
    { key: "emplId", label: "EID" },
    { key: "activeStatus", label: "Active Check" },
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
      const outcome = deriveActiveCheckOutcome(input, results);
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
  const inputs = queries.map((query) => (/^\d{5,}$/.test(query) ? { emplId: query } : { name: query }));
  const parsed = inputs.map((input) => ActiveCheckItemSchema.parse(input));
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon/client.js");
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    activeCheckWorkflow,
    parsed,
    { new: options.new, parallel: options.parallel },
    {
      deriveItemId: deriveActiveCheckItemId,
      onPreEmitPending: (item, runId, _parentRunId, itemId) => {
        const subject = activeCheckWorkflow.config.operatorSubject?.(item);
        const display = displayActiveCheckInput(item);
        trackEvent({
          workflow: "active-check",
          timestamp: now,
          id: itemId,
          runId,
          status: "pending",
          data: { searchName: display, __name: display, __id: itemId, ...operatorSubjectData(subject) },
        });
      },
    },
  );
}
