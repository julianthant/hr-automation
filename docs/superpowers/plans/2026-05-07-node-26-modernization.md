# Node 26 Modernization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the project to Node 26 and adopt the runtime-built-in features that genuinely replace existing dependencies or hand-rolled patterns: `node:sqlite` (replaces `better-sqlite3` — removes the only native-build dep), `node:util.styleText` (replaces `picocolors`), targeted `AbortSignal.timeout()` swaps for hand-rolled timeout patterns, bumped `@types/node` (unlocks Node 26 API typings in TS), and a documented modernization baseline.

**Architecture:** A small compat shim (`src/infra/sqlite/`) abstracts `node:sqlite`'s `DatabaseSync` and provides the `transaction(db, fn)` helper that `node:sqlite` lacks. All 17 existing `better-sqlite3` callers swap to the shim atomically in one task — splitting the migration breaks typecheck because `Database.Database` propagates through public function signatures. AbortSignal modernization is targeted only at hand-rolled "AbortController + setTimeout" timeout patterns where Node 26's primitives are a clean replacement; sites that race Playwright `Page.waitForTimeout` or arbitrary promises against a signal are left alone (the modern primitives don't simplify them).

**Tech Stack:** Node 26.1+, TypeScript 5.9, `node:sqlite` `DatabaseSync` / `StatementSync`, `node:util` `styleText`, `node:timers/promises` `setTimeout(ms, value, { signal })`, tsx 4 (kept as the runtime executor — native TS execution rejected, see brainstorming history).

**Out of scope (deliberately deferred):**
- Native TS execution / dropping `tsx` — codemod cost (`.js` → `.ts` import rewrite across hundreds of files) outweighs the marginal cold-start win.
- Permission-model enforcement on by default — operational cost (allowlist maintenance per write path) outweighs threat-model value for an internal tool. Documented only.
- Codemodding existing `Promise`/loop code to `Promise.withResolvers` / iterator helpers — aesthetic, not behavioral. Adopt going forward only.
- `commander` → `node:util.parseArgs` for the user-facing CLI — too much churn, no real win. `parseArgs` documented as the preferred choice for new internal scripts only.

**Branching strategy (per global CLAUDE.md):**
- Tasks 1, 2, 3, 6, 7 are sequential on master (Task 3 depends on Task 2's shim; Tasks 6/7 close out).
- Tasks 4 and 5 are independent and dispatch in parallel via worktrees (`feature/task-4-styletext`, `feature/task-5-abortsignal`). Orchestrator merges them sequentially after both verify, then continues with Task 6.

**Test gates per task:** `npm run typecheck`, `npm run typecheck:all`, `npm run test`, `npm run test:architecture`. The third (`test`) runs the full suite — note the slow tests under `tests/unit/core/daemon.test.ts` and `tests/unit/tracker/state-db.test.ts` exercise the SQLite layer end-to-end and are the primary safety net for Task 3.

---

## Task 1: Engine pin & toolchain alignment

**Files:**
- Modify: `package.json` (add `engines`, bump `@types/node` 25→26)
- Create: `.nvmrc`
- Modify: `tsconfig.json` (`target` ES2022→ES2024, add `lib`)

**Why this is one commit:** Pure config. Establishes that the rest of the plan can rely on Node 26 APIs without per-file `// @ts-expect-error` workarounds.

- [ ] **Step 1: Add `engines` and bump `@types/node`**

Edit `package.json`. Add the `engines` block immediately after `"license"`:

```json
  "license": "ISC",
  "engines": {
    "node": ">=26.0.0",
    "npm": ">=11.0.0"
  },
  "type": "module",
```

In `devDependencies`, change `"@types/node": "^25.5.0"` to `"@types/node": "^26.0.0"`.

- [ ] **Step 2: Create `.nvmrc`**

Create `.nvmrc` at the repo root with exactly this content (one line, no trailing newline behavior matters for nvm):

```
26.1.0
```

- [ ] **Step 3: Update `tsconfig.json`**

Edit `tsconfig.json`. Change `"target": "ES2022"` to `"target": "ES2024"` and add a `"lib"` entry. The full `compilerOptions` should look like:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/dashboard/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["src/dashboard/**/*"]
}
```

Rationale: ES2024 unlocks `Promise.withResolvers`, iterator helpers, `Array.fromAsync`, `Object.groupBy`. The `lib` array is needed because Node code uses `console`, `URL`, `fetch`, etc. — those come from `DOM` (Node 24+ types route Web APIs through DOM lib for compatibility). Without `lib`, TypeScript would default-include the entire DOM lib, but being explicit prevents a future `target` bump from silently dropping `DOM`.

- [ ] **Step 4: Install + verify**

Run sequentially:

```bash
node --version          # expect: v26.x.x (you've already updated)
npm install             # picks up new @types/node
npm run typecheck       # expect: no errors
npm run typecheck:all   # expect: no errors
```

If `typecheck` surfaces new strictness errors from `@types/node` v26, fix them inline — they will be small (signature tightening on Node API methods, never feature changes). Do NOT add `// @ts-expect-error` to suppress them. If a strictness error spans more than ~5 sites, stop and surface to the orchestrator.

- [ ] **Step 5: Run the full test suite as a baseline**

```bash
npm run test
npm run test:architecture
```

Both must pass. If anything fails, the rest of the plan is built on a broken baseline — do not proceed.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .nvmrc tsconfig.json
git commit -m "$(cat <<'EOF'
chore(node26): pin engines, bump @types/node 25→26, target ES2024

Establishes the Node 26 floor for the modernization plan. ES2024 lib unlocks
Promise.withResolvers, iterator helpers, Array.fromAsync at the type level so
later tasks can adopt them without per-file overrides.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: SQLite compat shim

**Files:**
- Create: `src/infra/sqlite/index.ts`
- Create: `src/infra/sqlite/CLAUDE.md`
- Create: `tests/unit/infra/sqlite.test.ts`

**Why this is one commit:** The shim has no callers yet, so it's purely additive. Establishes the API surface that Task 3 migrates onto.

- [ ] **Step 1: Write the shim**

Create `src/infra/sqlite/index.ts`:

```ts
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
```

- [ ] **Step 2: Write the shim docs**

Create `src/infra/sqlite/CLAUDE.md`:

```markdown
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
```

- [ ] **Step 3: Write shim unit tests**

Create `tests/unit/infra/sqlite.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase, transaction, type Database } from "../../../src/infra/sqlite/index.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sqlite-shim-test-"));
}

test("openDatabase creates parent directory if missing", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "nested", "deep", "test.db");
    const db = openDatabase(path);
    assert.equal(existsSync(path), true);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase applies default pragmas", () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(join(dir, "test.db"));
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const sync = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    const fk = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    assert.equal(journal.journal_mode.toLowerCase(), "wal");
    assert.equal(sync.synchronous, 1);
    assert.equal(fk.foreign_keys, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase honors applyDefaultPragmas: false", () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(join(dir, "test.db"), { applyDefaultPragmas: false });
    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.notEqual(journal.journal_mode.toLowerCase(), "wal");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase fileMustExist throws when missing", () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => openDatabase(join(dir, "missing.db"), { fileMustExist: true }),
      /not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openDatabase readonly opens existing file without applying pragmas", () => {
  const dir = makeTempDir();
  try {
    const path = join(dir, "test.db");
    // Create + populate.
    const writer = openDatabase(path);
    writer.exec("CREATE TABLE t(x INTEGER)");
    writer.exec("INSERT INTO t VALUES (1)");
    writer.close();

    // Read-only re-open.
    const reader = openDatabase(path, { readonly: true });
    const row = reader.prepare("SELECT x FROM t").get() as { x: number };
    assert.equal(row.x, 1);
    assert.throws(() => reader.exec("INSERT INTO t VALUES (2)"));
    reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction commits on success", () => {
  const dir = makeTempDir();
  try {
    const db: Database = openDatabase(join(dir, "test.db"));
    db.exec("CREATE TABLE t(x INTEGER)");
    transaction(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      db.exec("INSERT INTO t VALUES (2)");
    });
    const rows = db.prepare("SELECT x FROM t ORDER BY x").all() as { x: number }[];
    assert.deepEqual(rows.map((r) => r.x), [1, 2]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction rolls back on throw and re-throws", () => {
  const dir = makeTempDir();
  try {
    const db: Database = openDatabase(join(dir, "test.db"));
    db.exec("CREATE TABLE t(x INTEGER)");
    db.exec("INSERT INTO t VALUES (1)");
    assert.throws(
      () =>
        transaction(db, () => {
          db.exec("INSERT INTO t VALUES (2)");
          throw new Error("boom");
        }),
      /boom/,
    );
    const rows = db.prepare("SELECT x FROM t").all() as { x: number }[];
    assert.deepEqual(rows.map((r) => r.x), [1], "row 2 must be rolled back");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transaction returns the body's return value", () => {
  const dir = makeTempDir();
  try {
    const db: Database = openDatabase(join(dir, "test.db"));
    db.exec("CREATE TABLE t(x INTEGER)");
    const result = transaction(db, () => {
      db.exec("INSERT INTO t VALUES (42)");
      return (db.prepare("SELECT x FROM t").get() as { x: number }).x;
    });
    assert.equal(result, 42);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the new tests**

The `npm run test` script wraps `scripts/run-tests.mjs` which takes a directory and walks it for `.test.ts` files; it does not honor extra `--` filter args. To run just the new shim test, invoke `tsx` directly:

```bash
tsx --test tests/unit/infra/sqlite.test.ts
```

Expected: 7 tests pass. If any fail, fix the shim — DO NOT proceed to Task 3 with a broken shim.

- [ ] **Step 5: Typecheck + full suite**

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

All must pass. The full suite still runs against `better-sqlite3` because no callers have migrated yet.

- [ ] **Step 6: Commit**

```bash
git add src/infra/sqlite/ tests/unit/infra/sqlite.test.ts
git commit -m "$(cat <<'EOF'
feat(infra/sqlite): node:sqlite compat shim with transaction helper

Adds openDatabase / transaction / Database type alias backed by
node:sqlite's DatabaseSync. The transaction helper fills the
db.transaction(fn) gap (node:sqlite doesn't expose one) using
BEGIN IMMEDIATE/COMMIT/ROLLBACK. No callers migrated yet — shim is
purely additive in this commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Migrate all SQLite callers to the shim

**Files (17 total):**
- Modify: `src/core/control-db.ts`
- Modify: `src/core/task-store/index.ts`
- Modify: `src/core/task-store/types.ts`
- Modify: `src/core/task-store/enqueue.ts`
- Modify: `src/core/task-store/claim.ts`
- Modify: `src/core/task-store/child-state.ts`
- Modify: `src/core/task-store/retry.ts`
- Modify: `src/core/task-store/terminal.ts`
- Modify: `src/core/daemon/worker-store.ts`
- Modify: `src/tracker/state/db.ts`
- Modify: `src/tracker/state/apply.ts`
- Modify: `src/tracker/state/queries.ts`
- Modify: `src/tracker/state/rebuild.ts`
- Modify: `src/tracker/tasks/store.ts`
- Modify: `src/tracker/dashboard/hono/context.ts`
- Modify: `src/tracker/files/files.ts`
- Modify: `src/tracker/files/pdf-cache.ts`
- Modify: `tests/unit/tracker/state-db.test.ts`
- Modify: `package.json` (remove `better-sqlite3`, `@types/better-sqlite3`)

**Why this is one commit:** The `Database.Database` type propagates through public function signatures across all 17 files. A partial migration breaks typecheck. Mechanical search/replace; the shim is the only API change.

**Risk note:** This is the highest-blast-radius task in the plan. The daemon control DB and tracker state DB are critical infrastructure. The existing test suite (especially `tests/unit/tracker/state-db.test.ts` and `tests/unit/core/daemon.test.ts`) is the safety net — both must still pass after migration.

- [ ] **Step 1: Inventory imports**

Run this to confirm the migration scope hasn't drifted from the plan:

```bash
grep -rln "better-sqlite3" src/ tests/
```

Expected output: exactly the 18 files listed above (17 source + 1 test). If additional files appear, surface to the orchestrator before migrating.

- [ ] **Step 2: Define the import path helper**

For each file, the shim's import path is computed relative to `src/infra/sqlite/index.js`. The replacement pattern is:

| File location                                | Import path                               |
|----------------------------------------------|-------------------------------------------|
| `src/core/control-db.ts`                     | `../infra/sqlite/index.js`                |
| `src/core/task-store/*.ts`                   | `../../infra/sqlite/index.js`             |
| `src/core/daemon/worker-store.ts`            | `../../infra/sqlite/index.js`             |
| `src/tracker/state/*.ts`                     | `../../infra/sqlite/index.js`             |
| `src/tracker/tasks/store.ts`                 | `../../infra/sqlite/index.js`             |
| `src/tracker/dashboard/hono/context.ts`      | `../../../infra/sqlite/index.js`          |
| `src/tracker/files/*.ts`                     | `../../infra/sqlite/index.js`             |
| `tests/unit/tracker/state-db.test.ts`        | `../../../src/infra/sqlite/index.js`      |

- [ ] **Step 3: Migrate `src/core/control-db.ts`**

Replace the file contents with:

```ts
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
```

Key changes vs original:
- Import from shim instead of `better-sqlite3`.
- `Database.Database` → `Database` (3 sites).
- `openStandaloneDb` reduces to `openDatabase(path)` (the shim handles dir creation + pragmas).
- `transaction()` method delegates to the shim helper.

- [ ] **Step 4: Migrate `src/tracker/state/db.ts`**

Replace the file contents with:

```ts
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
```

Key changes:
- Import from shim, drop `mkdirSync`/`existsSync` for dir creation (shim handles it).
- `Database.Database` → `Database` (5 sites).
- `new Database(path)` + 4 pragmas → `openDatabase(path)`.
- `new Database(path, { readonly, fileMustExist })` → `openDatabase(path, { readonly: true, fileMustExist: true, applyDefaultPragmas: false })`. Read-only opens skip pragmas.
- `db.transaction(() => {...})()` → `transaction(db, () => {...})`.

- [ ] **Step 5: Migrate the remaining 15 source files (mechanical pass)**

For each file in this list, perform the same mechanical transformation:

```
src/core/task-store/index.ts
src/core/task-store/types.ts
src/core/task-store/enqueue.ts
src/core/task-store/claim.ts
src/core/task-store/child-state.ts
src/core/task-store/retry.ts
src/core/task-store/terminal.ts
src/core/daemon/worker-store.ts
src/tracker/state/apply.ts
src/tracker/state/queries.ts
src/tracker/state/rebuild.ts
src/tracker/tasks/store.ts
src/tracker/dashboard/hono/context.ts
src/tracker/files/files.ts
src/tracker/files/pdf-cache.ts
```

For each file:

1. Replace any `import Database from "better-sqlite3"` line with the shim import. Most of these files only need the **type** because they receive `db: Database` as a parameter — they don't construct DBs. So the right import shape is usually:

   ```ts
   import { type Database } from "<shim-path>";
   ```

   Use the path from the table in Step 2.

2. Replace every occurrence of `Database.Database` with `Database` (the imported type alias). Use case-sensitive search.

3. If the file calls `db.transaction(fn)` directly (not via the `control.transaction(...)` wrapper from `ControlDb`), replace with `transaction(db, fn)` and add `transaction` to the shim import. Per the audit in the plan-writing pass, only `src/tracker/tasks/scheduler.ts:154` does this — but `scheduler.ts` is not in this task's file list because it doesn't import `better-sqlite3` directly. Re-check:

   ```bash
   grep -n "\.transaction(" src/tracker/tasks/scheduler.ts
   ```

   If `scheduler.ts` calls `.transaction()` on a `Database` value (not on a `ControlDb`), it must also be updated — but its import comes via type propagation from `task-store/types.ts`. Verify with:

   ```bash
   grep -n "import.*better-sqlite3\|Database\." src/tracker/tasks/scheduler.ts
   ```

   If it has no direct import, no change is needed there.

4. If the file calls `db.pragma(...)` (Step 4 above is the only instance — `tracker/state/db.ts` — already handled). Re-grep to confirm no others were missed:

   ```bash
   grep -rn "\.pragma(" src/
   ```

   Expected: empty after Step 4. If any remain, replace with `db.exec("PRAGMA <expr>")`.

5. If the file calls `new Database(path)` directly, replace with `openDatabase(path)`. Re-grep:

   ```bash
   grep -rn "new Database(" src/
   ```

   Expected: empty (only `core/control-db.ts` and `tracker/state/db.ts` constructed DBs, both handled in Steps 3-4). If any remain, replace.

- [ ] **Step 6: Migrate the test file**

Open `tests/unit/tracker/state-db.test.ts`. Replace any `import Database from "better-sqlite3"` and `Database.Database` references the same way. Use shim import path `../../../src/infra/sqlite/index.js`.

- [ ] **Step 7: Remove `better-sqlite3` from `package.json`**

Edit `package.json`:
- Remove `"better-sqlite3": "^12.9.0",` from `dependencies`.
- Remove `"@types/better-sqlite3": "^7.6.13",` from `devDependencies`.

Run:

```bash
npm install
```

Expected: `npm install` completes WITHOUT a native build step. No `node-gyp` output. No `Building: better-sqlite3` line. If the install runs node-gyp, something else still depends on it — investigate (`npm ls better-sqlite3`) and surface to the orchestrator.

- [ ] **Step 8: Verify**

Run sequentially:

```bash
npm run typecheck
npm run typecheck:all
npm run test
npm run test:architecture
```

All four must pass.

The most informative failures, if any:
- **Typecheck failure on `Database.Database`**: a file was missed in the migration. Re-run `grep -rn "Database\.Database\|better-sqlite3" src/ tests/`. Expected: empty.
- **`tests/unit/tracker/state-db.test.ts` failure**: the shim's behavior diverges from `better-sqlite3` in some subtle way. Inspect the failing assertion. The most likely culprit is the `[null prototype]` row shape (e.g. a test that does `assert.deepEqual(row, { x: 1 })` with `Object.create(null)` mismatch). Resolve by either tweaking the assertion or having the shim return plain objects (more invasive — only do this if multiple sites need it).
- **`tests/unit/core/daemon.test.ts` failure**: the SQLite-backed worker/queue layer behavior diverged. Inspect.

- [ ] **Step 9: Smoke daemon claim semantics manually**

This is the one path the unit tests don't fully cover end-to-end. Run a real workflow and confirm the queue claim works:

```bash
npm run eid-lookup -- "Test, User"
# Wait for daemon to finish (or Ctrl+C after a few seconds; the queue claim
# happens on enqueue + first poll)
npm run eid-lookup:stop
```

Expected: the daemon spawns, the eid-lookup item appears in the queue, the daemon claims it. If the claim path is broken, the item will sit unclaimed in `.tracker/daemons/eid-lookup.queue.jsonl` while the daemon's lockfile is alive.

If you cannot run a real daemon (e.g. no UCSD credentials in the dev environment), document this in the commit message and surface to the orchestrator for explicit smoke-test sign-off.

- [ ] **Step 10: Commit**

```bash
git add -A src/ tests/ package.json package-lock.json
git commit -m "$(cat <<'EOF'
refactor(sqlite): migrate from better-sqlite3 to node:sqlite via compat shim

Swaps all 17 better-sqlite3 callers (core/control-db, task-store/*,
daemon/worker-store, tracker/state/*, tracker/files/*, tracker/tasks/store,
tracker/dashboard/hono/context, tests) to the new src/infra/sqlite shim.
Removes better-sqlite3 + @types/better-sqlite3 from package.json — no
native-build dependency remains in the project.

API surface unchanged: Database type alias, transaction(db, fn) helper,
openDatabase(path, opts) constructor with default project pragmas.
Daemon claim semantics + state-db migrations + RETURNING probe verified
via existing test suite + smoke run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `node:util.styleText` replaces `picocolors`

**Files:**
- Modify: `src/utils/log.ts`
- Modify: `src/scripts/ops/setup.ts`
- Modify: `package.json` (remove `picocolors`)
- Modify: `src/utils/CLAUDE.md` (update the "Uses `picocolors`" line)

**Parallel-eligible with Task 5.** When dispatched in parallel: branch name `feature/task-4-styletext`, worktree under `.worktrees/task-4-styletext/`.

**Why this is one commit:** Two source files, one dep removal, one doc line. Fully self-contained.

- [ ] **Step 1: Migrate `src/utils/log.ts`**

The mapping from `picocolors` to `styleText`:

| `picocolors`              | `styleText`                          |
|---------------------------|--------------------------------------|
| `pc.gray(s)`              | `styleText("gray", s)`               |
| `pc.blue(s)`              | `styleText("blue", s)`               |
| `pc.green(s)`             | `styleText("green", s)`              |
| `pc.yellow(s)`            | `styleText("yellow", s)`             |
| `pc.red(s)`               | `styleText("red", s)`                |
| `pc.magenta(s)`           | `styleText("magenta", s)`            |
| `pc.bold(s)`              | `styleText("bold", s)`               |
| `pc.dim(s)`               | `styleText("dim", s)`                |
| `pc.dim(pc.red(s))`       | `styleText(["dim", "red"], s)`       |

Replace `import pc from "picocolors";` with `import { styleText } from "node:util";` and translate every `pc.X(...)` call. The file currently uses: `gray`, `blue`, `green`, `yellow`, `red`, `magenta`. The full updated `src/utils/log.ts` should have these specific lines changed (line numbers from the pre-migration read; verify before editing):

- Line 1: `import pc from "picocolors";` → `import { styleText } from "node:util";`
- Line 66: `console.log(pc.gray("· " + msg));` → `console.log(styleText("gray", "· " + msg));`
- Line 90: `console.log(pc.magenta(...) + " " + body);` → `console.log(styleText("magenta", \`[E2E][${ts}][${category}]\`) + " " + body);`
- Line 94: `pc.blue("->")` → `styleText("blue", "->")`
- Line 95: `pc.green("✓")` → `styleText("green", "✓")`
- Line 96: `pc.yellow("⌛")` → `styleText("yellow", "⌛")`
- Line 97: `pc.yellow("!")` → `styleText("yellow", "!")`
- Line 98: `pc.red("✗")` → `styleText("red", "✗")`

- [ ] **Step 2: Migrate `src/scripts/ops/setup.ts`**

Replace `import pc from "picocolors";` with `import { styleText } from "node:util";`. Translate every `pc.X(...)` call using the same mapping. The file uses: `green`, `yellow`, `red`, `bold`, `dim`. Re-grep to confirm coverage after editing:

```bash
grep -n "pc\." src/scripts/ops/setup.ts
```

Expected: empty.

- [ ] **Step 3: Verify no other callers**

```bash
grep -rln "picocolors" src/ tests/ scripts/
```

Expected: empty (the original audit found only the two files above; verify nothing else slipped in).

- [ ] **Step 4: Update `src/utils/CLAUDE.md`**

In the file body, replace the line:
> Uses `picocolors` for colorization. Only `log.error()` uses `console.error` (stderr); all others use `console.log` (stdout).

with:
> Uses `node:util` `styleText` for colorization (replaces the prior `picocolors` dep, which respected fewer environment hints). Only `log.error()` uses `console.error` (stderr); all others use `console.log` (stdout). `styleText` honors `NO_COLOR`, `FORCE_COLOR`, and TTY detection automatically.

- [ ] **Step 5: Remove dep + install**

Edit `package.json`. Remove `"picocolors": "^1.1.1",` from `dependencies`. Run:

```bash
npm install
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
npm run test
```

The `setup` and `log` tests (if any) should pass. Visual smoke:

```bash
node --env-file=.env -e 'import("./src/utils/log.js").then(m => { m.log.step("hello"); m.log.success("done"); m.log.warn("warn"); m.log.error("oops"); })'
```

Expected: colored output (blue arrow, green check, yellow exclaim, red X). If output is uncolored, `styleText` is detecting non-TTY — that's expected when stdout is piped, but in a normal terminal it should be colored.

- [ ] **Step 7: Commit**

```bash
git add src/utils/log.ts src/scripts/ops/setup.ts src/utils/CLAUDE.md package.json package-lock.json
git commit -m "$(cat <<'EOF'
refactor(utils/log): node:util styleText replaces picocolors

Drops picocolors in favor of Node 26's built-in styleText, which honors
NO_COLOR / FORCE_COLOR / TTY detection without a userland dep. Two call
sites updated (utils/log.ts, scripts/ops/setup.ts); behavior identical
in a TTY, more correct when piped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Targeted `AbortSignal.timeout()` and `node:timers/promises` swaps

**Files (6 sites total):**
- Modify: `src/core/daemon/registry.ts:118-121` (probeWhoami timeout-as-abort)
- Modify: `src/core/kernel/session.ts:683-703` (`abortableDelay` helper)
- Modify: `src/tracker/sessions/duo-queue.ts:122-140` (`waitForDuoQueue` helper)
- Modify: `tests/unit/tracker/dashboard-hono-retirement.test.ts:54-55`
- Modify: `tests/unit/tracker/run-events-sse.test.ts:26-27`
- Modify: `tests/unit/tracker/events-runid-fallback.test.ts:27-28`

**Parallel-eligible with Task 4.** Branch `feature/task-5-abortsignal`, worktree `.worktrees/task-5-abortsignal/`.

**Out of scope (left as-is):**
- `src/infra/auth/duo-poll.ts:abortableSleep` — wraps Playwright's `page.waitForTimeout`, not Node's `setTimeout`. Replacing it would change behavior (Playwright's sleep can pause under debugger, etc.). Not a clean win.
- `src/core/kernel/session.ts:raceAbort` — races an arbitrary `Promise<T>` against a signal. Not a sleep; Node's modern primitives don't simplify this.
- `src/core/daemon/daemon.ts:111` (`launchAbort = new AbortController()`) — one-shot abort triggered by error paths, not a timeout. Stays.

**Why this is one commit:** Six surgical edits; no shared infrastructure. All apply the same mental pattern (replace hand-rolled `AbortController + setTimeout` with `AbortSignal.timeout(ms)` for fetch-style timeouts, or replace hand-rolled `setTimeout + addEventListener("abort")` with `node:timers/promises` `setTimeout(ms, value, { signal })` for abortable sleeps).

- [ ] **Step 1: `src/core/daemon/registry.ts` — probeWhoami**

Replace lines 118-121 (the `probeWhoami` body inside the try block):

```ts
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: ctrl.signal })
    clearTimeout(t)
```

with:

```ts
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
```

`AbortSignal.timeout(ms)` returns a signal that aborts after `ms` and is GC'd when the fetch settles. No manual cleanup needed.

- [ ] **Step 2: `src/core/kernel/session.ts` — abortableDelay**

Replace the `abortableDelay` function (lines ~683-703):

```ts
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
```

with:

```ts
import { setTimeout as sleep } from 'node:timers/promises'

// ... rest of file ...

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal })
  } catch (err) {
    // node:timers/promises throws AbortError with the signal's reason
    // attached as `cause`. Surface our codebase's abortReason() shape so
    // existing callers see the same Error instance shape they got before.
    if (signal?.aborted) throw abortReason(signal)
    throw err
  }
}
```

Add the `import` at the top of the file (with the other imports). The `node:timers/promises` `setTimeout` accepts an optional `AbortSignal` and rejects with `AbortError` if the signal aborts. The try/catch translates back to the codebase's `abortReason()` error shape so callers don't need to change.

If the file already imports anything from `node:timers/promises`, just add `setTimeout as sleep` to the existing import list.

- [ ] **Step 3: `src/tracker/sessions/duo-queue.ts` — waitForDuoQueue**

Replace the `waitForDuoQueue` function (lines 122-140):

```ts
function waitForDuoQueue(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) return new Promise((r) => setTimeout(r, ms));
  if (abortSignal.aborted) return Promise.reject(duoQueueAbortReason(abortSignal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(duoQueueAbortReason(abortSignal));
    };
    const cleanup = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}
