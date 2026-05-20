import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToServiceNow } from "../../infra/auth/login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import {
  DEFAULT_WORKFLOW_RUNTIME_POLICY,
  workflowAction,
} from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { OathUploadInputSchema, type OathUploadInput } from "./schema.js";
import { oathUploadHandler, oathUploadSteps } from "./handler.js";

/**
 * Oath Upload runtime policy.
 *
 * The root Oath Upload row is the same tracker row through every child
 * delegation (OCR prep → signatures → ServiceNow submit). Approval
 * dependencies use `block_parent`, so a failed signature child blocks
 * the parent until retried or cancelled. Tree-wide cancel must be
 * explicit — group/row cancel never reaches descendant signature rows.
 */
export const OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  rowActions: [
    workflowAction("cancel", "tree", "queue-panel", "Cancel workflow tree"),
  ],
  delegation: {
    rootRowPersistsThroughChildren: true,
    failedChildBlocksParent: true,
    cancelScope: "tree",
  },
};

const WORKFLOW = "oath-upload";

export { oathUploadSteps, type OathUploadSteps } from "./handler.js";

export const oathUploadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Upload",
  archetype: "delegating-batch",
  category: "Onboarding",
  iconName: "UploadCloud",
  systems: [
    {
      id: "servicenow",
      login: async (page, instance, context) => {
        const ok = await loginToServiceNow(page, instance, context?.abortSignal);
        if (!ok) throw new Error("ServiceNow authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: oathUploadSteps,
  schema: OathUploadInputSchema,
  runtimePolicy: OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY,
  authChain: "sequential",
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "pdfOriginalName", label: "PDF" },
    { key: "ocrSessionId",    label: "OCR session" },
    { key: "signerCount",     label: "Signers" },
    { key: "ticketNumber",    label: "HR ticket #" },
    { key: "submittedAt",     label: "Filed" },
    { key: "status",          label: "Status" },
  ],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "pdf",
      value: input.pdfOriginalName ?? input.pdfPath ?? input.sessionId,
      prefix: "Oath Upload",
    }),
  handler: async (ctx, input) => {
    ctx.markStep("servicenow-auth");
    await ctx.page("servicenow");
    await oathUploadHandler(ctx, input);
  },
});

/** In-process single-run entry (tests + composition). */
export async function runOathUpload(input: OathUploadInput): Promise<void> {
  try {
    await runWorkflow(oathUploadWorkflow, input);
    log.success("oath-upload workflow completed");
  } catch (err) {
    log.error(`oath-upload failed: ${errorMessage(err)}`);
    throw err;
  }
}

/** Daemon-mode CLI adapter. */
export const runOathUploadCli = buildCliAdapter<[OathUploadInput[]], OathUploadInput>({
  workflow: oathUploadWorkflow,
  emptyMessage: "runOathUploadCli: no inputs provided",
  buildInputs: (inputs) => inputs,
  deriveItemId: (input) => input.sessionId,
  buildPendingData: (input) => ({
    pdfPath: input.pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    sessionId: input.sessionId,
    pdfHash: input.pdfHash,
    ...(input.dryRun ? { dryRun: "true" } : {}),
  }),
});
