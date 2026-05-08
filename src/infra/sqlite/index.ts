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
import { DatabaseSync } from "node:sqlite";

/**
 * Permissive prepared-statement shape. `node:sqlite`'s `StatementSync` types
 * `.get/.all/.run` parameters as `SQLInputValue` (only primitives + ArrayBuffer
 * views) and returns `Record<string, SQLOutputValue>`, which is too strict for
 * the existing better-sqlite3-style call sites that pass typed parameter
 * objects with nested fields and `as TableRow` cast results. The runtime
 * accepts these — node:sqlite stringifies non-primitive values via JSON before
 * binding — but the static types reject them. This interface mirrors the
 * better-sqlite3 surface the codebase already uses so the migration is
 * mechanical (replace imports + `Database.Database` → `Database`) instead of
 * touching every caller.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

/**
 * Permissive Database shape over `node:sqlite`'s `DatabaseSync`. Same
 * rationale as `Statement` above — keeps caller code unchanged through the
 * migration. Structurally compatible with `DatabaseSync` at runtime; the only
 * substantive difference is `transaction(db, fn)` is exposed as a free
 * function (see below) because `node:sqlite` doesn't have a method form.
 */
export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}

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

  return wrapDatabase(db);
}

/**
 * Wrap a `DatabaseSync` to apply the better-sqlite3-compat statement defaults
 * on every prepared statement. Two knobs matter:
 *
 *  - `setAllowUnknownNamedParameters(true)` — better-sqlite3 silently ignored
 *    named parameters that the SQL didn't reference; node:sqlite throws by
 *    default. The codebase passes bundled param objects across multiple
 *    statements, so we relax this to match the prior contract.
 *  - `setAllowBareNamedParameters(true)` is the node:sqlite default; left as-is.
 *
 * The wrapper is thin (just intercepts `prepare`); other methods pass through.
 */
function wrapDatabase(raw: DatabaseSync): Database {
  return {
    prepare(sql: string): Statement {
      const stmt = raw.prepare(sql);
      stmt.setAllowUnknownNamedParameters(true);
      return stmt as unknown as Statement;
    },
    exec(sql: string): void {
      raw.exec(sql);
    },
    close(): void {
      raw.close();
    },
  };
}

/**
 * Per-`Database` transaction depth, used to pick BEGIN/COMMIT vs
 * SAVEPOINT/RELEASE so nested `transaction(db, ...)` calls work the same way
 * better-sqlite3's nested `db.transaction(fn)` did. better-sqlite3 used
 * `_bs3_NNN` savepoint names internally; we use `_compat_NNN` to make the
 * origin obvious in any error message.
 */
const txDepthByDb = new WeakMap<Database, number>();

/**
 * Run `body` inside a SQLite transaction. Equivalent to better-sqlite3's
 * `db.transaction(body)()` — opens a transaction, runs the body, commits on
 * success, rolls back on throw, and re-throws. Outer call uses
 * `BEGIN IMMEDIATE` (matching better-sqlite3's default) so write-write
 * conflicts surface at BEGIN time. Nested calls use SAVEPOINT, so callers
 * that wrap helpers which themselves call `transaction(db, ...)` work
 * unchanged (e.g. `rebuildProjectionForDate` → `applyTrackerEntry`).
 */
export function transaction<T>(db: Database, body: () => T): T {
  const depth = txDepthByDb.get(db) ?? 0;
  txDepthByDb.set(db, depth + 1);
  if (depth === 0) {
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
    } finally {
      txDepthByDb.set(db, depth);
    }
  }
  const sp = `_compat_${depth}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const result = body();
    db.exec(`RELEASE ${sp}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    } catch {
      /* See above. */
    }
    throw err;
  } finally {
    txDepthByDb.set(db, depth);
  }
}

/** Re-export DatabaseSync for the rare caller that constructs directly. */
export { DatabaseSync };