```

with:

```ts
import { setTimeout as sleep } from "node:timers/promises";

// ... rest of file ...

async function waitForDuoQueue(ms: number, abortSignal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) throw duoQueueAbortReason(abortSignal);
    throw err;
  }
}
```

Add the import at the top (or extend an existing `node:timers/promises` import).

- [ ] **Step 4: Update test helpers**

For each of the three test files, replace the `new AbortController() + setTimeout` pattern with `AbortSignal.timeout(ms)`. The pattern in each file looks like:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
// ... fetch with controller.signal ...
clearTimeout(timer);
```

Replace with:

```ts
// ... fetch with signal: AbortSignal.timeout(opts.timeoutMs) ...
```

And remove the `controller`, `timer`, and `clearTimeout` lines.

Files:
- `tests/unit/tracker/dashboard-hono-retirement.test.ts:54-55` (1500ms timeout literal — verify the surrounding context to thread the signal into the right fetch call)
- `tests/unit/tracker/run-events-sse.test.ts:26-27` (`opts.timeoutMs`)
- `tests/unit/tracker/events-runid-fallback.test.ts:27-28` (`opts.timeoutMs`)

For each, after replacing the controller pattern, search the surrounding ~10 lines for the `fetch(...)` call and confirm it's using `signal: AbortSignal.timeout(...)`. If the controller was used elsewhere in the test (e.g. for manual abort scenarios), keep it for that scenario and use `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])` to compose. Re-read the surrounding code before editing.

