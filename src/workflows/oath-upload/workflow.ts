import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { OathUploadInputSchema, type OathUploadInput } from "./schema.js";
import { oathUploadHandler, oathUploadSteps } from "./handler.js";

/**
 * Oath Upload runtime policy.
 *
 * The Oath Upload row is a single, top-level row in the oath-upload tab.
 * OCR now fans out signer rows separately; oath-upload waits for those
 * cross-daemon child rows, then files the HR ticket after every signer finishes.
 *
 * Cancel is TREE-scoped: a full-mode ticket owns a delegated OCR prep
 * (born-at-upload, `parentRunId` = the ticket run), so cancelling the ticket
 * must unwind the prep + its lookup descendants too — a row-scoped cancel
 * left the OCR review orphaned at awaiting-approval for a cancelled parent
 * (E2E-010).
 */
export const OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  rowActions: DEFAULT_WORKFLOW_RUNTIME_POLICY.rowActions.map((action) =>
    action.kind === "cancel"
      ? { ...action, scope: "tree" as const, label: "Cancel workflow tree" }
      : action,
  ),
};

const WORKFLOW = "oath-upload";

export { oathUploadSteps, type OathUploadSteps } from "./handler.js";

export const oathUploadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Upload",
  archetype: "single",
  inputSubject: "pdf",
  code: "ou",
  category: "Onboarding",
  iconName: "UploadCloud",
  systems: [
    {
      id: "servicenow",
      // deferAuth: real ServiceNow authentication is deferred to the handler's
      // `servicenow-auth` step, AFTER signature delegation completes — so we
      // don't hold an authenticated SAML session open across the (potentially
      // multi-day) operator-approval + per-signer wait, and authentication
      // failures don't kill the workflow before delegation even starts.
      deferAuth: true,
    },
  ],
  authSteps: false,
  steps: oathUploadSteps,
  schema: OathUploadInputSchema,
  runtimePolicy: OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY,
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "pdfOriginalName", label: "PDF" },
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

/** Internal daemon-mode adapter used by the dashboard upload endpoint. */
export const runOathUploadCli = buildCliAdapter<[OathUploadInput[]], OathUploadInput>({
  workflow: oathUploadWorkflow,
  emptyMessage: "runOathUploadCli: no inputs provided",
  buildInputs: (inputs) => inputs,
  deriveItemId: (input) => input.sessionId,
  buildPendingData: (input) => ({
    ...(input.pdfPath ? { pdfPath: input.pdfPath } : {}),
    pdfOriginalName: input.pdfOriginalName,
    sessionId: input.sessionId,
    ...(input.pdfHash ? { pdfHash: input.pdfHash } : {}),
    ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
    ...(input.dryRun ? { dryRun: "true" } : {}),
  }),
});
