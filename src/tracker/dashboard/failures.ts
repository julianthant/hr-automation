import { getRunIdOr, type TrackerEntry } from "../jsonl.js";
import { isResolvedPrepEntry } from "./prep-rows.js";
import { buildSearchSummary } from "./search.js";

/** One row in the failure-bell popover. Returned by GET /api/failures. */
export interface FailureRow {
  workflow: string;
  id: string;
  runId: string;
  summary: string;
  error: string;
  ts: string;
  date: string;
}

export interface FailuresDeps {
  listWorkflows: () => string[];
  readEntriesForDate: (workflow: string, date: string) => TrackerEntry[];
}

const FAILURES_LIMIT = 50;

/**
 * Returns failed tracker entries for a given date across all workflows.
 * Latest run per id wins (so a retry that succeeded won't appear in the
 * failure list). Sorted newest first, capped at FAILURES_LIMIT rows.
 */
export function buildFailuresHandler(deps: FailuresDeps) {
  return (opts: { date: string; limit?: number }): FailureRow[] => {
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : FAILURES_LIMIT;
    const failures: FailureRow[] = [];
    for (const wf of deps.listWorkflows()) {
      const all = deps.readEntriesForDate(wf, opts.date);
      // Aggregate by (id, runId) -> latest entry per run.
      const latestPerRun = new Map<string, TrackerEntry>();
      for (const e of all) {
        const runId = getRunIdOr(e);
        const key = `${e.id}::${runId}`;
        const prev = latestPerRun.get(key);
        if (!prev || e.timestamp >= prev.timestamp) latestPerRun.set(key, e);
      }
      // Per id, keep the latest run.
      const latestRunPerId = new Map<string, TrackerEntry>();
      for (const e of latestPerRun.values()) {
        const prev = latestRunPerId.get(e.id);
        if (!prev || e.timestamp >= prev.timestamp) latestRunPerId.set(e.id, e);
      }
      for (const e of latestRunPerId.values()) {
        if (e.status !== "failed") continue;
        // Resolved prep rows (operator-discarded) shouldn't surface as
        // failures - they're audit-only at that point. Mirrors the
        // QueuePanel's `isResolvedPrepRow` predicate.
        if (isResolvedPrepEntry(e)) continue;
        failures.push({
          workflow: wf,
          id: e.id,
          runId: getRunIdOr(e),
          summary: buildSearchSummary(e),
          error: e.error || "Unknown error",
          ts: e.timestamp,
          date: opts.date,
        });
      }
    }
    failures.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return failures.slice(0, limit);
  };
}

/**
 * Count distinct ids whose latest run's latest entry is `failed`.
 * Pure helper so the navbar failure-bell badge can be unit-tested
 * independent of the SSE handler.
 */
export function computeFailureCounts(entries: TrackerEntry[]): number {
  // Aggregate by (id, runId) -> latest entry per run.
  const latestPerRun = new Map<string, TrackerEntry>();
  for (const e of entries) {
    const runId = getRunIdOr(e);
    const key = `${e.id}::${runId}`;
    const prev = latestPerRun.get(key);
    if (!prev || e.timestamp >= prev.timestamp) latestPerRun.set(key, e);
  }
  // For each id, find the latest run.
  const latestRunPerId = new Map<string, TrackerEntry>();
  for (const e of latestPerRun.values()) {
    const prev = latestRunPerId.get(e.id);
    if (!prev || e.timestamp >= prev.timestamp) latestRunPerId.set(e.id, e);
  }
  let count = 0;
  for (const e of latestRunPerId.values()) {
    if (e.status !== "failed") continue;
    // Discarded prep rows (`failed`+`discarded`) are operator-resolved and
    // shouldn't inflate the navbar failure-bell badge.
    if (isResolvedPrepEntry(e)) continue;
    count++;
  }
  return count;
}
