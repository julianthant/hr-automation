import type Database from "better-sqlite3";

import type { TrackerEntry, LogEntry } from "../jsonl.js";
import type { SessionEvent, ScreenshotSessionEvent } from "../session-events.js";
import { log } from "../../utils/log.js";
import { isStateDbReady, openStateDb } from "./db.js";
import { applyTrackerEntry, applyLogEntry, applySessionEvent } from "./apply.js";
import type { ProjectionSourceRef } from "./types.js";

const dbByDir = new Map<string, Database.Database>();

function getReadyDb(dir: string): Database.Database | null {
  if (!isStateDbReady(dir)) return null;
  const existing = dbByDir.get(dir);
  if (existing) return existing;
  const db = openStateDb(dir);
  dbByDir.set(dir, db);
  return db;
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
