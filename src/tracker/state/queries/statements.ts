import type { Database } from "../../../infra/sqlite/index.js";
import type { TrackerEntry, TypedValue } from "../../jsonl-io.js";
import { log } from "../../../utils/log.js";

export function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const TRACKER_STATUSES = new Set<TrackerEntry["status"]>(["pending", "running", "done", "failed", "skipped"]);
const TYPED_VALUE_TYPES = new Set<TypedValue["type"]>(["string", "number", "boolean", "date", "null"]);

export function isTrackerStatus(value: unknown): value is TrackerEntry["status"] {
  return typeof value === "string" && TRACKER_STATUSES.has(value as TrackerEntry["status"]);
}

function isTypedValue(value: unknown): value is TypedValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const typed = value as { type?: unknown; value?: unknown };
  if (typeof typed.type !== "string" || !TYPED_VALUE_TYPES.has(typed.type as TypedValue["type"])) {
    return false;
  }
  if (typed.type === "null") return typed.value === "";
  return typeof typed.value === "string";
}

function validateTypedDataMap(
  raw: unknown,
  ctx: { mapper: string; rowId: string | number; sourcePath?: string | null; sourceLine?: number | null },
): Record<string, TypedValue> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    log.warn(
      `[queries] ${ctx.mapper}: dropping non-object typed_data_json for row=${ctx.rowId}` +
        `${ctx.sourcePath ? ` source=${ctx.sourcePath}:${ctx.sourceLine ?? "?"}` : ""} payload=${JSON.stringify(raw)}`,
    );
    return undefined;
  }

  const out: Record<string, TypedValue> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTypedValue(value)) {
      out[key] = value;
    } else {
      log.warn(
        `[queries] ${ctx.mapper}: dropping non-TypedValue entry for row=${ctx.rowId} key=${key}` +
          `${ctx.sourcePath ? ` source=${ctx.sourcePath}:${ctx.sourceLine ?? "?"}` : ""} payload=${JSON.stringify(value)}`,
      );
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseTypedDataJson(
  raw: string | null | undefined,
  ctx: { mapper: string; rowId: string | number; sourcePath?: string | null; sourceLine?: number | null },
): Record<string, TypedValue> | undefined {
  if (!raw) return undefined;
  try {
    return validateTypedDataMap(JSON.parse(raw) as unknown, ctx);
  } catch (err) {
    log.warn(
      `[queries] ${ctx.mapper}: failed to parse typed_data_json for row=${ctx.rowId}` +
        `${ctx.sourcePath ? ` source=${ctx.sourcePath}:${ctx.sourceLine ?? "?"}` : ""}: ${(err as Error).message}`,
    );
    return undefined;
  }
}

// ── Per-Database prepared-statement cache ─────────────────────────────────────
//
// `node:sqlite`'s `prepare()` re-parses + re-plans SQL on every call.  The
// read path runs multiple queries per SSE tick × N connected clients; caching
// prepared statements once per `Database` handle (same pattern as `apply.ts`'s
// write-path `stmtCache`) eliminates that repeated cost.

interface CachedReadStatements {
  selectSchemaVersion: ReturnType<Database["prepare"]>;
  countProjectionSources: ReturnType<Database["prepare"]>;
  countRunEvents: ReturnType<Database["prepare"]>;
  countLogs: ReturnType<Database["prepare"]>;
  countSessionEvents: ReturnType<Database["prepare"]>;
  selectLogsForRun: ReturnType<Database["prepare"]>;
  selectRunEventsForRunWithItem: ReturnType<Database["prepare"]>;
  selectRunEventsForRunNoItem: ReturnType<Database["prepare"]>;
  selectRunEventsWithRunsForDate: ReturnType<Database["prepare"]>;
  selectRunEventsWithRunsAfterDateForRuns: ReturnType<Database["prepare"]>;
  selectRunEventsAfterDateForRuns: ReturnType<Database["prepare"]>;
  selectLogsAfterDateForRuns: ReturnType<Database["prepare"]>;
  selectRunLatestStatusOnDate: ReturnType<Database["prepare"]>;
  selectDistinctWorkflowsForDate: ReturnType<Database["prepare"]>;
  selectWfCountRowsForDate: ReturnType<Database["prepare"]>;
  selectAllLatestRowsForDate: ReturnType<Database["prepare"]>;
  selectRunsForItem: ReturnType<Database["prepare"]>;
  selectRunHistoryForItem: ReturnType<Database["prepare"]>;
  selectSessionEventsByRunId: ReturnType<Database["prepare"]>;
  selectSessionEventsByRunIdAndInstance: ReturnType<Database["prepare"]>;
  selectPriorEntriesByKey: ReturnType<Database["prepare"]>;
  selectResolvedEmplIds: ReturnType<Database["prepare"]>;
}

const readStmtCache = new WeakMap<Database, CachedReadStatements>();

export function readStmts(db: Database): CachedReadStatements {
  const hit = readStmtCache.get(db);
  if (hit) return hit;
  const s: CachedReadStatements = {
    selectSchemaVersion: db.prepare(
      "SELECT version FROM schema_version WHERE id = 1",
    ),
    countProjectionSources: db.prepare(
      "SELECT COUNT(*) AS n FROM projection_sources",
    ),
    countRunEvents: db.prepare(
      "SELECT COUNT(*) AS n FROM run_events",
    ),
    countLogs: db.prepare(
      "SELECT COUNT(*) AS n FROM logs",
    ),
    countSessionEvents: db.prepare(
      "SELECT COUNT(*) AS n FROM session_events",
    ),
    selectLogsForRun: db.prepare(`
      SELECT *
      FROM logs
      WHERE workflow = @workflow
        AND tracker_date = @trackerDate
        AND item_id = @itemId
        AND run_id = @runId
      ORDER BY ts_ms ASC, id ASC
      LIMIT @limit
    `),
    selectRunEventsForRunWithItem: db.prepare(`
      SELECT *
      FROM run_events
      WHERE workflow = @workflow
        AND tracker_date = @trackerDate
        AND item_id = @itemId
        AND run_id = @runId
      ORDER BY event_ms ASC, id ASC
      LIMIT @limit
    `),
    selectRunEventsForRunNoItem: db.prepare(`
      SELECT *
      FROM run_events
      WHERE workflow = @workflow
        AND tracker_date = @trackerDate
        AND run_id = @runId
      ORDER BY event_ms ASC, id ASC
      LIMIT @limit
    `),
    selectRunEventsWithRunsForDate: db.prepare(`
      SELECT re.*, r.first_log_ts, r.last_log_ts, r.last_log_message, r.run_ordinal, r.screenshot_count,
             r.first_any_ts, r.first_work_ts, r.latest_tracker_ts
      FROM run_events re
      JOIN runs r
        ON r.workflow = re.workflow
       AND r.tracker_date = re.tracker_date
       AND r.item_id = re.item_id
       AND r.run_id = re.run_id
      WHERE re.workflow = @workflow AND re.tracker_date = @date
      ORDER BY re.event_ms ASC, re.id ASC
    `),
    // Continuation events for a set of runs in partitions LATER than @date
    // (up to and including @today). Used to forward-merge a run that crossed
    // local midnight: its terminal row lands in the next day's partition, so
    // the start day's per-date query would otherwise miss it and show the run
    // stuck at its last pre-midnight status. @runIds is a JSON string array.
    selectRunEventsWithRunsAfterDateForRuns: db.prepare(`
      SELECT re.*, r.first_log_ts, r.last_log_ts, r.last_log_message, r.run_ordinal, r.screenshot_count,
             r.first_any_ts, r.first_work_ts, r.latest_tracker_ts
      FROM run_events re
      JOIN runs r
        ON r.workflow = re.workflow
       AND r.tracker_date = re.tracker_date
       AND r.item_id = re.item_id
       AND r.run_id = re.run_id
      WHERE re.workflow = @workflow
        AND re.tracker_date > @date
        AND re.tracker_date <= @today
        AND re.run_id IN (SELECT value FROM json_each(@runIds))
      ORDER BY re.event_ms ASC, re.id ASC
    `),
    // Continuation run_events (NO runs join → a clean `RunEventRow`) for a set
    // of runs in partitions LATER than @date (up to @today). Forward-merges the
    // run-event timeline of a run that crossed local midnight. @runIds is a JSON
    // string array.
    selectRunEventsAfterDateForRuns: db.prepare(`
      SELECT *
      FROM run_events
      WHERE workflow = @workflow
        AND tracker_date > @date
        AND tracker_date <= @today
        AND run_id IN (SELECT value FROM json_each(@runIds))
      ORDER BY event_ms ASC, id ASC
    `),
    // Continuation log lines for a set of runs in partitions LATER than @date
    // (up to @today). Forward-merges the log panel of a run that crossed local
    // midnight. @runIds is a JSON string array.
    selectLogsAfterDateForRuns: db.prepare(`
      SELECT *
      FROM logs
      WHERE workflow = @workflow
        AND tracker_date > @date
        AND tracker_date <= @today
        AND run_id IN (SELECT value FROM json_each(@runIds))
      ORDER BY ts_ms ASC, id ASC
    `),
    // Single-row probe: a run's latest projected status on a specific date. Used
    // to gate the cross-midnight logs merge — logs carry no status of their own,
    // so we ask the `runs` table whether the run was still open on @date before
    // pulling its later-partition log lines.
    selectRunLatestStatusOnDate: db.prepare(`
      SELECT latest_status
      FROM runs
      WHERE workflow = @workflow
        AND tracker_date = @date
        AND item_id = @itemId
        AND run_id = @runId
    `),
    selectDistinctWorkflowsForDate: db.prepare(
      "SELECT DISTINCT workflow FROM items WHERE tracker_date = @date ORDER BY workflow",
    ),
    selectWfCountRowsForDate: db.prepare(`
      SELECT i.workflow, i.item_id AS id, i.latest_run_id AS runId,
             r.parent_run_id AS parent_run_id,
             i.latest_status AS status, i.latest_step AS step, i.latest_ts AS timestamp,
             i.latest_data_json AS data_json, i.latest_error AS error
      FROM items i
      LEFT JOIN runs r
        ON r.workflow = i.workflow
       AND r.tracker_date = i.tracker_date
       AND r.item_id = i.item_id
       AND r.run_id = i.latest_run_id
      WHERE i.tracker_date = @date
    `),
    selectAllLatestRowsForDate: db.prepare(`
      SELECT workflow, latest_ts AS timestamp, item_id AS id, latest_run_id AS runId,
             latest_status AS status, latest_step AS step, latest_data_json AS data_json,
             latest_error AS error
      FROM items
      WHERE tracker_date = @date
    `),
    selectRunsForItem: db.prepare(`
      SELECT * FROM runs
      WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId
      ORDER BY run_ordinal ASC
    `),
    selectRunHistoryForItem: db.prepare(`
      SELECT run_id, event_ts AS timestamp, status, step
      FROM run_events
      WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId
      ORDER BY event_ms ASC, id ASC
    `),
    selectSessionEventsByRunId: db.prepare(`
      SELECT raw_json FROM session_events
      WHERE run_id = @runId
      ORDER BY ts_ms ASC, id ASC
    `),
    selectSessionEventsByRunIdAndInstance: db.prepare(`
      SELECT raw_json FROM session_events
      WHERE run_id = @runId OR (run_id IS NULL AND workflow_instance = @instance)
      ORDER BY ts_ms ASC, id ASC
    `),
    selectPriorEntriesByKey: db.prepare(`
      SELECT item_id, latest_run_id, latest_status, latest_step, latest_ts, tracker_date, latest_data_json
      FROM items
      WHERE workflow = @workflow
        AND tracker_date >= @cutoff
        AND latest_data_json IS NOT NULL
        AND TRIM(json_extract(latest_data_json, '$.' || @key)) = @value
        AND NOT (latest_status = 'failed' AND (latest_step = 'cancelled' OR latest_step = 'discarded'))
      ORDER BY latest_ts DESC
    `),
    selectResolvedEmplIds: db.prepare(`
      SELECT workflow, item_id, latest_empl_id
      FROM items
      WHERE tracker_date = @date
        AND latest_empl_id IS NOT NULL
        AND TRIM(latest_empl_id) != ''
    `),
  };
  readStmtCache.set(db, s);
  return s;
}
