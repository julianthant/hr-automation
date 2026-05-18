import { existsSync } from "node:fs";
import { basename } from "node:path";
import { transaction, type Database, type Statement } from "../../infra/sqlite/index.js";

import type { TrackerEntry, LogEntry } from "../jsonl.js";
import { dateLocal } from "../jsonl.js";
import type { SessionEvent, ScreenshotSessionEvent } from "../session-events.js";
import { registerLocalFile } from "../files/files.js";
import type { ProjectionSourceRef } from "./types.js";

interface CachedStatements {
  insertRunEvent: Statement;
  upsertRun: Statement;
  selectRunExists: Statement;
  upsertItem: Statement;
  insertLog: Statement;
  updateRunLogTs: Statement;
  insertSessionEvent: Statement;
  selectRunForScreenshot: Statement;
  updateRunScreenshotCount: Statement;
  recomputeRunOrdinalsForItem: Statement;
}

const stmtCache = new WeakMap<Database, CachedStatements>();

function stmts(db: Database): CachedStatements {
  let cached = stmtCache.get(db);
  if (cached) return cached;
  cached = {
    insertRunEvent: db.prepare(`
      INSERT OR IGNORE INTO run_events (
        source_path, source_line, source_offset, workflow, tracker_date, item_id,
        run_id, parent_run_id, status, step, event_ts, event_ms, data_json,
        typed_data_json, input_json, error, applied_at
      ) VALUES (
        @sourcePath, @sourceLine, @sourceOffset, @workflow, @trackerDate, @itemId,
        @runId, @parentRunId, @status, @step, @eventTs, @eventMs, @dataJson,
        @typedDataJson, @inputJson, @error, @appliedAt
      )
    `),
    upsertRun: db.prepare(`
      INSERT INTO runs (
        workflow, tracker_date, item_id, run_id, parent_run_id,
        first_any_ts, first_work_ts, latest_tracker_ts, latest_status, latest_step,
        latest_data_json, latest_typed_data_json, latest_input_json, latest_error,
        updated_at
      ) VALUES (
        @workflow, @trackerDate, @itemId, @runId, @parentRunId,
        @eventTs, @firstWorkTs, @eventTs, @status, @step,
        @dataJson, @typedDataJson, @inputJson, @error, @updatedAt
      )
      ON CONFLICT(workflow, tracker_date, item_id, run_id) DO UPDATE SET
        parent_run_id = COALESCE(excluded.parent_run_id, runs.parent_run_id),
        first_any_ts = CASE WHEN excluded.first_any_ts < runs.first_any_ts THEN excluded.first_any_ts ELSE runs.first_any_ts END,
        first_work_ts = CASE
          WHEN excluded.first_work_ts IS NULL THEN runs.first_work_ts
          WHEN runs.first_work_ts IS NULL THEN excluded.first_work_ts
          WHEN excluded.first_work_ts < runs.first_work_ts THEN excluded.first_work_ts
          ELSE runs.first_work_ts
        END,
        latest_tracker_ts = CASE WHEN excluded.latest_tracker_ts >= runs.latest_tracker_ts THEN excluded.latest_tracker_ts ELSE runs.latest_tracker_ts END,
        latest_status = CASE WHEN excluded.latest_tracker_ts >= runs.latest_tracker_ts THEN excluded.latest_status ELSE runs.latest_status END,
        latest_step = CASE WHEN excluded.latest_tracker_ts >= runs.latest_tracker_ts THEN excluded.latest_step ELSE runs.latest_step END,
        latest_data_json = CASE WHEN excluded.latest_tracker_ts >= runs.latest_tracker_ts THEN excluded.latest_data_json ELSE runs.latest_data_json END,
        latest_typed_data_json = CASE WHEN excluded.latest_tracker_ts >= runs.latest_tracker_ts THEN excluded.latest_typed_data_json ELSE runs.latest_typed_data_json END,
        latest_input_json = COALESCE(runs.latest_input_json, excluded.latest_input_json),
        latest_error = CASE WHEN excluded.latest_tracker_ts >= runs.latest_tracker_ts THEN excluded.latest_error ELSE runs.latest_error END,
        updated_at = excluded.updated_at
    `),
    selectRunExists: db.prepare(`
      SELECT 1
      FROM runs
      WHERE workflow = @workflow
        AND tracker_date = @trackerDate
        AND item_id = @itemId
        AND run_id = @runId
      LIMIT 1
    `),
    upsertItem: db.prepare(`
      INSERT INTO items (
        workflow, tracker_date, item_id, latest_run_id, latest_status,
        latest_step, latest_ts, latest_data_json, latest_error, resolved_prep,
        latest_empl_id, updated_at
      ) VALUES (
        @workflow, @trackerDate, @itemId, @runId, @status,
        @step, @eventTs, @dataJson, @error, @resolvedPrep,
        @emplId, @updatedAt
      )
      ON CONFLICT(workflow, tracker_date, item_id) DO UPDATE SET
        latest_run_id = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_run_id ELSE items.latest_run_id END,
        latest_status = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_status ELSE items.latest_status END,
        latest_step = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_step ELSE items.latest_step END,
        latest_ts = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_ts ELSE items.latest_ts END,
        latest_data_json = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_data_json ELSE items.latest_data_json END,
        latest_error = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_error ELSE items.latest_error END,
        resolved_prep = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.resolved_prep ELSE items.resolved_prep END,
        latest_empl_id = CASE
          WHEN excluded.latest_empl_id IS NOT NULL THEN excluded.latest_empl_id
          ELSE items.latest_empl_id
        END,
        updated_at = excluded.updated_at
    `),
    insertLog: db.prepare(`
      INSERT OR IGNORE INTO logs (
        source_path, source_line, source_offset, workflow, tracker_date, item_id,
        run_id, level, message, ts, ts_ms, raw_json, applied_at
      ) VALUES (
        @sourcePath, @sourceLine, @sourceOffset, @workflow, @trackerDate, @itemId,
        @runId, @level, @message, @ts, @tsMs, @rawJson, @appliedAt
      )
    `),
    updateRunLogTs: db.prepare(`
      UPDATE runs SET
        first_log_ts = CASE
          WHEN first_log_ts IS NULL THEN @ts
          WHEN @ts < first_log_ts THEN @ts
          ELSE first_log_ts
        END,
        last_log_ts = CASE
          WHEN last_log_ts IS NULL THEN @ts
          WHEN @ts >= last_log_ts THEN @ts
          ELSE last_log_ts
        END,
        last_log_message = CASE
          WHEN last_log_ts IS NULL THEN @message
          WHEN @ts >= last_log_ts THEN @message
          ELSE last_log_message
        END,
        updated_at = @updatedAt
      WHERE workflow = @workflow
        AND tracker_date = @trackerDate
        AND item_id = @itemId
        AND run_id = @runId
    `),
    insertSessionEvent: db.prepare(`
      INSERT OR IGNORE INTO session_events (
        source_path, source_line, source_offset, tracker_date, event_type, workflow_instance,
        run_id, timestamp, ts_ms, raw_json, applied_at
      ) VALUES (
        @sourcePath, @sourceLine, @sourceOffset, @trackerDate, @eventType, @workflowInstance,
        @runId, @timestamp, @tsMs, @rawJson, @appliedAt
      )
    `),
    selectRunForScreenshot: db.prepare(
      "SELECT workflow, item_id FROM runs WHERE run_id = ? LIMIT 1",
    ),
    updateRunScreenshotCount: db.prepare(`
      UPDATE runs
      SET screenshot_count = screenshot_count + @delta, updated_at = @updatedAt
      WHERE run_id = @runId
    `),
    // Mirror of the rebuild path's recomputeRunOrdinals, scoped to one
    // (workflow, tracker_date, item_id) bucket so it's cheap enough to call
    // on every live tracker apply. Without this, new run rows hit the schema
    // default of 1 and the dashboard shows two "Run #1" entries side-by-side.
    recomputeRunOrdinalsForItem: db.prepare(`
      WITH ordered AS (
        SELECT
          run_id,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(first_work_ts, first_any_ts), run_id
          ) AS ordinal
        FROM runs
        WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId
      )
      UPDATE runs
      SET run_ordinal = (
        SELECT ordinal FROM ordered WHERE ordered.run_id = runs.run_id
      )
      WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId
        AND EXISTS (SELECT 1 FROM ordered WHERE ordered.run_id = runs.run_id)
    `),
  };
  stmtCache.set(db, cached);
  return cached;
}

