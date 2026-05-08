import { openDatabase, transaction, type Database } from '../infra/sqlite/index.js'

import { closeStateDbForTests, openStateDb, runMigrations, stateDbPath } from '../tracker/state/db.js'
import { DEFAULT_DIR } from '../tracker/jsonl.js'

export interface OpenControlDbOpts {
  path?: string
  trackerDir?: string
}

export interface ControlDb {
  db: Database
  migrate(): void
  transaction<T>(body: () => T): T
  supportsUpdateReturning(): boolean
  close(): void
}

const updateReturningSupportByDb = new WeakMap<Database, boolean>()

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
      return transaction(db, body)
    },
    supportsUpdateReturning() {
      return supportsUpdateReturning(db)
    },
    close,
  }
}

function supportsUpdateReturning(db: Database): boolean {
  const cached = updateReturningSupportByDb.get(db)
  if (typeof cached === 'boolean') return cached
  let supported: boolean
  try {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS __returning_probe(id INTEGER PRIMARY KEY, state TEXT)')
    db.exec('DELETE FROM __returning_probe')
    db.exec("INSERT INTO __returning_probe(state) VALUES ('queued')")
    const row = db.prepare("UPDATE __returning_probe SET state = 'claimed' WHERE state = 'queued' RETURNING id").get()
    supported = Boolean(row)
  } catch {
    supported = false
  }
  updateReturningSupportByDb.set(db, supported)
  return supported
}

function openStandaloneDb(path: string): Database {
  const db = openDatabase(path)
  runMigrations(db)
  return db
}
