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
- `Database` — permissive structural interface over `DatabaseSync` (see
  `index.ts` for rationale; node:sqlite's strict `SQLInputValue`/`SQLOutputValue`
  signatures don't fit better-sqlite3-style call sites that pass typed param
  objects with nested fields and `as TableRow` cast results). Every consumer
  imports this type from here, never from `node:sqlite` directly.
- `Statement` — permissive structural interface over `StatementSync`. Same
  rationale as `Database`.

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
- **Nested transactions use SAVEPOINTs.** Outer `transaction(db, ...)` runs
  `BEGIN IMMEDIATE`; nested calls run `SAVEPOINT _compat_<depth>` and roll
  back to the savepoint on throw. Mirrors better-sqlite3's behavior so
  callers like `rebuildProjectionForDate` (which itself wraps each
  `applyTrackerEntry` in a transaction) work unchanged. Depth is tracked in
  a module-level `WeakMap<Database, number>`.
- **Unknown named parameters are silently ignored.** The shim's `prepare`
  calls `setAllowUnknownNamedParameters(true)` on every prepared statement.
  better-sqlite3 ignored extra keys in bound objects; node:sqlite throws
  "Unknown named parameter" by default. The codebase passes bundled param
  objects across multiple statements, so this knob preserves the prior
  contract without per-callsite cleanup.
- **Bigints**: default off (`setReadBigInts(false)` is the default). Matches
  better-sqlite3. If a future caller stores 64-bit integers, opt in
  per-statement.

## Lessons Learned

- **2026-06-24: Do NOT cache prepared statements in the shim (tried + reverted).** node:sqlite doesn't cache `prepare()` internally, so memoizing `StatementSync` by SQL text looked like a free hot-path win. But `openStateDb` memoizes the CONNECTION per tracker dir, and a `.tracker/state.db` deletion+recreation can outlive that handle (see the "DB handles are file-sensitive… resolve DB handles at request/tick time" rule in `tracker/CLAUDE.md`). A cached statement then points at the stale handle → an order-dependent INSERT/transaction failure that only surfaces when test files run together (passes in isolation). Re-preparing per call is the safe behavior; the compile cost is not worth the staleness risk.
- **2026-05-07: `[Object: null prototype]` rows + `assert.deepEqual`.** `node:sqlite` returns rows as null-prototype objects. `node:assert/strict`'s `assert.deepEqual` checks prototypes, so `deepEqual(row, { a: 1 })` will fail even with identical keys/values. In tests, spread the row before comparing: `deepEqual(rows.map(r => ({...r})), [...])`. The semantic check is preserved; the prototype mismatch is the only thing being normalized away.
- **2026-05-07: `setAllowUnknownNamedParameters(true)` is wrapper-only.** `openDatabase` enables this on every prepared statement so callers can pass blob-style params (object with extra fields the SQL doesn't reference) — matches the codebase's pre-existing pattern from `better-sqlite3`. Callers who bypass the wrapper by constructing `DatabaseSync` directly via the re-export get strict node:sqlite semantics back. If you need that escape hatch, you also need to call `stmt.setAllowUnknownNamedParameters(true)` yourself per statement.