function toMs(ts: string | undefined, fallback = 0): number {
  const ms = Date.parse(ts ?? "");
  return Number.isFinite(ms) ? ms : fallback;
}

function trackerDateFromTimestamp(ts: string): string {
  return dateLocal(new Date(ts));
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId || `${entry.id}#1`;
}

function extractEmplId(data: Record<string, string> | undefined): string | null {
  if (!data) return null;
  const raw = data.emplId;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return null;
}

function isResolvedPrepData(status: string, step: string | undefined, data: Record<string, string> | undefined): number {
  const isPrep = data?.mode === "prepare";
  if (!isPrep) return 0;
  if (status === "done" && step === "approved") return 1;
  if (status === "failed" && step === "discarded") return 1;
  return 0;
}

export function applyTrackerEntry(
  db: Database,
  entry: TrackerEntry,
  source: ProjectionSourceRef,
): void {
  const trackerDate = source.trackerDate ?? trackerDateFromTimestamp(entry.timestamp);
  const runId = runIdFor(entry);
  const eventMs = toMs(entry.timestamp);
  const dataJson = entry.data ? JSON.stringify(entry.data) : null;
  const typedDataJson = entry.typedData ? JSON.stringify(entry.typedData) : null;
  const inputJson = entry.input ? JSON.stringify(entry.input) : null;
  const now = new Date().toISOString();
  const isWork = entry.status !== "pending";

  const s = stmts(db);
  transaction(db, () => {
    s.insertRunEvent.run({
      sourcePath: source.path,
      sourceLine: source.line ?? 0,
      sourceOffset: source.offset,
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.id,
      runId,
      parentRunId: entry.parentRunId ?? null,
      status: entry.status,
      step: entry.step ?? null,
      eventTs: entry.timestamp,
      eventMs,
      dataJson,
      typedDataJson,
      inputJson,
      error: entry.error ?? null,
      appliedAt: now,
    });

    const existingRun = s.selectRunExists.get({
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.id,
      runId,
    });

    s.upsertRun.run({
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.id,
      runId,
      parentRunId: entry.parentRunId ?? null,
      eventTs: entry.timestamp,
      firstWorkTs: isWork ? entry.timestamp : null,
      status: entry.status,
      step: entry.step ?? null,
      dataJson,
      typedDataJson,
      inputJson,
      error: entry.error ?? null,
      updatedAt: now,
    });

    s.upsertItem.run({
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.id,
      runId,
      status: entry.status,
      step: entry.step ?? null,
      eventTs: entry.timestamp,
      dataJson,
      error: entry.error ?? null,
      resolvedPrep: isResolvedPrepData(entry.status, entry.step, entry.data),
      emplId: extractEmplId(entry.data),
      updatedAt: now,
    });

    if (!existingRun) {
      s.recomputeRunOrdinalsForItem.run({
        workflow: entry.workflow,
        date: trackerDate,
        itemId: entry.id,
      });
    }
  });
}

