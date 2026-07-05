import type { Database } from "../../../infra/sqlite/index.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, parseJsonObject, readStmts } from "./statements.js";

export interface PriorEntriesByKeyOpts {
  workflow: string;
  /** The `data[keyField]` key to match on. Single-level top-level key only. */
  keyField: string;
  /** The value to match (already trimmed). */
  keyValue: string;
  /** Exclude this item_id from results (the caller's own entry). */
  excludeId?: string;
  /** Inclusive lower bound as YYYY-MM-DD. */
  cutoffDate: string;
}

export interface PriorEntrySummaryRow {
  id: string;
  runId: string | null;
  status: string;
  step: string | null;
  timestamp: string;
  date: string;
  data: Record<string, unknown>;
}

/**
 * SQLite-backed equivalent of the JSONL `findPriorEntriesByKey` loop.
 *
 * Uses the `items` table which stores the latest event per
 * `(workflow, tracker_date, item_id)`. A second-level dedup (latest date per
 * `item_id`) matches the JSONL path's "keep the latest entry per id across all
 * dates" behaviour. Ordered newest first by `latest_ts` to match the JSONL
 * sort.
 *
 * Indexed via `idx_items_workflow_date` (workflow, tracker_date, latest_ts):
 * the leftmost predicate on `workflow` + range on `tracker_date` hit the index;
 * the `json_extract` filter is a row-by-row scan over the bounded result set.
 *
 * SQLite JSON1: `json_extract(latest_data_json, '$.' || @key)` works for
 * top-level keys only — behaviorally equivalent to the JSONL path's
 * `entry.data?.[keyField]` (which is also single-level). The result is
 * wrapped in TRIM(...) to match the JSONL path's `String(value).trim()`
 * comparison; callers should pass an already-trimmed @value.
 */
export function queryPriorEntriesByKey(
  db: Database,
  opts: PriorEntriesByKeyOpts,
): PriorEntrySummaryRow[] {
  // Fetch the latest-per-date row for each item_id that matches the key filter,
  // then dedupe to the single latest across all dates in JS. SQLite's window
  // functions would allow a one-pass solution but the bounded result set (90 days
  // × matching items) is small enough that a JS Map dedup is negligible.
  const rows = readStmts(db).selectPriorEntriesByKey.all({
    workflow: opts.workflow,
    cutoff: opts.cutoffDate,
    key: opts.keyField,
    value: opts.keyValue,
  }) as Array<{
    item_id: string;
    latest_run_id: string | null;
    latest_status: string;
    latest_step: string | null;
    latest_ts: string;
    tracker_date: string;
    latest_data_json: string | null;
  }>;

  // Dedup to latest entry per item_id (same as JSONL latestById Map).
  const latestById = new Map<string, typeof rows[0]>();
  for (const row of rows) {
    if (opts.excludeId && row.item_id === opts.excludeId) continue;
    if (!isTrackerStatus(row.latest_status)) {
      log.warn(
        `[queries] queryPriorEntriesByKey: dropping item row with unknown status workflow=${opts.workflow} itemId=${row.item_id} status=${row.latest_status}`,
      );
      continue;
    }
    if (!latestById.has(row.item_id)) {
      // rows are already ordered latest_ts DESC so the first occurrence is the winner.
      latestById.set(row.item_id, row);
    }
  }

  return [...latestById.values()].map((row) => ({
    id: row.item_id,
    runId: row.latest_run_id,
    status: row.latest_status,
    step: row.latest_step,
    timestamp: row.latest_ts,
    date: row.tracker_date,
    data: parseJsonObject(row.latest_data_json, {}),
  }));
}
