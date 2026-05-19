import { trackEvent, readLatestTrackerEntriesByRunKey } from "../../jsonl.js";

const WORKFLOW = "ocr";

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOcrRows(trackerDir: string): void {
  const latestById = readLatestTrackerEntriesByRunKey(WORKFLOW, trackerDir);
  for (const e of latestById.values()) {
    if (e.status === "pending" || e.status === "running") {
      trackEvent(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: e.id,
          runId: e.runId,
          ...(e.parentRunId ? { parentRunId: e.parentRunId } : {}),
          status: "failed",
          error: "Dashboard restarted while OCR was in progress — please re-upload",
          ...(e.data ? { data: { ...e.data } } : {}),
        },
        trackerDir,
      );
    }
  }
}
