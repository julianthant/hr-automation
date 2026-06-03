import type { ScenarioBeat } from "../_runtime/index.js";
import type { OcrInput } from "../../../src/workflows/ocr/schema.js";

/**
 * Scripted beat sequence for a delegated OCR prep run, mirroring the shape the
 * real orchestrator drives through `ctx.reportPhase`: it walks the prep phases
 * and then SUSPENDS at `awaiting-approval` (`status: running`, not terminal)
 * until the operator approves or discards.
 *
 * The real orchestrator owns its own queue-row emissions (bypassing
 * `ctx.step`), so production rows carry richer `data` (records / page metadata).
 * For the dashboard-projection contract this scenario locks — archetype
 * (`preview`), derived status (`needsReview`), surface placement, and the
 * group-anchor trace-id subtitle — the scripted `ctx.step` emissions produce the
 * same status/step/archetype/kind axes the projection reads. The `hold` on the
 * terminal `awaiting-approval` step keeps the run parked at
 * `running step=awaiting-approval` so the snapshot captures the needs-review
 * state exactly as the queue would render it mid-approval.
 */
export function ocrPrepBeats(
  input: Pick<OcrInput, "pdfOriginalName" | "sessionId" | "formType">,
  opts: { holdAtApproval?: boolean } = {},
): ScenarioBeat[] {
  return [
    {
      kind: "updateData",
      data: {
        // Mirror the orchestrator's prep-row identity so the projection sees a
        // recognizable OCR preview row (mode "prepare" + the PDF name).
        mode: "prepare",
        pdfOriginalName: input.pdfOriginalName,
        sessionId: input.sessionId,
        formType: input.formType,
        recordCount: 1,
      },
    },
    { kind: "markStep", name: "loading-roster" },
    { kind: "markStep", name: "ocr" },
    { kind: "markStep", name: "matching" },
    { kind: "markStep", name: "person-lookup" },
    { kind: "markStep", name: "verification" },
    {
      kind: "step",
      name: "awaiting-approval",
      // Park the run at `running step=awaiting-approval` so a snapshot taken
      // here captures the needs-review state (delegated OCR), exactly as the
      // queue renders it while the operator reviews.
      hold: opts.holdAtApproval === true,
    },
  ];
}
