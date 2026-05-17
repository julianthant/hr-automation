import { defineWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/kernel/types.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { runOcrOrchestrator } from "./orchestrator.js";
import { OcrInputSchema, type OcrInput } from "./schema.js";

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
