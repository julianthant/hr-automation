import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import { DEFAULT_DIR } from "../jsonl.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

const openDbs = new Map<string, Database.Database>();

export function stateDbPath(dir: string = DEFAULT_DIR): string {
  return join(dir, "state.db");
}

export function openStateDb(dir: string = DEFAULT_DIR): Database.Database {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = stateDbPath(dir);
  const existing = openDbs.get(path);
  if (existing) return existing;

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  openDbs.set(path, db);
  return db;
}

export function isStateDbReady(dir: string = DEFAULT_DIR): boolean {
  const path = stateDbPath(dir);
  if (!existsSync(path)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version?: number } | undefined;
    return row?.version === LATEST_SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export function runMigrations(db: Database.Database): void {
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
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO schema_version (id, version, applied_at)
        VALUES (1, @version, @appliedAt)
        ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at
      `).run({ version: migration.version, appliedAt: new Date().toISOString() });
    });
    apply();
    current = migration.version;
  }
}

export function closeStateDbForTests(dir: string = DEFAULT_DIR): void {
  const path = stateDbPath(dir);
  const db = openDbs.get(path);
  if (!db) return;
  db.close();
  openDbs.delete(path);
}
