import { type Database } from "../../infra/sqlite/index.js";

import { computeFailureCounts } from "../dashboard/failures.js";
import { computeStepDurations } from "../dashboard/run-timelines.js";
import type { LogEntryRow, ProjectionEntriesPayload, ProjectionHealth, RunEventRow } from "./types.js";
import { stateDbPath } from "./db.js";
import type { SessionEvent } from "../session-events.js";
import { groupMergedTrackerEntries } from "../queue-row-count.js";
import { countTopLevelQueueSurfaceRows } from "../queue-surfaces.js";
import type { LogEntry, TrackerEntry, TypedValue } from "../jsonl.js";
import { LOG_ENTRY_LEVELS } from "../jsonl.js";
import { log } from "../../utils/log.js";

function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const TRACKER_STATUSES = new Set<TrackerEntry["status"]>(["pending", "running", "done", "failed", "skipped"]);
const TYPED_VALUE_TYPES = new Set<TypedValue["type"]>(["string", "number", "boolean", "date", "null"]);

function isTrackerStatus(value: unknown): value is TrackerEntry["status"] {
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

function parseTypedDataJson(
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

function readStmts(db: Database): CachedReadStatements {
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
      WHERE i.tracker_date = @date AND i.resolved_prep = 0
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

// ── resolvedEmplIdMapFromRunEvents ────────────────────────────────────────────

const WF_ITEM_KEY_SEP = "\u0000";
const RESOLVED_EMPL_CACHE_TTL_MS = 1_000;
const RESOLVED_EMPL_CACHE_MAX = 10_000;
const resolvedEmplCache = new WeakMap<Database, { trackerDate: string; computedAt: number; value: Map<string, string> }>();

/**
 * Reads `items.latest_empl_id` (projected at write time) for all items on
 * `trackerDate`. One indexed SELECT replaces the previous `json_extract` scan
 * over run_events. Result is cached with a 1s TTL and evicted on date change.
 * Skips caching when the result exceeds RESOLVED_EMPL_CACHE_MAX entries.
 */
function resolvedEmplIdMapFromRunEvents(db: Database, trackerDate: string): Map<string, string> {
  const cached = resolvedEmplCache.get(db);
  const now = Date.now();
  if (
    cached &&
    cached.trackerDate === trackerDate &&
    now - cached.computedAt < RESOLVED_EMPL_CACHE_TTL_MS
  ) {
    return cached.value;
  }
  const out = new Map<string, string>();
  const rows = readStmts(db).selectResolvedEmplIds.all({ date: trackerDate }) as Array<{ workflow: string; item_id: string; latest_empl_id: string }>;
  for (const row of rows) {
    out.set(`${row.workflow}${WF_ITEM_KEY_SEP}${row.item_id}`, row.latest_empl_id);
  }
  if (out.size <= RESOLVED_EMPL_CACHE_MAX) {
    resolvedEmplCache.set(db, { trackerDate, computedAt: now, value: out });
  }
  return out;
}

function patchItemDataWithCarriedEmpl(
  workflow: string,
  itemId: string,
  data: Record<string, string>,
  resolvedEmplIds: Map<string, string>,
): Record<string, string> {
  const carried = resolvedEmplIds.get(`${workflow}${WF_ITEM_KEY_SEP}${itemId}`);
  if (carried && (!data.emplId || String(data.emplId).trim() === "")) {
    return { ...data, emplId: carried };
  }
  return data;
}

export function queryProjectionHealth(db: Database, dir: string): ProjectionHealth {
  const s = readStmts(db);
  const version = s.selectSchemaVersion.get() as { version: number } | undefined;
  const sourceCount = s.countProjectionSources.get() as { n: number };
  const runEventCount = s.countRunEvents.get() as { n: number };
  const logCount = s.countLogs.get() as { n: number };
  const sessionEventCount = s.countSessionEvents.get() as { n: number };
  return {
    ok: true,
    dbPath: stateDbPath(dir),
    schemaVersion: version?.version ?? 0,
    sourceCount: sourceCount.n,
    runEventCount: runEventCount.n,
    logCount: logCount.n,
    sessionEventCount: sessionEventCount.n,
  };
}

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

export function queryEntriesPayload(
  db: Database,
  opts: { workflow: string; date: string },
): ProjectionEntriesPayload {
  const rawEventRows = readStmts(db).selectRunEventsWithRunsForDate.all({ workflow: opts.workflow, date: opts.date }) as Array<{
    id: number;
    workflow: string;
    event_ts: string;
    item_id: string;
    run_id: string;
    parent_run_id: string | null;
    status: unknown;
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
  }>;
  const eventRows: Array<{
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
  }> = [];
  for (const row of rawEventRows) {
    if (isTrackerStatus(row.status)) {
      eventRows.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] queryEntriesPayload: dropping event row with unknown status workflow=${row.workflow} itemId=${row.item_id} runId=${row.run_id} status=${String(row.status)}`,
      );
    }
  }

  const historyByRun = new Map<string, Array<{ timestamp: string; status: TrackerEntry["status"]; step?: string }>>();
  for (const row of eventRows) {
    const key = `${row.item_id}::${row.run_id}`;
    const arr = historyByRun.get(key) ?? [];
    arr.push({ timestamp: row.event_ts, status: row.status, ...(row.step ? { step: row.step } : {}) });
    historyByRun.set(key, arr);
  }

  const entries = eventRows.map((row) => {
    const key = `${row.item_id}::${row.run_id}`;
    const firstLogTs = pickEarlier(row.first_log_ts ?? undefined, row.first_work_ts ?? row.first_any_ts);
    const lastLogTs = pickLater(row.last_log_ts ?? undefined, row.latest_tracker_ts);
    const typedData = parseTypedDataJson(row.typed_data_json, {
      mapper: "queryEntriesPayload",
      rowId: row.id,
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
      firstLogTs,
      lastLogTs,
      ...(row.last_log_message ? { lastLogMessage: row.last_log_message } : {}),
      stepDurations: computeStepDurations(historyByRun.get(key) ?? []),
      runOrdinal: row.run_ordinal,
      ...(row.status === "failed" ? { screenshotCount: row.screenshot_count } : {}),
    };
  });

  const workflows = (readStmts(db).selectDistinctWorkflowsForDate.all({ date: opts.date }) as Array<{ workflow: string }>).map((r) => r.workflow);

  const resolvedEmplFromDay = resolvedEmplIdMapFromRunEvents(db, opts.date);

  const wfCounts: Record<string, number> = {};
  const rawWfCountRows = readStmts(db).selectWfCountRowsForDate.all({ date: opts.date }) as Array<{
    workflow: string;
    id: string;
    runId: string;
    parent_run_id: string | null;
    status: unknown;
    step: string | null;
    timestamp: string;
    data_json: string | null;
    error: string | null;
  }>;
  const wfCountRows: Array<{
    workflow: string;
    id: string;
    runId: string;
    parent_run_id: string | null;
    status: TrackerEntry["status"];
    step: string | null;
    timestamp: string;
    data_json: string | null;
    error: string | null;
  }> = [];
  for (const row of rawWfCountRows) {
    if (isTrackerStatus(row.status)) {
      wfCountRows.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] queryEntriesPayload: dropping wfCount row with unknown status workflow=${row.workflow} row=${row.id} runId=${row.runId} status=${String(row.status)}`,
      );
    }
  }

  const rowsByWorkflowForCount = new Map<string, typeof wfCountRows>();
  for (const row of wfCountRows) {
    const bucket = rowsByWorkflowForCount.get(row.workflow);
    if (bucket) bucket.push(row);
    else rowsByWorkflowForCount.set(row.workflow, [row]);
  }

  for (const wf of workflows) {
    const rows = rowsByWorkflowForCount.get(wf) ?? [];
    const asTracker: TrackerEntry[] = rows.map((row) => ({
      workflow: row.workflow,
      timestamp: row.timestamp,
      id: row.id,
      runId: row.runId,
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: patchItemDataWithCarriedEmpl(
        row.workflow,
        row.id,
        parseJsonObject(row.data_json, {} as Record<string, string>),
        resolvedEmplFromDay,
      ),
      ...(row.error ? { error: row.error } : {}),
    }));
    const primaries = groupMergedTrackerEntries(asTracker).map((g) => g.primary);
    wfCounts[wf] = countTopLevelQueueSurfaceRows({
      entries: primaries,
      delegationSourceEntries: asTracker,
    });
  }

  const failureCounts: Record<string, number> = {};
  // One query for ALL workflows on this date, partition in JS.
  // Replaces the prior per-workflow N+1 (one prepared statement per
  // workflow per tick per connected SSE client).
  const rawAllLatestRows = readStmts(db).selectAllLatestRowsForDate.all({ date: opts.date }) as Array<{
    workflow: string;
    timestamp: string;
    id: string;
    runId: string;
    status: unknown;
    step?: string | null;
    data_json?: string | null;
    error?: string | null;
  }>;
  const allLatestRows: Array<{
    workflow: string;
    timestamp: string;
    id: string;
    runId: string;
    status: TrackerEntry["status"];
    step?: string | null;
    data_json?: string | null;
    error?: string | null;
  }> = [];
  for (const row of rawAllLatestRows) {
    if (isTrackerStatus(row.status)) {
      allLatestRows.push({ ...row, status: row.status });
    } else {
      log.warn(
        `[queries] queryEntriesPayload: dropping allLatest row with unknown status workflow=${row.workflow} id=${row.id} runId=${row.runId} status=${String(row.status)}`,
      );
    }
  }

  const rowsByWorkflow = new Map<string, typeof allLatestRows>();
  for (const row of allLatestRows) {
    const bucket = rowsByWorkflow.get(row.workflow);
    if (bucket) bucket.push(row);
    else rowsByWorkflow.set(row.workflow, [row]);
  }

  for (const wf of workflows) {
    const latestRows = rowsByWorkflow.get(wf) ?? [];
    if (latestRows.length === 0) continue;
    const n = computeFailureCounts(latestRows.map((row) => ({
      workflow: row.workflow,
      timestamp: row.timestamp,
      id: row.id,
      runId: row.runId,
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: parseJsonObject(row.data_json, {}),
      ...(row.error ? { error: row.error } : {}),
    })));
    if (n > 0) failureCounts[wf] = n;
  }

  return { entries, workflows, wfCounts, failureCounts, source: "sqlite" };
}

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

/**
 * Read every session event whose `run_id` matches `opts.runId` OR (for
 * batch-scope events emitted before the per-item ALS context was
 * established) whose `workflow_instance` matches `opts.workflowInstance`.
 * Time-window filtering happens client-side via `filterEventsForRun` so the
 * caller can pass the result straight through and get identical output to
 * the JSONL path.
 *
 * Returns events ordered by ts_ms ASC for deterministic SSE rendering.
 *
 * The session_events row stores the full event payload as `raw_json` (see
 * src/tracker/state/schema.ts:135). We deserialize that to recover the same
 * shape `readSessionEvents` returns from JSONL.
 */
export function querySessionEventsForRun(
  db: Database,
  opts: { runId: string; workflowInstance?: string },
): SessionEvent[] {
  const s = readStmts(db);
  const rows = opts.workflowInstance
    ? (s.selectSessionEventsByRunIdAndInstance.all({ runId: opts.runId, instance: opts.workflowInstance }) as Array<{ raw_json: string }>)
    : (s.selectSessionEventsByRunId.all({ runId: opts.runId }) as Array<{ raw_json: string }>);
  const out: SessionEvent[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw_json) as SessionEvent);
    } catch {
      // Skip — projection rebuild will reconcile.
    }
  }
  return out;
}

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
    data: parseJsonObject(row.latest_data_json, {} as Record<string, unknown>),
  }));
}

export function pickEarlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function pickLater(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
