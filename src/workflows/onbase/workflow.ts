import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { OnbaseInputSchema, type OnbaseInput } from "./schema.js";
import { onbaseHandler, onbaseSteps } from "./handler.js";

const WORKFLOW = "onbase";

export { onbaseSteps, type OnbaseSteps } from "./handler.js";

/**
 * OnBase runtime policy.
 *
 * OnBase imports are fanned out from OCR approval as `operation-member` rows
 * under the OnBase operation coordinator. Like emergency-contact: member rows
 * title by person (employee), and the delegated OCR prep row titles by PDF
 * filename.
 */
export const ONBASE_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  prepRow: {
    titleSource: "pdf-original-name",
  },
};

/**
 * Kernel definition for the OnBase document-import workflow.
 *
 * One run = one person = one page of the combined PDF. The OCR approve fan-out
 * enqueues one of these per approved record (stamped `operation-member` under
 * the OnBase operation coordinator). `betweenItems: ["reset"]` resets the
 * OnBase browser to about:blank between people so a stuck import form from
 * person N doesn't leak into person N+1.
 *
 * `deferAuth` + `authSteps: false`: the fan-out child only Duos at the
 * `authenticate` step, AFTER OCR approval, so the operator isn't prompted
 * before reviewing OCR results (mirrors emergency-contact / oath-signature).
 */
export const onbaseWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "OnBase Import",
  archetype: "batch",
  inputSubject: "eid",
  code: "ob",
  category: "Onboarding",
  iconName: "FileStack",
  systems: [
    {
      id: "onbase",
      deferAuth: true,
    },
  ],
  authSteps: false,
  steps: onbaseSteps,
  schema: OnbaseInputSchema,
  runtimePolicy: ONBASE_WORKFLOW_RUNTIME_POLICY,
  queueTitle: { kind: "single" },
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "employeeName", label: "Employee" },
    { key: "ucpathId", label: "UCPath ID" },
    { key: "documentType", label: "Document Type" },
    { key: "sourcePage", label: "Page" },
    { key: "keysetAutofilled", label: "Keyset autofill", conditional: true },
    { key: "status", label: "Status", conditional: true },
  ],
  getName: (d) => d.employeeName || d.ucpathId || "",
  getId: (d) => d.ucpathId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "person",
      value: input.employeeName || input.ucpathId,
      prefix: "OnBase",
    }),
  handler: async (ctx, input) => {
    await onbaseHandler(ctx, input);
  },
});

/** In-process single-run entry (tests + composition). */
export async function runOnbase(input: OnbaseInput): Promise<void> {
  try {
    await runWorkflow(onbaseWorkflow, input);
    log.success("onbase workflow completed");
  } catch (err) {
    log.error(`onbase failed: ${errorMessage(err)}`);
    throw err;
  }
}

/** Internal daemon-mode adapter used by the OCR approve fan-out. */
export const runOnbaseCli = buildCliAdapter<[OnbaseInput[]], OnbaseInput>({
  workflow: onbaseWorkflow,
  emptyMessage: "runOnbaseCli: no inputs provided",
  buildInputs: (inputs) => inputs,
  deriveItemId: (input) => input.ucpathId,
  buildPendingData: (input) => ({
    ucpathId: input.ucpathId,
    employeeName: input.employeeName ?? "",
    documentType: input.documentType,
    sourcePage: String(input.sourcePage),
    ...(input.pdfOriginalName ? { pdfOriginalName: input.pdfOriginalName } : {}),
    ...(input.dryRun ? { dryRun: "true" } : {}),
  }),
});
