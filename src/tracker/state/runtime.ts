import type { TrackerEntry, LogEntry } from "../jsonl.js";
import type { SessionEvent, ScreenshotSessionEvent } from "../session-events.js";
import { log } from "../../utils/log.js";
import { isStateDbReady, openStateDb } from "./db.js";
import { applyTrackerEntry, applyLogEntry, applySessionEvent } from "./apply.js";
import type { ProjectionSourceRef } from "./types.js";

function getReadyDb(dir: string) {
  if (!isStateDbReady(dir)) return null;
  return openStateDb(dir);
}

export function applyTrackerEntryLive(entry: TrackerEntry, source: ProjectionSourceRef, dir: string): void {
  try {
    const db = getReadyDb(dir);
    if (!db) return;
    applyTrackerEntry(db, entry, source);
  } catch (err) {
    log.warn(`SQLite projection skipped tracker event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function applyLogEntryLive(entry: LogEntry, source: ProjectionSourceRef, dir: string): void {
  try {
    const db = getReadyDb(dir);
    if (!db) return;
    applyLogEntry(db, entry, source);
  } catch (err) {
    log.warn(`SQLite projection skipped log event: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function applySessionEventLive(event: SessionEvent | ScreenshotSessionEvent, source: ProjectionSourceRef, dir: string): void {
  try {
    const db = getReadyDb(dir);
    if (!db) return;
    applySessionEvent(db, event, source);
  } catch (err) {
    log.warn(`SQLite projection skipped session event: ${err instanceof Error ? err.message : String(err)}`);
  }
}
