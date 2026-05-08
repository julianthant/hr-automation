import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
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

/**
 * Read all lines from a JSONL file regardless of byte offset.
 * Used only for the legacy multi-date `sessions.jsonl` where we cannot
 * skip by offset (the file spans multiple dates, so we must filter by date
 * at parse time — but INSERT OR IGNORE on UNIQUE(source_path, source_offset)
 * absorbs already-seen lines as a no-op).
 */
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

/**
 * Read only the slice [startAt, EOF] of a JSONL file.
 * Each returned ParsedLine carries its byte offset within the full file
 * (not relative to startAt), so the source ref passed to apply* functions
 * remains consistent with previously-stored offsets.
 */
function parseJsonlFrom<T>(path: string, startAt: number): ParsedLine<T>[] {
  const stat = existsSync(path) ? statSync(path) : null;
  if (!stat) return [];
  // Truncation detection: if the file is now shorter than the cached
  // offset, the file was truncated/rewritten between rebuilds. Reset to
  // the start; INSERT OR IGNORE on UNIQUE(source_path, source_offset)
  // absorbs duplicates. Without this branch, post-truncation appends
  // would be skipped forever (`stat.size <= startAt`).
  const effectiveStart = stat.size < startAt ? 0 : startAt;
  if (stat.size <= effectiveStart) return [];
  const remaining = stat.size - effectiveStart;
  const buf = Buffer.alloc(remaining);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, remaining, effectiveStart);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf-8");
  const out: ParsedLine<T>[] = [];
  let offset = effectiveStart;
  // The `line` field is local to this read slice (1-indexed from startAt),
  // NOT an absolute line number in the file. Used only as a debug breadcrumb
  // — UNIQUE constraint on (source_path, source_offset) means correctness
  // hinges on `offset`, not `line`. If a future debug tool surfaces
  // `source.line`, document this caveat there.
  let line = 1;
  for (const rawLine of text.split("\n")) {
    const bytes = Buffer.byteLength(rawLine + "\n");
    if (rawLine.trim()) {
      try {
        out.push({ value: JSON.parse(rawLine) as T, line, offset });
      } catch {
        // Tolerant — a truncated tail line should not block the dashboard.
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

/**
 * Load existing per-path byte_offsets from projection_sources.
 * UNIQUE(source_kind, path) — no tracker_date in the key — so we key by path.
 */
function loadExistingOffsets(db: Database): Map<string, number> {
  const rows = db.prepare(`
    SELECT path, byte_offset FROM projection_sources
  `).all() as Array<{ path: string; byte_offset: number }>;
  const map = new Map<string, number>();
  for (const row of rows) map.set(row.path, row.byte_offset);
  return map;
}

export function rebuildProjectionForDate(db: Database, opts: RebuildProjectionOpts): void {
  const { dir, date } = opts;
  transaction(db, () => {
    // Incremental rebuild: instead of DELETE + full replay, we read only the
    // bytes past each source's last-recorded byte_offset. INSERT OR IGNORE on
    // UNIQUE(source_path, source_offset) absorbs any over-read as a no-op, so
    // the approach is safe even if the offset is slightly stale. No DELETE needed.
    const existingOffsets = loadExistingOffsets(db);

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
      const startAt = existingOffsets.get(path) ?? 0;
      const parsed = parseJsonlFrom<TrackerEntry>(path, startAt);
      for (const row of parsed) {
        applyTrackerEntry(db, row.value, source(path, "tracker", row.line, row.offset, date, workflow));
      }
      recordSource(db, { path, sourceKind: "tracker", workflow, trackerDate: date, lineCount: parsed.length });
    }

    for (const filename of filenames) {
      if (!filename.endsWith(`-${date}-logs.jsonl`)) continue;
      const workflow = filename.slice(0, -`-${date}-logs.jsonl`.length);
      const path = join(dir, filename);
      const startAt = existingOffsets.get(path) ?? 0;
      const parsed = parseJsonlFrom<LogEntry>(path, startAt);
      for (const row of parsed) {
        applyLogEntry(db, row.value, source(path, "log", row.line, row.offset, date, workflow));
      }
      recordSource(db, { path, sourceKind: "log", workflow, trackerDate: date, lineCount: parsed.length });
    }

    // Aggregate session events from both the legacy sessions.jsonl and any
    // dated sessions-YYYY-MM-DD.jsonl files. The dated file for `date` is the
    // primary source after rotation; the legacy file holds pre-rotation data.
    //
    // Incremental strategy per file type:
    //   - sessions-${date}.jsonl: single-date file → safe to use byte_offset.
    //   - sessions.jsonl: multi-date file → must read fully and filter by date
    //     at parse time. INSERT OR IGNORE absorbs already-seen lines as a no-op.
    const datedSessionPath = join(dir, `sessions-${date}.jsonl`);
    const legacySessionPath = join(dir, "sessions.jsonl");
    const sessionFilePairs: Array<{ path: string; incremental: boolean }> = [
      { path: legacySessionPath, incremental: false },
      { path: datedSessionPath, incremental: true },
    ].filter((f, i, arr) => arr.findIndex((x) => x.path === f.path) === i); // deduplicate

    let sessionLinesAppliedTotal = 0;
    for (const { path: sessionsPath, incremental } of sessionFilePairs) {
      const startAt = incremental ? (existingOffsets.get(sessionsPath) ?? 0) : 0;
      const sessions = incremental
        ? parseJsonlFrom<SessionEvent | ScreenshotSessionEvent>(sessionsPath, startAt)
        : parseJsonl<SessionEvent | ScreenshotSessionEvent>(sessionsPath);
      let sessionLineCount = 0;
      for (const row of sessions) {
        const eventDate = sessionEventDate(row.value);
        if (eventDate !== date) continue;
        sessionLineCount += 1;
        applySessionEvent(db, row.value, source(sessionsPath, "session", row.line, row.offset, eventDate));
      }
      sessionLinesAppliedTotal += sessionLineCount;
      recordSource(db, { path: sessionsPath, sourceKind: "session", trackerDate: date, lineCount: sessionLineCount });
    }

    recomputeRunOrdinals(db, date);

    // Backfill workflow + item_id on screenshot files whose run row arrived
    // after `applyScreenshotFiles` ran (or that predate the join fix landing
    // in the 2026-05-07 storage-opt). `queryScreenshotsForItem` filters by
    // (workflow, item_id), so null-owner rows are otherwise invisible to the
    // SQLite-first /api/screenshots path. Idempotent — re-running matches
    // the same rows the next pass would. Skip when no new session lines
    // arrived: screenshot rows are only emitted as ScreenshotSessionEvents,
    // so without a session-line increment there are no new candidate rows.
    if (sessionLinesAppliedTotal > 0) {
      db.prepare(`
        UPDATE files
        SET workflow = (SELECT workflow FROM runs WHERE runs.run_id = files.run_id),
            item_id  = (SELECT item_id  FROM runs WHERE runs.run_id = files.run_id)
        WHERE files.kind = 'screenshot'
          AND files.run_id IS NOT NULL
          AND (files.workflow IS NULL OR files.item_id IS NULL)
          AND EXISTS (SELECT 1 FROM runs WHERE runs.run_id = files.run_id)
      `).run();
    }
  });
}

export function recomputeRunOrdinals(db: Database, date: string): void {
  // Single CTE-driven UPDATE replaces N per-row UPDATEs. Parameterized
  // via db.prepare(...).run() — node:sqlite supports CTE in UPDATEs
  // through prepared statements, no manual string escape needed.
  db.prepare(`
    WITH ordered AS (
      SELECT
        workflow, item_id, run_id,
        ROW_NUMBER() OVER (
          PARTITION BY workflow, item_id
          ORDER BY COALESCE(first_work_ts, first_any_ts), run_id
        ) AS ordinal
      FROM runs
      WHERE tracker_date = @date
    )
    UPDATE runs
    SET run_ordinal = (
      SELECT ordinal FROM ordered
      WHERE ordered.workflow = runs.workflow
        AND ordered.item_id = runs.item_id
        AND ordered.run_id  = runs.run_id
    )
    WHERE tracker_date = @date
      AND EXISTS (
        SELECT 1 FROM ordered
        WHERE ordered.workflow = runs.workflow
          AND ordered.item_id  = runs.item_id
          AND ordered.run_id   = runs.run_id
      );
  `).run({ date });
}