export function applyLogEntry(
  db: Database,
  entry: LogEntry,
  source: ProjectionSourceRef,
): void {
  const trackerDate = source.trackerDate ?? trackerDateFromTimestamp(entry.ts);
  const runId = entry.runId;
  if (!runId) {
    return;
  }
  const tsMs = toMs(entry.ts);
  const now = new Date().toISOString();
  const s = stmts(db);
  transaction(db, () => {
    s.insertLog.run({
      sourcePath: source.path,
      sourceLine: source.line ?? 0,
      sourceOffset: source.offset,
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.itemId,
      runId,
      level: entry.level,
      message: entry.message,
      ts: entry.ts,
      tsMs,
      rawJson: JSON.stringify(entry),
      appliedAt: now,
    });

    s.updateRunLogTs.run({
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.itemId,
      runId,
      ts: entry.ts,
      message: entry.message,
      updatedAt: now,
    });
  });
}

export function applySessionEvent(
  db: Database,
  event: SessionEvent | ScreenshotSessionEvent,
  source: ProjectionSourceRef,
): void {
  const timestamp = "timestamp" in event && event.timestamp ? event.timestamp : new Date((event as ScreenshotSessionEvent).ts).toISOString();
  const tsMs = "ts" in event && typeof event.ts === "number" ? event.ts : toMs(timestamp);
  const trackerDate = source.trackerDate ?? trackerDateFromTimestamp(timestamp);
  const inserted = stmts(db).insertSessionEvent.run({
    sourcePath: source.path,
    sourceLine: source.line ?? 0,
    sourceOffset: source.offset,
    trackerDate,
    eventType: event.type,
    workflowInstance: "workflowInstance" in event ? event.workflowInstance ?? null : null,
    runId: "runId" in event ? event.runId ?? null : null,
    timestamp,
    tsMs,
    rawJson: JSON.stringify(event),
    appliedAt: new Date().toISOString(),
  });
  if (event.type === "screenshot" && inserted.changes > 0) {
    applyScreenshotFiles(db, event as ScreenshotSessionEvent);
  }
}

function applyScreenshotFiles(db: Database, event: ScreenshotSessionEvent): void {
  const files = Array.isArray(event.files) ? event.files : [];
  // Look up workflow + item_id from the runs table so the files row is
  // queryable by the (workflow, item_id, run_id) index via queryScreenshotsForItem.
  let workflow: string | undefined;
  let itemId: string | undefined;
  if (event.runId) {
    const run = stmts(db).selectRunForScreenshot.get(event.runId) as { workflow: string; item_id: string } | undefined;
    if (run) {
      workflow = run.workflow;
      itemId = run.item_id;
    }
  }
  let registeredCount = 0;
  for (const file of files) {
    if (!file.path || !existsSync(file.path)) continue;
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: file.path,
      originalName: basename(file.path),
      source: "screenshot-event",
      runId: event.runId,
      workflow,
      itemId,
      metadata: {
        system: file.system,
        label: event.label,
        step: event.step,
        kind: event.kind,
      },
    });
    registeredCount++;
  }
  if (registeredCount > 0) {
    stmts(db).updateRunScreenshotCount.run({
      delta: registeredCount,
      updatedAt: new Date().toISOString(),
      runId: event.runId,
    });
  }
}
