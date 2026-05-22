import type { TrackerEntry, LogEntry } from "../jsonl.js";
import type { SessionEvent, ScreenshotSessionEvent } from "../session-events.js";
import { log } from "../../utils/log.js";
import { isStateDbReady, openStateDb } from "./db.js";
import { applyTrackerEntry, applyLogEntry, applySessionEvent } from "./apply.js";
import { rebuildProjectionForDate } from "./rebuild.js";
import type { ProjectionSourceRef } from "./types.js";

function getReadyDb(dir: string) {
  if (!isStateDbReady(dir)) return null;
  return openStateDb(dir);
}

/**
 * Consecutive-failure tracking for the live SQLite projection.
 *
 * `trackEvent` writes JSONL first, then calls `applyTrackerEntryLive`. If the
 * SQLite apply throws (lock contention, disk full, schema drift) the JSONL
 * line is already on disk and the projection is silently behind by that row.
 * A `log.warn` is not recovery. Instead we:
 *   - count *consecutive* apply failures per `(dir, date)` and reset on success,
 *   - elevate the log from `warn` to `error` so drift is visible,
 *   - after `REBUILD_FAILURE_THRESHOLD` consecutive failures, schedule a
 *     **deferred, asynchronous** `rebuildProjectionForDate` for that date.
 *
 * The rebuild is deferred via `setImmediate` so it never blocks the synchronous
 * `trackEvent` hot path, and is fully guarded so a rebuild failure can't throw
 * back into the workflow. A rebuild already in flight for a `(dir, date)` is
 * never re-triggered.
 */
const REBUILD_FAILURE_THRESHOLD = 3;

const consecutiveFailures = new Map<string, number>();
const rebuildsInFlight = new Set<string>();

function failureKey(dir: string, date: string): string {
  return `${dir}\u0000${date}`;
}

function projectionDateForRef(source: ProjectionSourceRef, fallbackTimestamp: string): string {
  if (source.trackerDate) return source.trackerDate;
  return fallbackTimestamp.slice(0, 10);
}

function noteApplySuccess(dir: string, date: string): void {
  consecutiveFailures.delete(failureKey(dir, date));
}

function noteApplyFailure(dir: string, date: string, kind: string, err: unknown): void {
  const key = failureKey(dir, date);
  const count = (consecutiveFailures.get(key) ?? 0) + 1;
  consecutiveFailures.set(key, count);
  const message = err instanceof Error ? err.message : String(err);
  log.error(
    `SQLite projection failed to apply ${kind} (dir=${dir} date=${date}, ` +
      `consecutive failure ${count}): ${message}`,
  );
  if (count >= REBUILD_FAILURE_THRESHOLD) {
    scheduleProjectionRebuild(dir, date);
  }
}

/**
 * Schedule a deferred, guarded projection rebuild. Runs on the next event-loop
 * tick (`setImmediate`) so it never stalls the synchronous `trackEvent` thread.
 * A rebuild already queued/running for the same `(dir, date)` is not re-queued.
 */
function scheduleProjectionRebuild(dir: string, date: string): void {
  const key = failureKey(dir, date);
  if (rebuildsInFlight.has(key)) return;
  rebuildsInFlight.add(key);
  setImmediate(() => {
    try {
      if (!isStateDbReady(dir)) return;
      const db = openStateDb(dir);
      log.error(
        `SQLite projection drift detected (dir=${dir} date=${date}) — ` +
          `rebuilding from JSONL after ${REBUILD_FAILURE_THRESHOLD} consecutive apply failures`,
      );
      rebuildProjectionForDate(db, { dir, date });
      // Rebuild reconciled the projection with JSONL — clear the failure
      // counter so a subsequent transient error starts a fresh count.
      consecutiveFailures.delete(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`SQLite projection rebuild failed (dir=${dir} date=${date}): ${message}`);
    } finally {
      rebuildsInFlight.delete(key);
    }
  });
}

export function applyTrackerEntryLive(entry: TrackerEntry, source: ProjectionSourceRef, dir: string): void {
  const date = projectionDateForRef(source, entry.timestamp);
  try {
    const db = getReadyDb(dir);
    if (!db) return;
    applyTrackerEntry(db, entry, source);
    noteApplySuccess(dir, date);
  } catch (err) {
    noteApplyFailure(dir, date, "tracker event", err);
  }
}

export function applyLogEntryLive(entry: LogEntry, source: ProjectionSourceRef, dir: string): void {
  const date = projectionDateForRef(source, entry.ts);
  try {
    const db = getReadyDb(dir);
    if (!db) return;
    applyLogEntry(db, entry, source);
    noteApplySuccess(dir, date);
  } catch (err) {
    noteApplyFailure(dir, date, "log event", err);
  }
}

export function applySessionEventLive(event: SessionEvent | ScreenshotSessionEvent, source: ProjectionSourceRef, dir: string): void {
  const fallbackTs =
    "timestamp" in event && event.timestamp
      ? event.timestamp
      : new Date((event as ScreenshotSessionEvent).ts).toISOString();
  const date = projectionDateForRef(source, fallbackTs);
  try {
    const db = getReadyDb(dir);
    if (!db) return;
    applySessionEvent(db, event, source);
    noteApplySuccess(dir, date);
  } catch (err) {
    noteApplyFailure(dir, date, "session event", err);
  }
}

/**
 * Synchronously apply a terminal `failed` tracker entry + `error` log entry to
 * the SQLite projection from within the SIGINT/SIGTERM handler.
 *
 * The signal handler in `withTrackedWorkflow` writes the JSONL lines directly
 * via `appendFileSync` (it cannot await `trackEvent`/`appendLogEntry` before
 * `process.exit`). That bypasses `applyTrackerEntryLive` / `applyLogEntryLive`,
 * so without this call the projection's `runs.latest_status` stays `running`
 * after every Ctrl+C and the dashboard shows the killed run stuck forever.
 *
 * `node:sqlite` is synchronous, so the apply is feasible inside a signal
 * handler. Node signal handlers run between event-loop ticks (they do not
 * preempt synchronous code), so there is no concurrent-transaction hazard.
 *
 * Contract: the caller MUST have already written the JSONL lines. This is
 * best-effort — if the projection isn't ready or the DB write throws, the
 * failure is swallowed locally (the dashboard's startup rebuild is the
 * backstop). It must never throw back into the signal handler.
 */
export function applySigintTerminalToProjection(
  trackEntry: TrackerEntry,
  logEntry: LogEntry,
  source: { trackerPath: string; logPath: string; trackerDate: string },
  dir: string,
): void {
  try {
    if (!isStateDbReady(dir)) return;
    const db = openStateDb(dir);
    applyTrackerEntry(db, trackEntry, {
      sourceKind: "tracker",
      workflow: trackEntry.workflow,
      trackerDate: source.trackerDate,
      path: source.trackerPath,
      offset: 0,
    });
    applyLogEntry(db, logEntry, {
      sourceKind: "log",
      workflow: logEntry.workflow,
      trackerDate: source.trackerDate,
      path: source.logPath,
      offset: 0,
    });
  } catch {
    // Best-effort. A DB error here must not block process exit; the startup
    // rebuild reconciles the projection on the next dashboard launch.
  }
}

/**
 * Test hook — clears the consecutive-failure counters and in-flight rebuild
 * guards so projection-consistency tests start from a clean slate.
 */
export function __resetProjectionFailureStateForTests(): void {
  consecutiveFailures.clear();
  rebuildsInFlight.clear();
}
