import { type Database } from "../../infra/sqlite/index.js";

import { computeFailureCounts } from "../dashboard/failures.js";
import { computeStepDurations } from "../dashboard/run-timelines.js";
import type { LogEntryRow, ProjectionEntriesPayload, ProjectionHealth, RunEventRow } from "./types.js";
import { stateDbPath } from "./db.js";
import type { SessionEvent } from "../session-events.js";
import { groupMergedTrackerEntries } from "../queue-row-count.js";
import { countTopLevelQueueSurfaceRows } from "../queue-surfaces.js";
import type { LogEntry, TrackerEntry } from "../jsonl.js";

function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const WF_ITEM_KEY_SEP = "\u0000";
const RESOLVED_EMPL_CACHE_TTL_MS = 1_000;
const resolvedEmplCache = new WeakMap<Database, { trackerDate: string; computedAt: number; value: Map<string, string> }>();

/**
 * Chronological snapshots that carry non-empty data.emplId — last match per
 * `(workflow,item_id)` mirrors `useEntries` carry-forward across the JSONL replay.
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
  const rows = db.prepare(`
    SELECT workflow, item_id, data_json
    FROM run_events
    WHERE tracker_date = @date
      AND data_json IS NOT NULL
      AND TRIM(IFNULL(json_extract(data_json, '$.emplId'), '')) != ''
    ORDER BY workflow ASC, item_id ASC, event_ms ASC, id ASC
  `).all({ date: trackerDate }) as Array<{ workflow: string; item_id: string; data_json: string }>;
  for (const row of rows) {
    const data = parseJsonObject(row.data_json, {} as Record<string, unknown>);
    const raw = data.emplId;
    const emplId =
      typeof raw === "string" && raw.trim().length > 0
        ? raw.trim()
        : typeof raw === "number" && Number.isFinite(raw)
          ? String(Math.trunc(raw))
          : null;
    if (!emplId?.length) continue;
    out.set(`${row.workflow}${WF_ITEM_KEY_SEP}${row.item_id}`, emplId);
  }
  resolvedEmplCache.set(db, { trackerDate, computedAt: now, value: out });
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
  const version = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number };
  const sourceCount = db.prepare("SELECT COUNT(*) AS n FROM projection_sources").get() as { n: number };
  const runEventCount = db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number };
  const logCount = db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number };
  const sessionEventCount = db.prepare("SELECT COUNT(*) AS n FROM session_events").get() as { n: number };
  return {
    ok: true,
    dbPath: stateDbPath(dir),
    schemaVersion: version.version,
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
  return db.prepare(`
    SELECT *
    FROM logs
    WHERE workflow = @workflow
      AND tracker_date = @trackerDate
      AND item_id = @itemId
      AND run_id = @runId
    ORDER BY ts_ms ASC, id ASC
    LIMIT @limit
  `).all({ ...params, limit: params.limit ?? 5_000 }) as LogEntryRow[];
}

export function mapLogRowToWire(row: LogEntryRow): LogEntry {
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
  const itemFilter = params.itemId ? "AND item_id = @itemId" : "";
  return db.prepare(`
    SELECT *
    FROM run_events
    WHERE workflow = @workflow
      AND tracker_date = @trackerDate
      ${itemFilter}
      AND run_id = @runId
    ORDER BY event_ms ASC, id ASC
    LIMIT @limit
  `).all({ ...params, limit: params.limit ?? 5_000 }) as RunEventRow[];
}

export function mapRunEventRowToWire(row: RunEventRow): TrackerEntry {
  return {
    workflow: row.workflow,
    timestamp: row.event_ts,
    id: row.item_id,
    runId: row.run_id,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    status: row.status as TrackerEntry["status"],
    ...(row.step ? { step: row.step } : {}),
    data: parseJsonObject(row.data_json, {}),
    ...(row.typed_data_json ? { typedData: parseJsonObject(row.typed_data_json, {}) } : {}),
    ...(row.input_json ? { input: parseJsonObject(row.input_json, {}) } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

export function queryEntriesPayload(
  db: Database,
  opts: { workflow: string; date: string },
): ProjectionEntriesPayload {
  const eventRows = db.prepare(`
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
  `).all({ workflow: opts.workflow, date: opts.date }) as Array<{
    workflow: string;
    event_ts: string;
    item_id: string;
    run_id: string;
    parent_run_id: string | null;
    status: "pending" | "running" | "done" | "failed" | "skipped";
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

  const historyByRun = new Map<string, Array<{ timestamp: string; status: "pending" | "running" | "done" | "failed" | "skipped"; step?: string }>>();
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
    return {
      workflow: row.workflow,
      timestamp: row.event_ts,
      id: row.item_id,
      runId: row.run_id,
      ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: parseJsonObject(row.data_json, {}),
      ...(row.typed_data_json ? { typedData: parseJsonObject(row.typed_data_json, {}) } : {}),
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

  const workflows = (db.prepare(`
    SELECT DISTINCT workflow FROM items WHERE tracker_date = @date ORDER BY workflow
  `).all({ date: opts.date }) as Array<{ workflow: string }>).map((r) => r.workflow);

  const resolvedEmplFromDay = resolvedEmplIdMapFromRunEvents(db, opts.date);

  const wfCounts: Record<string, number> = {};
  const wfCountRows = db.prepare(`
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
  `).all({ date: opts.date }) as Array<{
    workflow: string;
    id: string;
    runId: string;
    parent_run_id: string | null;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    step: string | null;
    timestamp: string;
    data_json: string | null;
    error: string | null;
  }>;

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
  const allLatestRows = db.prepare(`
    SELECT workflow, latest_ts AS timestamp, item_id AS id, latest_run_id AS runId,
           latest_status AS status, latest_step AS step, latest_data_json AS data_json,
           latest_error AS error
    FROM items
    WHERE tracker_date = @date
  `).all({ date: opts.date }) as Array<{
    workflow: string;
    timestamp: string;
    id: string;
    runId: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    step?: string | null;
    data_json?: string | null;
    error?: string | null;
  }>;

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
  const rows = db.prepare(`
    SELECT * FROM runs
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId
    ORDER BY run_ordinal ASC
  `).all({ workflow: opts.workflow, date: opts.date, itemId: opts.itemId }) as Array<{
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
  const history = db.prepare(`
    SELECT run_id, event_ts AS timestamp, status, step
    FROM run_events
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId
    ORDER BY event_ms ASC, id ASC
  `).all({ workflow: opts.workflow, date: opts.date, itemId: opts.itemId }) as Array<{
    run_id: string;
    timestamp: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    step: string | null;
  }>;
  const byRun = new Map<string, Array<{ timestamp: string; status: "pending" | "running" | "done" | "failed" | "skipped"; step?: string }>>();
  for (const row of history) {
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
  const params: Record<string, unknown> = { runId: opts.runId };
  let where = "run_id = @runId";
  if (opts.workflowInstance) {
    where += " OR (run_id IS NULL AND workflow_instance = @instance)";
    params.instance = opts.workflowInstance;
  }
  const rows = db.prepare(`
    SELECT raw_json FROM session_events
    WHERE ${where}
    ORDER BY ts_ms ASC, id ASC
  `).all(params) as Array<{ raw_json: string }>;
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
  const rows = db.prepare(`
    SELECT item_id, latest_run_id, latest_status, latest_step, latest_ts, tracker_date, latest_data_json
    FROM items
    WHERE workflow = @workflow
      AND tracker_date >= @cutoff
      AND latest_data_json IS NOT NULL
      AND TRIM(json_extract(latest_data_json, '$.' || @key)) = @value
      AND NOT (latest_status = 'failed' AND (latest_step = 'cancelled' OR latest_step = 'discarded'))
    ORDER BY latest_ts DESC
  `).all({
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
