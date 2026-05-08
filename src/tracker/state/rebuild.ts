import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { transaction, type Database } from "../../infra/sqlite/index.js";

import { dateLocal, type TrackerEntry, type LogEntry } from "../jsonl.js";
import type { SessionEvent, ScreenshotSessionEvent } from "../session-events.js";
import { applyTrackerEntry, applyLogEntry, applySessionEvent } from "./apply.js";
import type { ProjectionSourceKind, ProjectionSourceRef } from "./types.js";

export interface RebuildProjectionOpts {
  dir: string;
  date: string;
}

interface ParsedLine<T> {
  value: T;
  line: number;
  offset: number;
}

function parseJsonl<T>(path: string): ParsedLine<T>[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: ParsedLine<T>[] = [];
  let offset = 0;
  let line = 1;
  for (const rawLine of text.split("\n")) {
    const bytes = Buffer.byteLength(rawLine + "\n");
    if (rawLine.trim()) {
      try {
        out.push({ value: JSON.parse(rawLine) as T, line, offset });
      } catch {
        // Rebuild is tolerant so one truncated append cannot block the dashboard.
      }
    }
    offset += bytes;
    line += 1;
  }
  return out;
}

function source(
  path: string,
  kind: ProjectionSourceKind,
  line: number,
  offset: number,
  date: string,
  workflow?: string,
): ProjectionSourceRef {
  return { sourceKind: kind, workflow, trackerDate: date, path, line, offset };
}

function sessionEventDate(event: SessionEvent | ScreenshotSessionEvent): string {
  const timestamp = "timestamp" in event && event.timestamp
    ? event.timestamp
    : new Date((event as ScreenshotSessionEvent).ts).toISOString();
  // Match the writer's local-date routing in `emitSessionEvent`. Using
  // `timestamp.slice(0, 10)` (UTC) here would silently drop events whose
  // local date differs from their UTC date — e.g. an event at
  // 2026-05-08T01:30Z written in PDT routes to `sessions-2026-05-07.jsonl`
  // but a UTC slice would say "2026-05-08", filtering it out of both dates.
  return dateLocal(new Date(timestamp));
}

function recordSource(db: Database, args: {
  path: string;
  sourceKind: ProjectionSourceKind;
  workflow?: string;
  trackerDate?: string;
  lineCount: number;
}): void {
  const stat = existsSync(args.path) ? statSync(args.path) : { size: 0, mtimeMs: 0 };
  db.prepare(`
    INSERT INTO projection_sources (
      source_kind, workflow, tracker_date, path, size_bytes, mtime_ms,
      line_count, byte_offset, rebuild_version, updated_at
    ) VALUES (
      @sourceKind, @workflow, @trackerDate, @path, @sizeBytes, @mtimeMs,
      @lineCount, @byteOffset, 1, @updatedAt
    )
    ON CONFLICT(source_kind, path) DO UPDATE SET
      workflow = excluded.workflow,
      tracker_date = excluded.tracker_date,
      size_bytes = excluded.size_bytes,
      mtime_ms = excluded.mtime_ms,
      line_count = excluded.line_count,
      byte_offset = excluded.byte_offset,
      updated_at = excluded.updated_at
  `).run({
    sourceKind: args.sourceKind,
    workflow: args.workflow ?? null,
    trackerDate: args.trackerDate ?? null,
    path: args.path,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount: args.lineCount,
    byteOffset: stat.size,
    updatedAt: new Date().toISOString(),
  });
}

