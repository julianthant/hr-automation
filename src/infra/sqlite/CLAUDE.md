# SQLite Compat Shim

Thin wrapper over `node:sqlite` (Node 22+ stable, default-on in 26+). Replaces
`better-sqlite3` across the codebase. Lives in `src/infra/` because it's
runtime infrastructure that several layers (core, tracker, dashboard) depend
on — not a domain concept and not workflow-specific.

## API

- `openDatabase(path, opts?)` — opens a `DatabaseSync`, creates parent dirs
  if missing, applies project-standard pragmas (`journal_mode=WAL`,
  `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`) unless
  `applyDefaultPragmas: false` or `readonly: true`. Use `fileMustExist: true`
  for read-only probes that should fail loud if the file is missing.
- `transaction(db, body)` — runs `body` inside `BEGIN IMMEDIATE` /
  `COMMIT` / `ROLLBACK`. Re-throws the caller's error after rollback.
- `Database` — type alias for `DatabaseSync`. Every consumer imports this
  type from here, never from `node:sqlite` directly, so the migration shape
  is consistent.
- `Statement` — type alias for `StatementSync`.

## Migration patterns from better-sqlite3

| `better-sqlite3`                          | shim                                 |
|-------------------------------------------|--------------------------------------|
| `import Database from "better-sqlite3"`    | `import { openDatabase, type Database } from ".../infra/sqlite/index.js"` |
| `Database.Database` (type)                 | `Database`                           |
| `new Database(path)`                       | `openDatabase(path)`                 |
| `new Database(path, { readonly: true, fileMustExist: true })` | `openDatabase(path, { readonly: true, fileMustExist: true })` |
| `db.pragma("journal_mode = WAL")`          | (built into `openDatabase` defaults) |
| `db.pragma("foo = bar")` (custom)          | `db.exec("PRAGMA foo = bar")`        |
| `const tx = db.transaction(fn); tx()`      | `transaction(db, fn)`                |
| `db.transaction(fn)()` (one-shot)          | `transaction(db, fn)`                |
| `db.prepare(sql).run/.get/.all/.iterate`   | unchanged — same names               |
| `db.close()`                               | unchanged                            |
| `db.exec(sql)`                             | unchanged                            |

## Compatibility notes

- **Row prototype**: `node:sqlite` returns rows as `[Object: null prototype]`
  objects. Spread (`...row`), `JSON.stringify`, key access (`row.x`), and
  `Object.keys/entries` all work. `row instanceof Object` is `false` —
  do not rely on this. The codebase does not.
- **`RETURNING` support**: SQLite engine supports it (3.35+). `node:sqlite`
  bundles a recent SQLite. The existing `supportsUpdateReturning()` probe in
  `core/control-db.ts` continues to work as-is via `db.prepare(...).get()`.
- **Transactions are not re-entrant.** `transaction(db, () => transaction(db, ...))`
  will fail with "cannot start a transaction within a transaction." The
  codebase does not nest today; if a future caller needs to, extend the
  helper to use SAVEPOINTs.
- **Bigints**: default off (`setReadBigInts(false)` is the default). Matches
  better-sqlite3. If a future caller stores 64-bit integers, opt in
  per-statement.

## Lessons Learned

- (None yet — file created 2026-05-07 alongside Task 2 of the Node 26
  modernization plan.)
