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
  findTransactionEidByName,
  type TransactionEidLookupResult,
} from "../../systems/ucpath/ss-smart-hr.js";
import { loadProcessEidCandidates } from "./roster.js";
import {
  ProcessEidInputSchema,
  isProcessEidPersonInput,
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
    { key: "transactionId", label: "Transaction" },
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
      : buildOperatorSubject({ kind: "roster", value: input.sheet }),
  initialData: (input) =>
    isProcessEidPersonInput(input)
      ? {
          livedName: input.livedName,
          transactionId: input.transactionId,
          rosterRow: String(input.rosterRow),
          sheet: input.sheet,
          ...operatorSubjectData(
            buildOperatorSubject({ kind: "person", value: input.livedName }),
          ),
        }
      : {
          sheet: input.sheet,
          ...operatorSubjectData(
            buildOperatorSubject({ kind: "roster", value: input.sheet }),
          ),
        },
  deriveItemId: (input) =>
    isProcessEidPersonInput(input)
      ? `${input.sheet}:${input.rosterRow}:${input.transactionId}`
      : input.sheet,
  handler: handleProcessEid,
});

export async function handleProcessEid(
  ctx: Ctx<typeof steps, ProcessEidInput>,
  input: ProcessEidInput,
): Promise<void> {
  if (!isProcessEidPersonInput(input)) {
    throw new Error(
      `Process EID sheet input "${input.sheet}" must be expanded before daemon execution`,
    );
  }
  await ctx.step("lookup-eid", async () => {
    const page = await ctx.page("ucpath");
    const result = await findTransactionEidByName(page, {
      livedName: input.livedName,
      transactionId: input.transactionId,
    });
    const eidResult = deriveProcessEidResult(result);
    ctx.updateData({
      livedName: input.livedName,
      transactionId: input.transactionId,
      rosterRow: String(input.rosterRow),
      sheet: input.sheet,
      emplId: result.eid,
      eidResult,
      approvalStatus: result.approvalStatus,
      effectiveDate: result.effectiveDate,
    });
    await ctx.captureAndStampScreenshot(
      `process-eid-${eidResult.toLowerCase().replace(/\s+/g, "-")}`,
      "processEidScreenshot",
      { systems: ["ucpath"] },
    );
  });
}

export async function runProcessEid(
  input: ProcessEidPersonInput,
): Promise<void> {
  await runWorkflow(processEidWorkflow, input);
}
