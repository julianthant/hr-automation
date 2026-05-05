import { dateLocal, type TrackerEntry } from "../jsonl.js";
import { countRecords, isPrepEntry, isReadyForReview, previewSummary } from "./prep-rows.js";

/** One row in the navbar approval inbox. See frontend types.ts for the full JSDoc. */
export interface PreviewInboxRow {
  workflow: string;
  id: string;
  runId: string;
  /** Display name - typically the original PDF filename. */
  summary: string;
  /** ISO timestamp of the latest tracker entry for this row. */
  ts: string;
  /** Tracker date (YYYY-MM-DD) so the dashboard can deep-link. */
  date: string;
  /** Optional record-count hint (emergency-contact prep parent rows have it). */
  recordCount?: number;
}

export interface PreviewInboxDeps {
  listWorkflows: () => string[];
  listDates: (workflow: string) => string[];
  readEntriesForDate: (workflow: string, date: string) => TrackerEntry[];
}

const PREVIEW_INBOX_DAYS = 7;

/**
 * Cross-workflow approval-inbox handler. Surfaces preview-row tracker
 * entries (`data.mode === "prepare"`) whose latest entry has reached
 * `done` status without being approved or discarded.
 *
 * Discriminator (universal - any workflow that adopts the `data.mode === "prepare"`
 * parent-row pattern is automatically picked up):
 *   - `data.mode === "prepare"` (any entry in the run carries this)
 *   - latest entry's `status === "done"`
 *   - latest entry's `step !== "approved"` AND `step !== "discarded"`
 *
 * Scans the last 7 days. Sorts newest first.
 */
export function buildPreviewInboxHandler(deps: PreviewInboxDeps) {
  return (): PreviewInboxRow[] => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - PREVIEW_INBOX_DAYS);
    const cutoffStr = dateLocal(cutoff);

    // Aggregate by (workflow, id, runId). Keep the latest entry per key.
    type Bucket = { latest: TrackerEntry; date: string };
    const byRun = new Map<string, Bucket>();

    for (const wf of deps.listWorkflows()) {
      for (const date of deps.listDates(wf)) {
        if (date < cutoffStr) continue;
        for (const e of deps.readEntriesForDate(wf, date)) {
          if (!isPrepEntry(e)) continue;
          const runId = e.runId || `${e.id}#1`;
          const key = `${wf}::${e.id}::${runId}`;
          const prev = byRun.get(key);
          if (!prev || e.timestamp >= prev.latest.timestamp) {
            byRun.set(key, { latest: e, date });
          }
        }
      }
    }

    const rows: PreviewInboxRow[] = [];
    for (const { latest, date } of byRun.values()) {
      if (!isReadyForReview(latest)) continue;
      rows.push({
        workflow: latest.workflow,
        id: latest.id,
        runId: latest.runId || `${latest.id}#1`,
        summary: previewSummary(latest),
        ts: latest.timestamp,
        date,
        recordCount: countRecords(latest),
      });
    }

    rows.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return rows;
  };
}