export function rebuildProjectionForDate(db: Database, opts: RebuildProjectionOpts): void {
  const { dir, date } = opts;
  transaction(db, () => {
    db.prepare("DELETE FROM run_events WHERE tracker_date = ?").run(date);
    db.prepare("DELETE FROM logs WHERE tracker_date = ?").run(date);
    db.prepare("DELETE FROM runs WHERE tracker_date = ?").run(date);
    db.prepare("DELETE FROM items WHERE tracker_date = ?").run(date);
    db.prepare("DELETE FROM session_events WHERE tracker_date = ?").run(date);

    const filenames = existsSync(dir) ? readdirSync(dir) : [];
    for (const filename of filenames) {
      if (!filename.endsWith(`-${date}.jsonl`)) continue;
      if (filename.endsWith(`-${date}-logs.jsonl`)) continue;
      // `sessions-${date}.jsonl` (post-rotation) matches the tracker suffix
      // but holds session events, not TrackerEntry rows. Routed via the
      // dedicated session loop below; never as a "sessions" workflow.
      if (filename === `sessions-${date}.jsonl`) continue;
      const workflow = filename.slice(0, -`-${date}.jsonl`.length);
      const path = join(dir, filename);
      const parsed = parseJsonl<TrackerEntry>(path);
      for (const row of parsed) {
        applyTrackerEntry(db, row.value, source(path, "tracker", row.line, row.offset, date, workflow));
      }
      recordSource(db, { path, sourceKind: "tracker", workflow, trackerDate: date, lineCount: parsed.length });
    }

    for (const filename of filenames) {
      if (!filename.endsWith(`-${date}-logs.jsonl`)) continue;
      const workflow = filename.slice(0, -`-${date}-logs.jsonl`.length);
      const path = join(dir, filename);
      const parsed = parseJsonl<LogEntry>(path);
      for (const row of parsed) {
        applyLogEntry(db, row.value, source(path, "log", row.line, row.offset, date, workflow));
      }
      recordSource(db, { path, sourceKind: "log", workflow, trackerDate: date, lineCount: parsed.length });
    }

    // Aggregate session events from both the legacy sessions.jsonl and any
    // dated sessions-YYYY-MM-DD.jsonl files. The dated file for `date` is the
    // primary source after rotation; the legacy file holds pre-rotation data.
    const sessionFiles = [
      join(dir, "sessions.jsonl"),
      join(dir, `sessions-${date}.jsonl`),
    ].filter((p, i, arr) => arr.indexOf(p) === i); // deduplicate (if same path)
    for (const sessionsPath of sessionFiles) {
      const sessions = parseJsonl<SessionEvent | ScreenshotSessionEvent>(sessionsPath);
      let sessionLineCount = 0;
      for (const row of sessions) {
        const eventDate = sessionEventDate(row.value);
        if (eventDate !== date) continue;
        sessionLineCount += 1;
        applySessionEvent(db, row.value, source(sessionsPath, "session", row.line, row.offset, eventDate));
      }
      recordSource(db, { path: sessionsPath, sourceKind: "session", trackerDate: date, lineCount: sessionLineCount });
    }

    recomputeRunOrdinals(db, date);

    // Backfill workflow + item_id on screenshot files whose run row arrived
    // after `applyScreenshotFiles` ran (or that predate the join fix landing
    // in the 2026-05-07 storage-opt). `queryScreenshotsForItem` filters by
    // (workflow, item_id), so null-owner rows are otherwise invisible to the
    // SQLite-first /api/screenshots path. Idempotent — re-running matches
    // the same rows the next pass would.
    db.prepare(`
      UPDATE files
      SET workflow = (SELECT workflow FROM runs WHERE runs.run_id = files.run_id),
          item_id  = (SELECT item_id  FROM runs WHERE runs.run_id = files.run_id)
      WHERE files.kind = 'screenshot'
        AND files.run_id IS NOT NULL
        AND (files.workflow IS NULL OR files.item_id IS NULL)
        AND EXISTS (SELECT 1 FROM runs WHERE runs.run_id = files.run_id)
    `).run();
  });
}

export function recomputeRunOrdinals(db: Database, date: string): void {
  const rows = db.prepare(`
    SELECT workflow, item_id, run_id, COALESCE(first_work_ts, first_any_ts) AS first_ts
    FROM runs
    WHERE tracker_date = ?
    ORDER BY workflow, item_id, first_ts, run_id
  `).all(date) as Array<{ workflow: string; item_id: string; run_id: string; first_ts: string }>;
  let currentKey = "";
  let ordinal = 0;
  const update = db.prepare(`
    UPDATE runs SET run_ordinal = @ordinal
    WHERE workflow = @workflow AND tracker_date = @date AND item_id = @itemId AND run_id = @runId
  `);
  for (const row of rows) {
    const key = `${row.workflow}\0${row.item_id}`;
    if (key !== currentKey) {
      currentKey = key;
      ordinal = 0;
    }
    ordinal += 1;
    update.run({ ordinal, workflow: row.workflow, date, itemId: row.item_id, runId: row.run_id });
  }
}
