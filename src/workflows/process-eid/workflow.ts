import { defineWorkflow, runWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import { processEidStatusExtensions } from "../../domain/process-eid-status.js";
import {
  buildOperatorSubject,
  operatorSubjectData,
} from "../../domain/operator-subject.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { requireLogin } from "../../infra/auth/require-login.js";
import {
  findTransactionEidByTransactionId,
  type TransactionEidLookupResult,
} from "../../systems/ucpath/ss-smart-hr.js";
import {
  processEidNameMismatchMessage,
  verifyUcpathTransactionName,
} from "./name-match.js";
import { loadProcessEidCandidates } from "./roster.js";
import {
  ProcessEidInputSchema,
  isProcessEidPersonInput,
  processEidSheetLabel,
  type ProcessEidInput,
  type ProcessEidPersonInput,
} from "./schema.js";

const steps = ["lookup-eid"] as const;

export type ProcessEidResult = "Found" | "Pending" | "Not found";

export function deriveProcessEidResult(
  result: TransactionEidLookupResult,
): ProcessEidResult {
  if (!result.transactionFound) return "Not found";
  return result.eid ? "Found" : "Pending";
}

export const processEidWorkflow = defineWorkflow<
  ProcessEidInput,
  typeof steps
>({
  name: "process-eid",
  label: "Process EID",
  code: "pe",
  category: "Search",
  iconName: "Search",
  archetype: "single",
  inputSubject: (input) =>
    isProcessEidPersonInput(input) ? "name" : "selector",
  statusExtensions: processEidStatusExtensions,
  systems: [
    {
      id: "ucpath",
      login: requireLogin(loginToUCPath, "UCPath authentication failed"),
    },
  ],
  authSteps: true,
  steps,
  schema: ProcessEidInputSchema,
  runtimePolicy: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
    memberRow: { titleSource: "person" },
  },
  queueTitle: { kind: "single" },
  batch: { mode: "shared-context-pool", poolSize: 1, preEmitPending: true },
  expandHttpInputs: async (inputs, context) => {
    const expanded: ProcessEidInput[] = [];
    for (const input of inputs) {
      if (isProcessEidPersonInput(input)) {
        expanded.push(input);
      } else {
        expanded.push(
          ...await loadProcessEidCandidates(input, context.trackerDir),
        );
      }
    }
    return expanded;
  },
  detailFields: [
    { key: "rosterRow", label: "Roster Row" },
    { key: "livedName", label: "Lived Name" },
    { key: "legalName", label: "Legal Name", conditional: true },
    { key: "transactionId", label: "Transaction" },
    { key: "ucpathName", label: "UCPath Name", conditional: true },
    { key: "nameMatch", label: "Name Match", conditional: true },
    { key: "emplId", label: "EID" },
    { key: "eidResult", label: "Result" },
    { key: "approvalStatus", label: "Approval Status", conditional: true },
    { key: "effectiveDate", label: "Effective Date", conditional: true },
    { key: "sheet", label: "Roster Sheet" },
  ],
  getName: (data) => data.livedName || data.sheet || "",
  getId: (data) => data.transactionId || data.sheet || "",
  operatorSubject: (input) =>
    isProcessEidPersonInput(input)
      ? buildOperatorSubject({ kind: "person", value: input.livedName })
      : buildOperatorSubject({ kind: "roster", value: processEidSheetLabel(input) }),
  initialData: (input) =>
    isProcessEidPersonInput(input)
      ? {
          livedName: input.livedName,
          ...(input.legalName ? { legalName: input.legalName } : {}),
          transactionId: input.transactionId,
          rosterRow: String(input.rosterRow),
          sheet: input.sheet,
          ...operatorSubjectData(
            buildOperatorSubject({ kind: "person", value: input.livedName }),
          ),
        }
      : {
          sheet: processEidSheetLabel(input),
          ...operatorSubjectData(
            buildOperatorSubject({
              kind: "roster",
              value: processEidSheetLabel(input),
            }),
          ),
        },
  deriveItemId: (input) =>
    isProcessEidPersonInput(input)
      ? `${input.sheet}:${input.rosterRow}:${input.transactionId}`
      : processEidSheetLabel(input),
  handler: handleProcessEid,
});

export async function handleProcessEid(
  ctx: Ctx<typeof steps, ProcessEidInput>,
  input: ProcessEidInput,
): Promise<void> {
  if (!isProcessEidPersonInput(input)) {
    throw new Error(
      `Process EID sheet input "${processEidSheetLabel(input)}" must be expanded before daemon execution`,
    );
  }
  await ctx.step("lookup-eid", async () => {
    // A roster defect this row cannot be looked up around (a transaction number
    // shared with another row) fails here, before any UCPath search — the other
    // rows in the same run are unaffected.
    if (input.rosterConflict) throw new Error(input.rosterConflict);

    const page = await ctx.page("ucpath");
    const result = await findTransactionEidByTransactionId(page, {
      transactionId: input.transactionId,
    });
    const eidResult = deriveProcessEidResult(result);
    const verdict = result.transactionFound
      ? verifyUcpathTransactionName(result.ucpathName, input)
      : undefined;

    ctx.updateData({
      livedName: input.livedName,
      ...(input.legalName ? { legalName: input.legalName } : {}),
      transactionId: input.transactionId,
      rosterRow: String(input.rosterRow),
      sheet: input.sheet,
      ucpathName: result.ucpathName,
      ...(verdict ? { nameMatch: verdict.label } : {}),
      emplId: verdict?.matched ? result.eid : "",
      eidResult: verdict && !verdict.matched ? "Not found" : eidResult,
      approvalStatus: result.approvalStatus,
      effectiveDate: result.effectiveDate,
    });
    await ctx.captureAndStampScreenshot(
      `process-eid-${eidResult.toLowerCase().replace(/\s+/g, "-")}`,
      "processEidScreenshot",
      { systems: ["ucpath"] },
    );

    // Name proof AFTER the screenshot so the mismatch is evidenced, not just
    // asserted: the operator sees the UCPath page the mismatch was read from.
    if (verdict && !verdict.matched) {
      throw new Error(
        processEidNameMismatchMessage({
          transactionId: input.transactionId,
          ucpathName: result.ucpathName,
          livedName: input.livedName,
          legalName: input.legalName,
        }),
      );
    }
  });
}

export async function runProcessEid(
  input: ProcessEidPersonInput,
): Promise<void> {
  await runWorkflow(processEidWorkflow, input);
}