- [ ] **Step 5: Verify**

```bash
npm run typecheck
npm run typecheck:all
npm run test
npm run test:architecture
```

The most informative tests for this task: the daemon registry probe tests (`tests/unit/core/daemon-registry.test.ts` if present), Duo poll tests (`tests/unit/infra/auth/duo-poll.test.ts`), kernel session tests (`tests/unit/core/session.test.ts`), and the three SSE/Hono integration tests directly modified.

If `tests/unit/core/session.test.ts` fails specifically on the abort path: the `abortReason` translation in Step 2 may have changed which Error instance is thrown. Check that the test's `assert.rejects(...)` matcher still recognizes the error.

- [ ] **Step 6: Commit**

```bash
git add src/core/daemon/registry.ts src/core/kernel/session.ts src/tracker/sessions/duo-queue.ts tests/unit/tracker/dashboard-hono-retirement.test.ts tests/unit/tracker/run-events-sse.test.ts tests/unit/tracker/events-runid-fallback.test.ts
git commit -m "$(cat <<'EOF'
refactor(abort): AbortSignal.timeout + node:timers/promises sleep

Replaces six hand-rolled AbortController + setTimeout patterns with
Node 26 primitives:
- daemon/registry.ts probeWhoami → AbortSignal.timeout(ms) on fetch
- kernel/session.ts abortableDelay → node:timers/promises sleep with signal
- duo-queue.ts waitForDuoQueue → node:timers/promises sleep with signal
- 3 test helpers → AbortSignal.timeout(ms) on fetch

abortableSleep (Playwright-based) and raceAbort (arbitrary-promise-based)
left as-is — modern primitives don't simplify those shapes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `dashboard:watch` script

**Files:**
- Modify: `package.json` (add `dashboard:watch` script)
- Modify: `src/dashboard/CLAUDE.md` (or root `CLAUDE.md` Commands section — pick whichever already documents dashboard scripts)

**Why this is small:** One-line script + one doc note. Closes the "backend doesn't hot-reload" friction (memory: `reference_dashboard_restart_required.md`).

**Honest framing:** This task uses `tsx watch`, not Node's native `--watch`. `tsx` is staying per the brainstorm decision; its watch mode is the right tool while it's the runtime. Documented so future-you doesn't think "Node 26 brings hot-reload" — `tsx watch` already had it.

- [ ] **Step 1: Add the script**

Edit `package.json`. In the `scripts` block, immediately after the existing `"dashboard:tunneled"` line, add:

```json
    "dashboard:watch": "tsx watch --env-file=.env src/cli.ts dashboard",
