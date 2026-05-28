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
          error: "Dashboard restarted while OCR was in progress — please re-upload",
          data: { ...(e.data ?? {}), archetype },
        },
        trackerDir,
      );
    }
  }
}
