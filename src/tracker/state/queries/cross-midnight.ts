import type { Database } from "../../../infra/sqlite/index.js";
import type { LogEntryRow, RunEventRow } from "../types.js";
import { dateLocal, type TrackerEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, readStmts } from "./statements.js";

/**
 * Cross-midnight forward-merge primitives, shared by every date-scoped per-run
 * reader (the queue card, the RunSelector summary, the run-event timeline, and
 * the log panel).
 *
 * Tracker rows are partitioned by the local calendar day they are WRITTEN
 * (`tracker_date`), and so is the SQLite projection. A run that starts before
 * local midnight but keeps emitting after it (a long Duo wait, a parked OCR
 * review, a cancel/approve/complete the next day) writes its later rows into a
 * LATER partition. A reader scoped to the run's start day would then miss those
 * rows and show the run stuck at its last pre-midnight state — e.g. "Running"
 * with a live timer forever, even after it was cancelled.
 *
 * The canonical fix is at the READ layer (writers stay trivial: "always append
 * now"): for any run whose latest status on `date` is non-terminal (still
 * OPEN), pull its continuation rows from partitions in `(date, today]` and fold
 * them into the reader's output. The reader's own latest-wins dedupe then
 * collapses the run to its real terminal state. No-op when viewing today (a run
 * cannot continue into a partition before its own start day) — keeps the hot
 * path free of the extra query.
 *
 * The OPEN gate (latest status non-terminal on `date`) is what makes the
 * bounded `(date, today]` window safe against run_id reuse: a run that already
 * terminated on `date` is excluded, so a later run that happens to reuse its id
 * never bleeds backwards.
 */

export const TERMINAL_STATUSES: ReadonlySet<TrackerEntry["status"]> = new Set([
  "done",
  "failed",
  "skipped",
]);

/**
 * Whether `date` could have cross-midnight continuations to merge: only a PAST
 * day can (a run cannot continue into a partition before its start day, and
 * "today" has no later partition yet). Centralizes the `date >= today` short
 * circuit every reader shares.
 */
export function dateCanHaveContinuation(date: string, today: string = dateLocal()): boolean {
  return date < today;
}

/**
 * From rows ordered event-ascending, return the run ids whose LATEST status is
 * non-terminal (still open) — the only runs eligible for a forward merge. Rows
 * with an unrecognized status are treated as open (defensive: better to over-
 * fetch a continuation than to strand a run stuck-running).
 */
export function openRunIdsFromEvents(rows: Array<{ run_id: string; status: string }>): string[] {
  const latestStatusByRun = new Map<string, string>();
  for (const row of rows) latestStatusByRun.set(row.run_id, row.status);
  const open: string[] = [];
  for (const [runId, status] of latestStatusByRun) {
    if (!TERMINAL_STATUSES.has(status as TrackerEntry["status"])) open.push(runId);
  }
  return open;
}

/**
 * Continuation run_event rows joined with their `runs` aggregates (start
 * timestamps, ordinal, log bounds), for the given open runs, from partitions in
 * `(date, today]`. The join shape carries everything a card/summary needs to
 * keep the run's elapsed span and terminal log bounds. Invalid-status rows are
 * dropped with a warning. Empty unless viewing a past day with ≥1 open run.
 */
export interface CrossMidnightEventRow {
  id: number;
  workflow: string;
  event_ts: string;
  item_id: string;
  run_id: string;
  parent_run_id: string | null;
  status: TrackerEntry["status"];
  step: string | null;
  data_json: string | null;
  typed_data_json: string | null;
  input_json: string | null;
  error: string | null;
  first_log_ts: string | null;
  last_log_ts: string | null;
  last_log_message: string | null;
  run_ordinal: number;
  screenshot_count: number;
  first_any_ts: string;
  first_work_ts: string | null;
  latest_tracker_ts: string;
}
type RawCrossMidnightEventRow = Omit<CrossMidnightEventRow, "status"> & { status: unknown };

export function selectCrossMidnightEventRowsWithRuns(
  db: Database,
  args: { workflow: string; date: string; openRunIds: string[]; today?: string },
): CrossMidnightEventRow[] {
  const today = args.today ?? dateLocal();
  if (!dateCanHaveContinuation(args.date, today) || args.openRunIds.length === 0) return [];
  const raw = readStmts(db).selectRunEventsWithRunsAfterDateForRuns.all({
    workflow: args.workflow,
    date: args.date,
    today,
    runIds: JSON.stringify(args.openRunIds),
  }) as RawCrossMidnightEventRow[];
  const out: CrossMidnightEventRow[] = [];
  for (const row of raw) {
    if (isTrackerStatus(row.status)) {
      out.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] selectCrossMidnightEventRowsWithRuns: dropping continuation row with unknown status workflow=${row.workflow} itemId=${row.item_id} runId=${row.run_id} status=${String(row.status)}`,
      );
    }
  }
  return out;
}

/**
 * Continuation run_event rows (plain `RunEventRow`, no runs join) for the given
 * open runs, from partitions in `(date, today]`. For the run-event timeline,
 * which maps raw `RunEventRow`s to wire entries and does not need the runs
 * aggregates.
 */
export function selectCrossMidnightRunEventRows(
  db: Database,
  args: { workflow: string; date: string; openRunIds: string[]; today?: string },
): RunEventRow[] {
  const today = args.today ?? dateLocal();
  if (!dateCanHaveContinuation(args.date, today) || args.openRunIds.length === 0) return [];
  return readStmts(db).selectRunEventsAfterDateForRuns.all({
    workflow: args.workflow,
    date: args.date,
    today,
    runIds: JSON.stringify(args.openRunIds),
  }) as RunEventRow[];
}

/**
 * Merge two ordered slices, sort by the caller-supplied ms extractor (with
 * row id as tiebreak), and cap at `limit`. Shared by every per-run reader that
 * forward-merges cross-midnight continuation rows.
 */
export function mergeAndCap<T extends { id: number }>(
  base: T[],
  continuation: T[],
  msOf: (row: T) => number,
  limit: number,
): T[] {
  return [...base, ...continuation]
    .sort((a, b) => msOf(a) - msOf(b) || a.id - b.id)
    .slice(0, limit);
}

/**
 * Continuation log lines for a single run from partitions in `(date, today]`,
 * gated on the run still being OPEN on `date`. Logs carry no status of their
 * own, so the `runs` table is probed for the run's day-`date` status first; a
 * run that already terminated on `date` (or has no `runs` row there) pulls
 * nothing — which is what keeps a later reused run_id from bleeding backwards.
 */
export function selectCrossMidnightLogRowsForRun(
  db: Database,
  args: { workflow: string; trackerDate: string; itemId: string; runId: string; today?: string },
): LogEntryRow[] {
  const today = args.today ?? dateLocal();
  if (!dateCanHaveContinuation(args.trackerDate, today)) return [];
  const statusRow = readStmts(db).selectRunLatestStatusOnDate.get({
    workflow: args.workflow,
    date: args.trackerDate,
    itemId: args.itemId,
    runId: args.runId,
  }) as { latest_status: string } | undefined;
  if (!statusRow || TERMINAL_STATUSES.has(statusRow.latest_status as TrackerEntry["status"])) {
    return [];
  }
  return readStmts(db).selectLogsAfterDateForRuns.all({
    workflow: args.workflow,
    date: args.trackerDate,
    today,
    runIds: JSON.stringify([args.runId]),
  }) as LogEntryRow[];
}