```

- [ ] **Step 2: Document it**

Edit the project's root `CLAUDE.md`. In the Commands section, find the Dashboard subsection and add the new script line:

```bash
npm run dashboard            # SSE backend (:3838) + Vite dev (:5173) — open http://localhost:5173
npm run dashboard:watch      # Same as `dashboard`, but the SSE backend hot-reloads on src/ changes via tsx watch
npm run dashboard:prod       # Serve pre-built dashboard from SSE only
```

- [ ] **Step 3: Verify**

```bash
npm run dashboard:watch &
DASHBOARD_PID=$!
sleep 5
curl -sf http://localhost:3838/api/workflow-definitions > /dev/null && echo "OK: SSE up"
# touch a backend file to trigger restart
touch src/tracker/dashboard.ts
sleep 3
curl -sf http://localhost:3838/api/workflow-definitions > /dev/null && echo "OK: SSE up after restart"
kill $DASHBOARD_PID 2>/dev/null || true
```

Expected: both `OK` lines printed. The `touch` triggers `tsx watch` to restart the process; the second curl hits the new instance.

If the second `curl` fails: tsx watch may not be picking up `src/tracker/`. Check that the watched paths include `src/` (tsx watches the entry file's project root by default, which should cover `src/`).

- [ ] **Step 4: Commit**

```bash
git add package.json CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(dashboard): add dashboard:watch for backend hot-reload during dev

