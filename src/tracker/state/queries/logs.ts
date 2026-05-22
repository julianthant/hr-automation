import type { Database } from "../../../infra/sqlite/index.js";
import type { LogEntryRow } from "../types.js";
import { LOG_ENTRY_LEVELS, type LogEntry } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";
import { parseJsonObject, readStmts } from "./statements.js";

export function selectLogsForRun(
  db: Database,
  params: { workflow: string; trackerDate: string; itemId: string; runId: string; limit?: number },
): LogEntryRow[] {
  return readStmts(db).selectLogsForRun.all({ ...params, limit: params.limit ?? 5_000 }) as LogEntryRow[];
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
