import type { Database } from "../../../infra/sqlite/index.js";
import { computeStepDurations, pickEarlier, pickLater } from "../../dashboard/run-timelines.js";
import type { TrackerEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, parseJsonObject, readStmts } from "./statements.js";
import {
  type CrossMidnightEventRow,
  TERMINAL_STATUSES,
  selectCrossMidnightEventRowsWithRuns,
} from "./cross-midnight.js";

export function queryRunsForItem(
  db: Database,
  opts: { workflow: string; itemId: string; date: string },
): Array<{
  runId: string;
  status: string;
  step?: string;
  timestamp: string;
  stepDurations: Record<string, number>;
  firstLogTs?: string;
  lastLogTs?: string;
  runOrdinal: number;
  data?: Record<string, unknown>;
}> {
  const rawRows = readStmts(db).selectRunsForItem.all({ workflow: opts.workflow, date: opts.date, itemId: opts.itemId }) as Array<{
    run_id: string;
    latest_status: string;
    latest_step: string | null;
    latest_tracker_ts: string;
    latest_data_json: string | null;
    first_any_ts: string;
    first_work_ts: string | null;
    first_log_ts: string | null;
    last_log_ts: string | null;
    run_ordinal: number;
  }>;
  const rows = rawRows.filter((row) => {
    if (isTrackerStatus(row.latest_status)) return true;
    log.warn(
      `[queries] queryRunsForItem: dropping run row with unknown status workflow=${opts.workflow} itemId=${opts.itemId} runId=${row.run_id} status=${row.latest_status}`,
    );
    return false;
  });
  const rawHistory = readStmts(db).selectRunHistoryForItem.all({ workflow: opts.workflow, date: opts.date, itemId: opts.itemId }) as Array<{
    run_id: string;
    timestamp: string;
    status: unknown;
    step: string | null;
  }>;
  const byRun = new Map<string, Array<{ timestamp: string; status: TrackerEntry["status"]; step?: string }>>();
  for (const row of rawHistory) {
    if (!isTrackerStatus(row.status)) {
      log.warn(
        `[queries] queryRunsForItem: dropping history row with unknown status workflow=${opts.workflow} itemId=${opts.itemId} runId=${row.run_id} status=${String(row.status)}`,
      );
      continue;
    }
    const arr = byRun.get(row.run_id) ?? [];
    arr.push({ timestamp: row.timestamp, status: row.status, ...(row.step ? { step: row.step } : {}) });
    byRun.set(row.run_id, arr);
  }

  // Forward-merge continuation events for any run still open on `opts.date` that
  // kept emitting after crossing local midnight, so the RunSelector/run-detail
  // summary matches the queue card instead of showing the run stuck at its last
  // pre-midnight status (see cross-midnight.ts). Each continuation extends the
  // step-duration history and (for the latest one) overrides the run's terminal
  // status/step/timestamp/data while keeping the day-`date` start aggregates.
  const openRunIds = rows
    .filter((row) => !TERMINAL_STATUSES.has(row.latest_status as TrackerEntry["status"]))
    .map((row) => row.run_id);
  const continuationByRun = new Map<string, CrossMidnightEventRow[]>();
  for (const cont of selectCrossMidnightEventRowsWithRuns(db, { workflow: opts.workflow, date: opts.date, openRunIds })) {
    const arr = continuationByRun.get(cont.run_id) ?? [];
    arr.push(cont);
    continuationByRun.set(cont.run_id, arr);
    const hist = byRun.get(cont.run_id) ?? [];
    hist.push({ timestamp: cont.event_ts, status: cont.status, ...(cont.step ? { step: cont.step } : {}) });
    byRun.set(cont.run_id, hist);
  }

  return rows.map((row) => {
    const continuation = continuationByRun.get(row.run_id);
    // Continuation rows are event-ASC, so the last one is the run's real
    // terminal state after midnight; fall back to the day-`date` runs row.
    const terminal = continuation && continuation.length > 0 ? continuation[continuation.length - 1] : undefined;
    const status = terminal ? terminal.status : row.latest_status;
    const step = terminal ? terminal.step : row.latest_step;
    const timestamp = terminal ? terminal.event_ts : row.latest_tracker_ts;
    const data = parseJsonObject<Record<string, unknown>>(terminal?.data_json ?? row.latest_data_json, {});
    return {
      runId: row.run_id,
      status,
      ...(step ? { step } : {}),
      timestamp,
      stepDurations: computeStepDurations(byRun.get(row.run_id) ?? []),
      firstLogTs: pickEarlier(row.first_log_ts ?? undefined, row.first_work_ts ?? row.first_any_ts),
      lastLogTs: pickLater(
        pickLater(row.last_log_ts ?? undefined, row.latest_tracker_ts),
        terminal ? (terminal.last_log_ts ?? terminal.latest_tracker_ts) : undefined,
      ),
      runOrdinal: row.run_ordinal,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
  });
}
