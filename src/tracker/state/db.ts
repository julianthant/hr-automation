import { existsSync } from "node:fs";
import { join } from "node:path";

import { openDatabase, transaction, type Database } from "../../infra/sqlite/index.js";

import { DEFAULT_DIR } from "../jsonl.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

const openDbs = new Map<string, Database>();

export function stateDbPath(dir: string = DEFAULT_DIR): string {
  return join(dir, "state.db");
}

export function openStateDb(dir: string = DEFAULT_DIR): Database {
  const path = stateDbPath(dir);
  const existing = openDbs.get(path);
  if (existing) return existing;

  const db = openDatabase(path);
  runMigrations(db);
  openDbs.set(path, db);
  return db;
}

export function isStateDbReady(dir: string = DEFAULT_DIR): boolean {
  const path = stateDbPath(dir);
  if (!existsSync(path)) return false;
  let db: Database | null = null;
  try {
    db = openDatabase(path, { readonly: true, fileMustExist: true, applyDefaultPragmas: false });
    const row = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version?: number } | undefined;
    return row?.version === LATEST_SCHEMA_VERSION;
  } catch {
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

export function closeStateDbForTests(dir: string = DEFAULT_DIR): void {
  const path = stateDbPath(dir);
  const db = openDbs.get(path);
  if (!db) return;
  db.close();
  openDbs.delete(path);
}
