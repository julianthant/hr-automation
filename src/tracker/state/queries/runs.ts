import type { Database } from "../../../infra/sqlite/index.js";
import { computeStepDurations, pickEarlier, pickLater } from "../../dashboard/run-timelines.js";
import type { TrackerEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, parseJsonObject, readStmts } from "./statements.js";

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
  return rows.map((row) => {
    const data = parseJsonObject<Record<string, unknown>>(row.latest_data_json, {});
    return {
      runId: row.run_id,
      status: row.latest_status,
      ...(row.latest_step ? { step: row.latest_step } : {}),
      timestamp: row.latest_tracker_ts,
      stepDurations: computeStepDurations(byRun.get(row.run_id) ?? []),
      firstLogTs: pickEarlier(row.first_log_ts ?? undefined, row.first_work_ts ?? row.first_any_ts),
      lastLogTs: pickLater(row.last_log_ts ?? undefined, row.latest_tracker_ts),
      runOrdinal: row.run_ordinal,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    };
  });
}
