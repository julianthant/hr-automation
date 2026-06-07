import { emitTrackerRow, readLatestTrackerEntriesByRunKey } from "../../jsonl.js";
import { resolveRowArchetype } from "../../../domain/row-archetype.js";

const WORKFLOW = "ocr";

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOcrRows(trackerDir: string): void {
  const latestById = readLatestTrackerEntriesByRunKey(WORKFLOW, trackerDir);
  for (const e of latestById.values()) {
    if (e.status === "pending" || e.status === "running") {
      // Inherit archetype from the stuck row so the sweep marker matches
      // the row type it's replacing (normally "preview" for OCR, but
      // we route through resolveRowArchetype so this code stays generic).
      const archetype = resolveRowArchetype(e);
      emitTrackerRow(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: e.id,
          ...(e.runId ? { runId: e.runId } : {}),
          ...(e.parentRunId ? { parentRunId: e.parentRunId } : {}),
          status: "failed",
          // Preserve the step the run had actually reached so the step pipeline
          // marks the failure on the real phase (e.g. `ocr`) instead of snapping
          // its "failed + unknown step → step 0" fallback back to `loading-roster`.
          // A row swept while still step-less (e.g. `pending`) carries no step and
          // legitimately keeps the step-0 fallback.
          ...(e.step ? { step: e.step } : {}),
          error: "Dashboard restarted while OCR was in progress — please re-upload",
          data: { ...(e.data ?? {}), archetype },
        },
        trackerDir,
      );
    }
  }
}
