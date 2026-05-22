import type { Database } from "../../../infra/sqlite/index.js";
import type { RunEventRow } from "../types.js";
import type { TrackerEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { isTrackerStatus, parseJsonObject, parseTypedDataJson, readStmts } from "./statements.js";

export function selectRunEventsForRun(
  db: Database,
  params: { workflow: string; trackerDate: string; itemId?: string; runId: string; limit?: number },
): RunEventRow[] {
  const s = readStmts(db);
  const stmt = params.itemId
    ? s.selectRunEventsForRunWithItem
    : s.selectRunEventsForRunNoItem;
  return stmt.all({ ...params, limit: params.limit ?? 5_000 }) as RunEventRow[];
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
