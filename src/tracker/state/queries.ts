import { type Database } from "../../infra/sqlite/index.js";

import { computeFailureCounts } from "../dashboard/failures.js";
import { computeStepDurations } from "../dashboard/run-timelines.js";
import type { ProjectionEntriesPayload, ProjectionHealth } from "./types.js";
import { stateDbPath } from "./db.js";
import type { SessionEvent } from "../session-events.js";

function parseJsonObject<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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

  const historyRows = db.prepare(`
    SELECT item_id, run_id, event_ts AS timestamp, status, step
    FROM run_events
    WHERE workflow = @workflow AND tracker_date = @date
    ORDER BY event_ms ASC, id ASC
  `).all({ workflow: opts.workflow, date: opts.date }) as Array<{
    item_id: string;
    run_id: string;
    timestamp: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    step?: string | null;
  }>;
  const historyByRun = new Map<string, Array<{ timestamp: string; status: "pending" | "running" | "done" | "failed" | "skipped"; step?: string }>>();
  for (const row of historyRows) {
    const key = `${row.item_id}::${row.run_id}`;
    const arr = historyByRun.get(key) ?? [];
    arr.push({ timestamp: row.timestamp, status: row.status, ...(row.step ? { step: row.step } : {}) });
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

  const wfCounts: Record<string, number> = {};
  const countRows = db.prepare(`
    SELECT workflow, COUNT(*) AS n
    FROM items
    WHERE tracker_date = @date AND resolved_prep = 0
    GROUP BY workflow
  `).all({ date: opts.date }) as Array<{ workflow: string; n: number }>;
  for (const row of countRows) wfCounts[row.workflow] = row.n;

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
  return rows.map((row) => ({
    runId: row.run_id,
    status: row.latest_status,
    ...(row.latest_step ? { step: row.latest_step } : {}),
    timestamp: row.latest_tracker_ts,
    stepDurations: computeStepDurations(byRun.get(row.run_id) ?? []),
    firstLogTs: pickEarlier(row.first_log_ts ?? undefined, row.first_work_ts ?? row.first_any_ts),
    lastLogTs: pickLater(row.last_log_ts ?? undefined, row.latest_tracker_ts),
    runOrdinal: row.run_ordinal,
  }));
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
