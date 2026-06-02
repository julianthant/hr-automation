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
 * Its `delegate-signatures` step delegates one PDF run to oath-signature,
 * then files the HR ticket after the delegated batch completes.
 */
export const OATH_UPLOAD_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  subtitleTemplate: "Oath · <last4 run id>",
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
      // No-op at session-launch time. We defer real ServiceNow authentication
      // until the handler's `servicenow-auth` step, AFTER signature delegation
      // completes — so we don't hold an authenticated SAML
      // session open across the (potentially multi-day) operator-approval +
      // per-signer wait, and so authentication failures don't kill the
      // workflow before the delegation can even start.
      login: async () => {},
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
