import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { trackEvent, dateLocal } from "../../jsonl.js";
import type { TrackerEntry } from "../../jsonl.js";

const WORKFLOW = "ocr";

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOcrRows(trackerDir: string): void {
  const date = dateLocal();
  const file = join(trackerDir, `ocr-${date}.jsonl`);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const latestById = new Map<string, TrackerEntry>();
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      const key = `${e.id}#${e.runId}`;
      latestById.set(key, e);
    } catch { /* tolerate */ }
  }
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
        },
        trackerDir,
      );
    }
  }
}
