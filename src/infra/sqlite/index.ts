/**
 * Compat shim over `node:sqlite`. Provides the small subset of the
 * `better-sqlite3` API surface this codebase actually uses, plus a
 * `transaction(db, fn)` helper to fill the `db.transaction(fn)` gap
 * (`node:sqlite` does not expose one).
 *
 * Why a shim instead of using `node:sqlite` directly: `better-sqlite3`'s
 * `Database` type propagates through ~17 files via public function
 * signatures (e.g. `enqueueTasks(db: Database.Database, ...)`). Routing
 * the type alias through this module means every consumer imports a single
 * stable `Database` type, and the migration touches imports + a few helper
 * call sites instead of every type annotation.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The runtime database handle. Identical to `node:sqlite`'s `DatabaseSync`,
 * re-exported under a stable name for ergonomics.
 */
export type Database = DatabaseSync;

/** Re-export for callers that need to type a prepared statement. */
export type Statement = StatementSync;

export interface OpenDatabaseOpts {
  /** Open in read-only mode. Maps to `node:sqlite`'s `readOnly` option. */
  readonly?: boolean;
  /**
   * If true, throws if the file does not already exist. Matches
   * `better-sqlite3`'s `fileMustExist`. Default: false.
   */
  fileMustExist?: boolean;
  /**
   * If true (default), apply the project-standard pragmas:
   * journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON.
   * Set to false for read-only opens or test isolation.
   */
  applyDefaultPragmas?: boolean;
}

/**
 * Open a SQLite database. Creates parent directories if missing (matching
 * the legacy behavior in `openStandaloneDb` from `core/control-db.ts`).
 *
 * Throws if `fileMustExist: true` and the path does not exist.
 */
export function openDatabase(path: string, opts: OpenDatabaseOpts = {}): Database {
  const fileMustExist = opts.fileMustExist === true;
  const applyDefaults = opts.applyDefaultPragmas !== false;

  if (fileMustExist && !existsSync(path)) {
    throw new Error(`SQLite database not found: ${path}`);
  }

  if (!fileMustExist && path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(path, {
    readOnly: opts.readonly === true,
  });

  if (applyDefaults && opts.readonly !== true) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
  }

  return db;
}

/**
 * Run `body` inside a SQLite transaction. Equivalent to better-sqlite3's
 * `db.transaction(body)()` — opens a transaction, runs the body, commits on
 * success, rolls back on throw, and re-throws.
 *
 * Uses `BEGIN IMMEDIATE` (matching better-sqlite3's default) so write-write
 * conflicts are detected at BEGIN time instead of mid-statement. Critical
 * for the daemon claim path where two daemons may race.
 *
 * Does NOT support nesting via SAVEPOINT — the codebase does not nest
 * transactions today. If a future caller needs nesting, extend this helper
 * with savepoint semantics rather than letting callers hand-roll BEGIN.
 */
export function transaction<T>(db: Database, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* If rollback itself throws (e.g. connection lost), surface the
       * original error rather than the rollback error. */
    }
    throw err;
  }
}

/** Re-export DatabaseSync for the rare caller that constructs directly. */
export { DatabaseSync };
