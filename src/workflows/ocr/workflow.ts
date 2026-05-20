import { defineWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { runOcrOrchestrator } from "./orchestrator.js";
import { OcrInputSchema, type OcrInput } from "./schema.js";

/**
 * OCR runtime policy.
 *
 * Captures the dashboard rules that previously lived as inline special
 * cases (`isOcrDaemonPrepFanoutChild`, the log panel's `· Preview`
 * suffix, etc.):
 *  - Single PDF → approval-delegation surface with `Single delegation`,
 *    suffixed by `· Preview` when the preview tab is rendered.
 *  - Multiple PDFs → batch delegation over single-file prep rows.
 *  - OCR utility EID/active-check fan-out children stay as delegation
 *    members instead of being promoted to a batch-delegation group.
 *  - File-scope cancel routes through OCR discard so the prep run AND
 *    its delegated children are cleaned up together.
 */
export const OCR_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  delegation: {
    utilityChildSurface: "delegation-member",
    utilityChildWorkflows: ["eid-lookup", "active-check"],
    cancelScope: "tree",
    fileScopeCancelKind: "ocr-discard",
  },
  preview: {
    rowTypeLabelSuffix: "Preview",
    alwaysAvailable: true,
  },
  prepRow: {
    titleSource: "pdf-original-name",
  },
};

const ocrSteps = [
  "loading-roster",
  "ocr",
  "matching",
  "disambiguating",
  "eid-lookup",
  "verification",
  "awaiting-approval",
] as const;

export const ocrWorkflow = defineWorkflow({
  name: "ocr",
  label: "OCR",
  archetype: "delegating-batch",
  category: "Utils",
  iconName: "FileScan",
  systems: [],
  authSteps: false,
  steps: ocrSteps,
  schema: OcrInputSchema,
  runtimePolicy: OCR_WORKFLOW_RUNTIME_POLICY,
  queueTitle: {
    kind: "batch",
    labelFromInput: (input) => input.formType === "emergency-contact" ? "Emergency Contact" : "Oath",
  },
  authChain: "sequential",
  detailFields: [{ key: "recordCount", label: "Records" }],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "pdf",
      value: input.pdfOriginalName ?? input.pdfPath ?? input.sessionId,
      prefix: "OCR",
    }),
  handler: ocrKernelHandler,
});

async function ocrKernelHandler(ctx: Ctx<typeof ocrSteps, OcrInput>, input: OcrInput): Promise<void> {
  // Thin wrapper. Orchestrator owns its own tracker emissions because the
  // kernel's per-step machinery doesn't model "wait for user, mid-handler."
  await runOcrOrchestrator(input, { runId: ctx.runId, trackerDir: ctx.trackerDir });
}
