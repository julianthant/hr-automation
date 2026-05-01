import { defineWorkflow } from "../../core/index.js";
import type { Ctx } from "../../core/types.js";
import { runOcrOrchestrator } from "./orchestrator.js";
import { OcrInputSchema, type OcrInput } from "./schema.js";

const ocrSteps = [
  "loading-roster",
  "ocr",
  "matching",
  "eid-lookup",
  "verification",
  "awaiting-approval",
] as const;

export const ocrWorkflow = defineWorkflow({
  name: "ocr",
  label: "OCR",
  systems: [],
  authSteps: false,
  steps: ocrSteps,
  schema: OcrInputSchema,
  authChain: "sequential",
  detailFields: [
    { key: "formType",        label: "Form" },
    { key: "pdfOriginalName", label: "PDF" },
    { key: "recordCount",     label: "Records" },
    { key: "verifiedCount",   label: "Verified" },
  ],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  handler: ocrKernelHandler,
});

async function ocrKernelHandler(ctx: Ctx<typeof ocrSteps, OcrInput>, input: OcrInput): Promise<void> {
  // Thin wrapper. Orchestrator owns its own tracker emissions because the
  // kernel's per-step machinery doesn't model "wait for user, mid-handler."
  await runOcrOrchestrator(input, { runId: ctx.runId });
}
