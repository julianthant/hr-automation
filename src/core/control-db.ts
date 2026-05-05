import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

import { closeStateDbForTests, openStateDb, runMigrations, stateDbPath } from '../tracker/state/db.js'
import { DEFAULT_DIR } from '../tracker/jsonl.js'

export interface OpenControlDbOpts {
  path?: string
  trackerDir?: string
}

export interface ControlDb {
  db: Database.Database
  migrate(): void
  transaction<T>(body: () => T): T
  supportsUpdateReturning(): boolean
  close(): void
}

export function controlDbPath(trackerDir: string = DEFAULT_DIR): string {
  return stateDbPath(trackerDir)
}

export function openControlDb(opts: OpenControlDbOpts = {}): ControlDb {
  const db = opts.path ? openStandaloneDb(opts.path) : openStateDb(opts.trackerDir)
  const close = opts.path
    ? () => db.close()
    : () => {
        closeStateDbForTests(opts.trackerDir)
      }

  return {
    db,
    migrate() {
      runMigrations(db)
    },
    transaction<T>(body: () => T): T {
      const tx = db.transaction(body)
      return tx()
    },
    supportsUpdateReturning() {
      db.exec('CREATE TEMP TABLE IF NOT EXISTS __returning_probe(id INTEGER PRIMARY KEY, state TEXT)')
      db.exec('DELETE FROM __returning_probe')
      db.exec("INSERT INTO __returning_probe(state) VALUES ('queued')")
      const row = db.prepare("UPDATE __returning_probe SET state = 'claimed' WHERE state = 'queued' RETURNING id").get()
      return Boolean(row)
    },
    close,
  }
}

function openStandaloneDb(path: string): Database.Database {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