Runs the SSE backend under tsx watch so src/ edits restart the server
automatically. Closes the "Node SSE server on :3838 does not hot-reload"
friction in dashboard backend work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Documentation pass — Node 26 conventions + permission-model recipe

**Files:**
- Modify: root `CLAUDE.md` (add "Node 26 conventions" section + "Sandboxing (optional)" subsection)
- Modify: `LESSONS.md` (project root — add dated entry)

**Why this is one commit and goes last:** Documentation should reflect what actually shipped, not what was planned. Run after all prior tasks are merged.

- [ ] **Step 1: Add "Node 26 conventions" to root `CLAUDE.md`**

Insert this new section between the existing "Codebase conventions" and "Shared workflow primitives" sections:

```markdown
## Node 26 conventions

Floor: Node 26.0.0 (pinned via `engines` + `.nvmrc`). Prefer the Node 26 primitives below over older equivalents in new code. Do **not** codemod existing working code for aesthetic reasons — adopt these as files are touched.

| Use this | Instead of | When |
|---|---|---|
| `Promise.withResolvers()` | `let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j; })` | Building deferred promises (event handlers, lazy gates) |
| `Array.fromAsync(asyncIter)` | `const out = []; for await (const x of iter) out.push(x); return out;` | Materializing an async iterable |
| Iterator helpers (`.map/.filter/.take/.drop/.flatMap`) | `[...iter].map(...)` / `Array.from(iter).filter(...)` | Streaming transforms where you don't need the full array materialized |
| `AbortSignal.timeout(ms)` | `const c = new AbortController(); setTimeout(() => c.abort(), ms);` | Fetch / cancellation timeouts |
| `AbortSignal.any([a, b])` | Manual `addEventListener("abort", ...)` chaining | Composing multiple signals |
| `node:timers/promises` `setTimeout(ms, value, { signal })` | Hand-rolled abortable sleep | Sleep that should reject on abort |
| `import.meta.dirname` | `fileURLToPath(import.meta.url)` + `dirname()` | `__dirname` equivalent in ESM |
| `styleText("red", s)` from `node:util` | `chalk.red(s)` / `pc.red(s)` | Colored CLI output |
| `node:sqlite` (via `src/infra/sqlite/` shim) | `better-sqlite3` | Any SQLite — project default |
| `Object.groupBy(iter, fn)` | Reduce-into-accumulator | Bucketing items by key |
| `node:util.parseArgs` | `commander` (for **new internal scripts only**) | Tiny scripts in `src/scripts/` that don't need commander's subcommand tree |

**Type-stripping note:** The codebase uses `tsx` for runtime TS execution. Native `node --strip-types` is intentionally NOT used because the codebase imports relative paths with `.js` extensions and Node 26's strip-types mode does not rewrite `.js` → `.ts`. Migrating to native execution would require rewriting every relative import — rejected for a marginal cold-start win. If `tsx` ever drops support, revisit then.

### Sandboxing (optional)

Node 26's permission model can sandbox daemon processes so a Playwright bug or rogue selector cannot write outside expected paths. Disabled by default — the threat model for an internal HR tool running on operator machines doesn't justify the operational cost (every new write path becomes an allowlist edit).

To enable for a specific deployment, launch daemons with:

```bash
node --permission \
  --allow-fs-read=* \
  --allow-fs-write=/Users/$USER/Documents/hr-automation/.tracker \
  --allow-fs-write=/Users/$USER/Documents/hr-automation/.screenshots \
  --allow-fs-write=/tmp \
  --allow-child-process \
  ./node_modules/.bin/tsx --env-file=.env src/cli-daemon.ts <workflow>
