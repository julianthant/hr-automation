import { statSync } from "node:fs";
import { resolve } from "node:path";

import { openDatabase, transaction, type Database } from "../../infra/sqlite/index.js";

import { DEFAULT_DIR } from "../jsonl-core.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

interface OpenDbEntry {
  db: Database;
  fingerprint: DbFingerprint | null;
}

const openDbs = new Map<string, OpenDbEntry>();

/**
 * Readiness cache for `isStateDbReady`.
 *
 * `isStateDbReady` runs on the `trackEvent` hot path, so it must not issue a
 * `SELECT version` on every call. But it also must not trust a stale positive
 * forever — if `state.db` is deleted, corrupted, or version-regressed after the
 * first successful open, a permanently-cached `ready=true` would feed every
 * projection write into the (now elevated) error path.
 *
 * Compromise: cache the DB file's identity fingerprint (`inode + size + mtime`)
 * captured when readiness was confirmed. Each `isStateDbReady` call does a cheap
 * `statSync` and compares the fingerprint; if the file changed or vanished, the
 * cache is invalidated and the next call re-runs the full schema-version probe.
 * A `statSync` is far cheaper than opening a connection + querying.
 */
interface DbFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}
interface ReadyCacheEntry {
  path: string;
  fingerprint: DbFingerprint;
}
let readyCache: ReadyCacheEntry | null = null;

export function stateDbPath(dir: string = DEFAULT_DIR): string {
  return resolve(dir, "state.db");
}

function fingerprintOf(path: string): DbFingerprint | null {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function fingerprintsMatch(a: DbFingerprint, b: DbFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function sameFileIdentity(a: DbFingerprint, b: DbFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function openStateDb(dir: string = DEFAULT_DIR): Database {
  const path = stateDbPath(dir);
  const existing = openDbs.get(path);
  const currentFingerprint = fingerprintOf(path);
  if (existing) {
    if (existing.fingerprint && currentFingerprint && sameFileIdentity(existing.fingerprint, currentFingerprint)) {
      return existing.db;
    }
    try {
      existing.db.close();
    } catch {
      // If the old handle was already invalid, drop it and reopen below.
    }
    openDbs.delete(path);
    if (readyCache?.path === path) readyCache = null;
  }

  const db = openDatabase(path);
  try {
    runMigrations(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const fingerprint = fingerprintOf(path);
  readyCache = fingerprint ? { path, fingerprint } : null;
  openDbs.set(path, { db, fingerprint });
  return db;
}

export function isStateDbReady(dir: string = DEFAULT_DIR): boolean {
  const path = stateDbPath(dir);
  const fingerprint = fingerprintOf(path);
  // File deleted/vanished — drop a stale positive and report not-ready.
  if (!fingerprint) {
    if (readyCache?.path === path) readyCache = null;
    return false;
  }
  // Cheap fast path: a previous probe confirmed readiness AND the file is
  // byte-for-byte the same DB (inode/size/mtime). Trust it without a query.
  if (readyCache?.path === path && fingerprintsMatch(readyCache.fingerprint, fingerprint)) {
    return true;
  }
  // Cache miss or file changed since last confirmation — re-run the full probe.
  let db: Database | null = null;
  try {
    db = openDatabase(path, { readonly: true, fileMustExist: true, applyDefaultPragmas: false });
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version?: number } | undefined;
    const ready = row?.version === LATEST_SCHEMA_VERSION;
    if (ready) {
      // Re-fingerprint after the probe — the read connection itself can touch
      // sidecar files, and we want the latest identity of the DB file.
      const confirmed = fingerprintOf(path);
      readyCache = confirmed ? { path, fingerprint: confirmed } : null;
    } else if (readyCache?.path === path) {
      readyCache = null;
    }
    return ready;
  } catch {
    if (readyCache?.path === path) readyCache = null;
    return false;
  } finally {
    db?.close();
  }
}

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version?: number } | undefined;
  let current = row?.version ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO schema_version (id, version, applied_at)
        VALUES (1, @version, @appliedAt)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
      `).run({ version: migration.version, appliedAt: new Date().toISOString() });
    });
    current = migration.version;
  }
}

export function closeStateDb(dir: string = DEFAULT_DIR): void {
  const path = stateDbPath(dir);
  const entry = openDbs.get(path);
  if (readyCache?.path === path) readyCache = null;
  if (!entry) return;
  entry.db.close();
  openDbs.delete(path);
}

export const closeStateDbForTests = closeStateDb;
