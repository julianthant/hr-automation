import type { Database } from "../../../infra/sqlite/index.js";
import type { LogEntryRow } from "../types.js";
import { LOG_ENTRY_LEVELS, type LogEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { parseJsonObject, readStmts } from "./statements.js";
import { mergeAndCap, selectCrossMidnightLogRowsForRun } from "./cross-midnight.js";

export function selectLogsForRun(
  db: Database,
  params: { workflow: string; trackerDate: string; itemId: string; runId: string; limit?: number },
): LogEntryRow[] {
  const limit = params.limit ?? 5_000;
  const base = readStmts(db).selectLogsForRun.all({ ...params, limit }) as LogEntryRow[];

  // Forward-merge after-midnight log lines when this run was still open on its
  // start day, so the log panel shows the whole run instead of just the lines
  // written before local midnight (see cross-midnight.ts).
  const continuation = selectCrossMidnightLogRowsForRun(db, {
    workflow: params.workflow,
    trackerDate: params.trackerDate,
    itemId: params.itemId,
    runId: params.runId,
  });
  if (continuation.length === 0) return base;
  return mergeAndCap(base, continuation, (row) => row.ts_ms, limit);
}

export function mapLogRowToWire(row: LogEntryRow): LogEntry | null {
  if (!LOG_ENTRY_LEVELS.has(row.level as LogEntry["level"])) {
    log.warn(
      `[queries] mapLogRowToWire: dropping log row with unknown level workflow=${row.workflow} itemId=${row.item_id} runId=${row.run_id} level=${row.level}`,
    );
    return null;
  }
  const parsed = parseJsonObject<Partial<LogEntry>>(row.raw_json, {});
  return {
    ...parsed,
    workflow: row.workflow,
    itemId: row.item_id,
    runId: parsed.runId ?? row.run_id,
    level: row.level as LogEntry["level"],
    message: row.message,
    ts: row.ts,
  };
}