```

Required flags:
- `--allow-fs-read=*` — Playwright reads from many paths (Chromium binaries, user-data-dir, system fonts).
- `--allow-fs-write=<tracker dir>` — JSONL emissions, SQLite state DB, screenshot uploads.
- `--allow-fs-write=<screenshots dir>` — debug screenshots written by `Stepper.step` on failure.
- `--allow-fs-write=/tmp` — Playwright + Chromium temp files.
- `--allow-child-process` — Playwright spawns Chromium.

Network access does not need a flag (allowed by default in the permission model).
```

- [ ] **Step 2: Add LESSONS.md entry**

Edit `LESSONS.md` at the project root. Append a new dated entry under the appropriate Lessons section:

```markdown
- **2026-05-07: Node 26 floor pinned; better-sqlite3 + picocolors removed.** Project now requires Node ≥26.0.0 (`engines` + `.nvmrc=26.1.0`). Two userland deps replaced by built-ins:
  - `better-sqlite3` → `node:sqlite` via the `src/infra/sqlite/` compat shim. Removes the only native-build dependency from the repo — `npm install` no longer needs `node-gyp` / Xcode CLI tools / Python. `transaction(db, fn)` helper fills the `db.transaction()` gap that `node:sqlite` doesn't expose. SQLite engine semantics identical (both libs link the same SQLite); only the JS bindings changed.
  - `picocolors` → `node:util.styleText`. Honors `NO_COLOR` / `FORCE_COLOR` / TTY detection natively.
  Six hand-rolled `AbortController + setTimeout` patterns replaced with `AbortSignal.timeout(ms)` (fetch timeouts) or `node:timers/promises` `setTimeout(ms, value, { signal })` (abortable sleeps). Native TS execution intentionally rejected — codebase uses `.js` extensions in relative imports, and Node 26's strip-types mode does not rewrite them. `tsx` remains the runtime executor; `npm run dashboard:watch` uses `tsx watch` for backend hot-reload. Permission model documented for opt-in sandboxing but not enabled by default. Full prefer-this-over-that table in root `CLAUDE.md` "Node 26 conventions" section.
```

