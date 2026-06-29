import type { Database } from "../../../infra/sqlite/index.js";
import type { RunEventRow } from "../types.js";
import type { TrackerEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, parseJsonObject, parseTypedDataJson, readStmts } from "./statements.js";
import { mergeAndCap, openRunIdsFromEvents, selectCrossMidnightRunEventRows } from "./cross-midnight.js";

export function selectRunEventsForRun(
  db: Database,
  params: { workflow: string; trackerDate: string; itemId?: string; runId: string; limit?: number },
): RunEventRow[] {
  const s = readStmts(db);
  const stmt = params.itemId
    ? s.selectRunEventsForRunWithItem
    : s.selectRunEventsForRunNoItem;
  const limit = params.limit ?? 5_000;
  const baseRows = stmt.all({ ...params, limit }) as RunEventRow[];

  // Forward-merge after-midnight events when this run was still open on its
  // start day, so the run-event timeline matches the queue card instead of
  // ending at the last pre-midnight event (see cross-midnight.ts).
  const openRunIds = openRunIdsFromEvents(baseRows.map((r) => ({ run_id: r.run_id, status: r.status })));
  const continuation = selectCrossMidnightRunEventRows(db, {
    workflow: params.workflow,
    date: params.trackerDate,
    openRunIds,
  });
  if (continuation.length === 0) return baseRows;
  return mergeAndCap(baseRows, continuation, (row) => row.event_ms, limit);
}

/**
 * Return tracker entries for all child runs of an operation coordinator
 * (`parent_run_id = coordinatorRunId`). Used by `runEventsTopic` to supplement
 * the coordinator's own `trackerEntries` with member entries that carry
 * `data.instance` — enabling `resolveInstanceForOperationCoordinator` to resolve
 * the workflowInstance for the coordinator's log panel.
 *
 * Indexed via `idx_run_events_parent`; not date-scoped so it works even when
 * the coordinator and member rows landed in different partitions.
 */
export function selectChildRunEntriesForCoordinator(
  db: Database,
  coordinatorRunId: string,
): TrackerEntry[] {
  const s = readStmts(db);
  const rows = s.selectRunEventsByParentRunId.all({
    parentRunId: coordinatorRunId,
    limit: 500,
  }) as RunEventRow[];
  const out: TrackerEntry[] = [];
  for (const row of rows) {
    const entry = mapRunEventRowToWire(row);
    if (entry) out.push(entry);
  }
  return out;
}

export function mapRunEventRowToWire(row: RunEventRow): TrackerEntry | null {
  if (!isTrackerStatus(row.status)) {
    log.warn(
      `[queries] mapRunEventRowToWire: dropping run-event row with unknown status workflow=${row.workflow} itemId=${row.item_id} runId=${row.run_id} status=${row.status}`,
    );
    return null;
  }
  const typedData = parseTypedDataJson(row.typed_data_json, {
    mapper: "mapRunEventRowToWire",
    rowId: row.id,
    sourcePath: row.source_path,
    sourceLine: row.source_line,
  });
  return {
    workflow: row.workflow,
    timestamp: row.event_ts,
    id: row.item_id,
    runId: row.run_id,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    status: row.status,
    ...(row.step ? { step: row.step } : {}),
    data: parseJsonObject(row.data_json, {}),
    ...(typedData ? { typedData } : {}),
    ...(row.input_json ? { input: parseJsonObject(row.input_json, {}) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}
