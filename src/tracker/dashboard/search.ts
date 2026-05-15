import { queueStatusDisplayLabel } from "../../domain/tracker-terminal-display.js";
import { dateLocal, getRunIdOr, type TrackerEntry } from "../jsonl.js";
import { isResolvedPrepEntry } from "./prep-rows.js";

/**
 * One hit in the cross-date search. Keeps the shape thin so the frontend
 * dropdown can render quickly without needing another round-trip.
 */
export interface SearchResultRow {
  workflow: string;
  id: string;
  runId: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  /** Latest timestamp seen for this (workflow, id, runId). */
  lastTs: string;
  /** Date bucket (YYYY-MM-DD) the match lives in - used by the UI to deep-link. */
  date: string;
  /** Compact one-line summary (name / doc id / email). Never empty. */
  summary: string;
  /** Queue/search pill text — matches {@link queueStatusDisplayLabel}. */
  displayStatus: string;
}

/**
 * Narrow reader-bundle shape the search handler depends on. Lets tests inject
 * in-memory fixtures instead of touching disk - matches the factory style used
 * by `buildScreenshotsHandler` / `buildSelectorWarningsHandler`.
 */
export interface SearchDeps {
  /** List workflows that have JSONL data (filters to known files). */
  listWorkflows: () => string[];
  /** List YYYY-MM-DD dates with entries for `wf`, newest first. */
  listDates: (wf: string) => string[];
  /** Read entries for a specific (wf, date) bucket. */
  readEntriesForDate: (wf: string, date: string) => TrackerEntry[];
}

/**
 * Fields on `data` the search matches against, in priority order. Priority
 * governs which value gets used for the result's summary string when multiple
 * match - emplId / docId outrank names because the operator can recognize a
 * record by its id even without a name.
 */
const SEARCH_FIELDS = [
  "emplId",
  "docId",
  "email",
  "firstName",
  "lastName",
  "name",
] as const;

/**
 * Build the `summary` cell for a search row. Prefers a human-readable name
 * (first + last or name), falls back to docId / email / emplId / id. Kept as a
 * pure helper so the unit test can exercise the precedence order without
 * going through the handler.
 */
export function buildSearchSummary(entry: TrackerEntry): string {
  const d = entry.data ?? {};
  const name = (d.__name || d.name || "").trim()
    || `${(d.firstName || "").trim()} ${(d.lastName || "").trim()}`.trim();
  if (name) return name;
  if (d.docId) return d.docId;
  if (d.email) return d.email;
  if (d.emplId) return d.emplId;
  return entry.id;
}

/**
 * Factory for the cross-date search handler. Scans `days` calendar days
 * (default 30) across either a single workflow or all workflows, filters
 * entries where {id, runId, or any of SEARCH_FIELDS on `data`} contain `q`
 * case-insensitively, and returns the top `limit` matches sorted by lastTs
 * desc.
 *
 * Entries are aggregated per (workflow, id) - only the latest entry across
 * all runs for that id survives into the result list. The result row's
 * `runId` and `status` reflect the most recent run, so the dropdown shows
 * one row per doc/email/emplId pointing at the last attempt.
 *
 * Deps are injected so unit tests can feed in-memory JSONL fixtures without
 * hitting disk.
 */
export function buildSearchHandler(deps: SearchDeps) {
  return (
    q: string,
    opts: { workflow?: string; limit?: number; days?: number } = {},
  ): SearchResultRow[] => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50;
    const days = opts.days && opts.days > 0 ? Math.floor(opts.days) : 30;

    // Target workflow list: single (if scoped) or every known workflow.
    const targetWorkflows = opts.workflow
      ? [opts.workflow]
      : deps.listWorkflows();

    // Cut-off date (YYYY-MM-DD). Strings compare lexicographically for
    // ISO dates, which is what we want here.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffStr = dateLocal(cutoff);

    // Latest-per-id aggregation. Key: `${workflow}::${id}`. Multiple runs
    // for the same id collapse into one row whose runId/status reflect
    // the most recent attempt. We carry the underlying entry so we can
    // post-filter resolved prep rows after the fold (they shouldn't show
    // up as recent results - the operator already approved or discarded
    // them).
    const byId = new Map<
      string,
      { row: SearchResultRow; ts: string; entry: TrackerEntry }
    >();

    const matches = (entry: TrackerEntry): boolean => {
      if (entry.id.toLowerCase().includes(query)) return true;
      if (entry.runId && entry.runId.toLowerCase().includes(query)) return true;
      const d = entry.data ?? {};
      for (const field of SEARCH_FIELDS) {
        const v = d[field];
        if (v && v.toLowerCase().includes(query)) return true;
      }
      // Also match the server-computed __name which carries first+last.
      if (d.__name && d.__name.toLowerCase().includes(query)) return true;
      return false;
    };

    for (const wf of targetWorkflows) {
      const dates = deps.listDates(wf);
      for (const date of dates) {
        if (date < cutoffStr) continue;
        const entries = deps.readEntriesForDate(wf, date);
        for (const e of entries) {
          if (!matches(e)) continue;
          const runId = getRunIdOr(e);
          const key = `${wf}::${e.id}`;
          const prev = byId.get(key);
          // Keep the latest entry for this id across all runs. Ties by
          // timestamp break toward the first-seen - append-only JSONL
          // guarantees later entries reflect the newest state.
          if (!prev || e.timestamp >= prev.ts) {
            byId.set(key, {
              ts: e.timestamp,
              entry: e,
              row: {
                workflow: wf,
                id: e.id,
                runId,
                status: e.status,
                lastTs: e.timestamp,
                date,
                summary: buildSearchSummary(e),
                displayStatus: queueStatusDisplayLabel({
                  workflow: wf,
                  status: e.status,
                  data: e.data,
                }),
              },
            });
          }
        }
      }
    }

    // Resolved prep rows (operator approved or discarded) shouldn't surface
    // in search - they're audit-only at that point. Mirrors the frontend's
    // `isResolvedPrepRow` predicate in QueuePanel via `isResolvedPrepEntry`.
    return [...byId.values()]
      .filter((x) => !isResolvedPrepEntry(x.entry))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, limit)
      .map((x) => x.row);
  };
}
