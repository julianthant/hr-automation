import { existsSync } from "node:fs";
import { basename } from "node:path";
import type Database from "better-sqlite3";

import type { TrackerEntry, LogEntry } from "../jsonl.js";
import type { SessionEvent, ScreenshotSessionEvent } from "../session-events.js";
import { registerLocalFile } from "../files/files.js";
import type { ProjectionSourceRef } from "./types.js";

function toMs(ts: string | undefined, fallback = 0): number {
  const ms = Date.parse(ts ?? "");
  return Number.isFinite(ms) ? ms : fallback;
}

function trackerDateFromTimestamp(ts: string): string {
  return ts.slice(0, 10);
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId || `${entry.id}#1`;
}

function isResolvedPrepData(status: string, step: string | undefined, data: Record<string, string> | undefined): number {
  const isPrep = data?.mode === "prepare";
  if (!isPrep) return 0;
  if (status === "done" && step === "approved") return 1;
  if (status === "failed" && step === "discarded") return 1;
  return 0;
}

export function applyTrackerEntry(
  db: Database.Database,
  entry: TrackerEntry,
  source: ProjectionSourceRef,
): void {
  const trackerDate = source.trackerDate ?? trackerDateFromTimestamp(entry.timestamp);
  const runId = runIdFor(entry);
  const eventMs = toMs(entry.timestamp);
  const dataJson = entry.data ? JSON.stringify(entry.data) : null;
  const typedDataJson = entry.typedData ? JSON.stringify(entry.typedData) : null;
  const inputJson = entry.input ? JSON.stringify(entry.input) : null;
  const rawJson = JSON.stringify(entry);
  const now = new Date().toISOString();
  const isWork = entry.status !== "pending";

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO run_events (
        source_path, source_line, source_offset, workflow, tracker_date, item_id,
        run_id, parent_run_id, status, step, event_ts, event_ms, data_json,
        typed_data_json, input_json, error, raw_json, applied_at
      ) VALUES (
        @sourcePath, @sourceLine, @sourceOffset, @workflow, @trackerDate, @itemId,
        @runId, @parentRunId, @status, @step, @eventTs, @eventMs, @dataJson,
        @typedDataJson, @inputJson, @error, @rawJson, @appliedAt
      )
    `).run({
      sourcePath: source.path,
      sourceLine: source.line,
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
      rawJson,
      appliedAt: now,
    });

    db.prepare(`
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
    `).run({
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

    db.prepare(`
      INSERT INTO items (
        workflow, tracker_date, item_id, latest_run_id, latest_status,
        latest_step, latest_ts, latest_data_json, latest_error, resolved_prep, updated_at
      ) VALUES (
        @workflow, @trackerDate, @itemId, @runId, @status,
        @step, @eventTs, @dataJson, @error, @resolvedPrep, @updatedAt
      )
      ON CONFLICT(workflow, tracker_date, item_id) DO UPDATE SET
        latest_run_id = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_run_id ELSE items.latest_run_id END,
        latest_status = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_status ELSE items.latest_status END,
        latest_step = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_step ELSE items.latest_step END,
        latest_ts = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_ts ELSE items.latest_ts END,
        latest_data_json = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_data_json ELSE items.latest_data_json END,
        latest_error = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.latest_error ELSE items.latest_error END,
        resolved_prep = CASE WHEN excluded.latest_ts >= items.latest_ts THEN excluded.resolved_prep ELSE items.resolved_prep END,
        updated_at = excluded.updated_at
    `).run({
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
      updatedAt: now,
    });
  });
  tx();
}

export function applyLogEntry(
  db: Database.Database,
  entry: LogEntry,
  source: ProjectionSourceRef,
): void {
  const trackerDate = source.trackerDate ?? trackerDateFromTimestamp(entry.ts);
  const runId = entry.runId || `${entry.itemId}#1`;
  const tsMs = toMs(entry.ts);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO logs (
        source_path, source_line, source_offset, workflow, tracker_date, item_id,
        run_id, level, message, ts, ts_ms, raw_json, applied_at
      ) VALUES (
        @sourcePath, @sourceLine, @sourceOffset, @workflow, @trackerDate, @itemId,
        @runId, @level, @message, @ts, @tsMs, @rawJson, @appliedAt
      )
    `).run({
      sourcePath: source.path,
      sourceLine: source.line,
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

    db.prepare(`
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
    `).run({
      workflow: entry.workflow,
      trackerDate,
      itemId: entry.itemId,
      runId,
      ts: entry.ts,
      message: entry.message,
      updatedAt: now,
    });
  });
  tx();
}

export function applySessionEvent(
  db: Database.Database,
  event: SessionEvent | ScreenshotSessionEvent,
  source: ProjectionSourceRef,
): void {
  const timestamp = "timestamp" in event && event.timestamp ? event.timestamp : new Date((event as ScreenshotSessionEvent).ts).toISOString();
  const tsMs = "ts" in event && typeof event.ts === "number" ? event.ts : toMs(timestamp);
  const trackerDate = source.trackerDate ?? trackerDateFromTimestamp(timestamp);
  db.prepare(`
    INSERT OR IGNORE INTO session_events (
      source_path, source_line, source_offset, tracker_date, event_type, workflow_instance,
      run_id, timestamp, ts_ms, raw_json, applied_at
    ) VALUES (
      @sourcePath, @sourceLine, @sourceOffset, @trackerDate, @eventType, @workflowInstance,
      @runId, @timestamp, @tsMs, @rawJson, @appliedAt
    )
  `).run({
    sourcePath: source.path,
    sourceLine: source.line,
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
  if (event.type === "screenshot") {
    applyScreenshotFiles(db, event as ScreenshotSessionEvent);
  }
}

function applyScreenshotFiles(db: Database.Database, event: ScreenshotSessionEvent): void {
  const files = Array.isArray(event.files) ? event.files : [];
  for (const file of files) {
    if (!file.path || !existsSync(file.path)) continue;
    registerLocalFile(db, {
      kind: "screenshot",
      mimeType: "image/png",
      path: file.path,
      originalName: basename(file.path),
      source: "screenshot-event",
      runId: event.runId,
      metadata: {
        system: file.system,
        label: event.label,
        step: event.step,
        kind: event.kind,
      },
    });
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM files
    WHERE kind = 'screenshot' AND run_id = ?
  `).get(event.runId) as { count: number } | undefined;
  db.prepare(`
    UPDATE runs
    SET screenshot_count = ?, updated_at = ?
    WHERE run_id = ?
  `).run(row?.count ?? 0, new Date().toISOString(), event.runId);
}