(If `LESSONS.md` has dated subsections — e.g. "## 2026-05" — append under that heading. If it's flat, append at the end.)

- [ ] **Step 3: Verify**

```bash
npm run typecheck       # docs-only changes, but confirm nothing else is broken
npm run test:architecture
```

Both must pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md LESSONS.md
git commit -m "$(cat <<'EOF'
docs(node26): add prefer-this-over-that table + sandboxing recipe

Documents the Node 26 modernization baseline in CLAUDE.md (Promise.withResolvers,
AbortSignal.timeout, styleText, node:sqlite, etc.) so future contributions
adopt the right primitives. Permission-model recipe included as an opt-in
sandboxing reference for deployments where threat model warrants it.
LESSONS.md captures the migration anchor date for institutional memory.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (orchestrator-side after all tasks land)

After Task 7 commits, run this final check before declaring the plan done:

```bash
# Confirm the deps are gone.
grep -E '"(better-sqlite3|@types/better-sqlite3|picocolors)"' package.json && echo "FAIL: dep still present" || echo "OK: deps removed"

# Confirm no lingering imports.
grep -rln "better-sqlite3\|picocolors" src/ tests/ && echo "FAIL: lingering import" || echo "OK: no lingering imports"

# Confirm Node 26 surface is recognized.
grep -E '"node":\s*">=26' package.json && echo "OK: engines pinned" || echo "FAIL: engines missing"

# Confirm shim exists.
test -f src/infra/sqlite/index.ts && test -f src/infra/sqlite/CLAUDE.md && echo "OK: shim present" || echo "FAIL: shim missing"

# Final test loop.
npm run typecheck
npm run typecheck:all
npm run test
npm run test:architecture
```

All `OK` lines printed and all four `npm run` calls passing == plan complete. Anything else == surface to the user before declaring done.

---

## Codex final review (per global CLAUDE.md superpowers workflow)

After all tasks merged and self-review passes, run:

```
codex:rescue
```

over the combined diff (master since the plan started). Codex reports findings only — DOES NOT fix. The orchestrator implements any fixes, using subagents for mechanical work and surfacing to the user for anything requiring redesign.
