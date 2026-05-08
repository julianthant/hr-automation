# Performance Review — Tier 3: Medium-Impact Bundle

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land ten medium-impact performance improvements across tracker, queue, and dashboard backend/frontend. Tier 3 mops up the long tail of issues a perf review surfaced — none individually as load-bearing as Tier 2 items, but cumulatively meaningful.

**Tech Stack:** Node 26, `node:sqlite`, Hono, React 19.

**Verification (every task):**
- `npm run typecheck` — must pass
- `npm run test:architecture` — must pass
- Per-task unit tests where listed

**Out of scope:**
- HeroUI calendar swap to `react-day-picker`. Surface listed in Tier 3 review but skipped here — it's a substantive refactor that needs its own brainstorm/visual review pass. Track separately.
- Anything in Tiers 1 or 2.

**Assumed merged on master:**
- Tier 1: daemon fetch timeouts.
- Tier 2: nine high-impact surgical fixes (countJsonlLines drop, emitStepChange SQLite seek, queryEntriesPayload N+1, session-state TTL cache, preflight throttle, EntryItem memo, useEntries hash, PdfPagePreview polling, findAliveDaemons parallel).

Verify with `git log --oneline -25` before starting.

---

## Dispatch waves

Tier 3 has **two waves** — Wave A is sequential (tracker storage layer; T1–T4 share `state/` files and migration version numbers), Wave B is parallel (file-disjoint).

### Wave A — sequential on master

T1 → T2 → T3 → T4. One subagent per task, each commits to master, next subagent picks up the post-commit state.

### Wave B — parallel in worktrees

T5, T6, T7, T8, T9, T10 dispatch in one batch. Each subagent gets its own worktree (`.claude/worktrees/perf-tier-3-task-N/`) and `feature/perf-tier-3-task-N` branch. Per `~/.claude/CLAUDE.md` parallel discipline: subagents commit only to their branch; orchestrator verifies and merges sequentially after all return; worktrees + branches deleted post-merge.

---

# Wave A — Tracker storage layer (sequential, master)

## Task 1: Add SQLite indexes for run_id-only screenshot lookups

**Why:** `applyScreenshotFiles` runs `SELECT ... FROM runs WHERE run_id = ?` and `SELECT COUNT(*) FROM files WHERE kind = 'screenshot' AND run_id = ?`. The PK index on `runs(workflow, tracker_date, item_id, run_id)` is leftmost-prefix only — a `run_id`-only filter does a full scan. Same for `files`'s `idx_files_owner(workflow, item_id, run_id)`. Add a `run_id` index on `runs` and a partial index on `files` filtered to `kind = 'screenshot'`.

**Files:**
- Modify: `src/tracker/state/schema.ts` — add a new migration that creates two indexes.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Identify current migration version**

```bash
rg -n "PRAGMA user_version|migrations|migration_version|migrate(_)?to" src/tracker/state/schema.ts src/infra/sqlite/index.ts
```

The schema has versioned migrations. Note the highest existing version (call it N). The new migration is N+1.

- [ ] **Step 3: Add migration N+1**

In `src/tracker/state/schema.ts`, find the migration registration array/list. Add a new migration entry:

```ts
// Migration N+1: indexes for run_id-only lookups (used by applyScreenshotFiles).
// runs.run_id and files(kind='screenshot', run_id) were unindexed; the existing
// PK on runs and idx_files_owner on files are leftmost-prefix-only and don't
// help a run_id-only filter.
{
  version: <N+1>,
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_run_id ON runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_files_run_id_screenshot
        ON files(run_id) WHERE kind = 'screenshot';
    `);
  },
},
```

(Replace `<N+1>` with the actual integer. The migration system should run it on next `openStateDb` automatically.)

- [ ] **Step 4: Tests**

```bash
npm run test -- --grep "schema|migration|state-db"
```

If a migration test asserts the version count, update it.

- [ ] **Step 5: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/state/schema.ts
git commit -m "$(cat <<'EOF'
perf(tracker): index runs.run_id and files(run_id) for screenshot apply

applyScreenshotFiles ran two queries with WHERE run_id = ? — a full
table scan on both `runs` (PK is composite leftmost-prefix) and
`files` (idx_files_owner is composite leftmost-prefix). On a busy
day with 10k+ runs and per-run failure screenshots, this dominated
the screenshot emit path.

Add a non-unique index on runs.run_id and a partial index on files
keyed on run_id where kind='screenshot' (keeps it small — only
screenshot rows are indexed).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Cache prepared statements per-DB via WeakMap

**Why:** `applyTrackerEntry`, `applyLogEntry`, `applySessionEvent`, `applyScreenshotFiles` each call `db.prepare(...)` on every emit — `node:sqlite` re-parses + re-plans the SQL each call. With multi-step workflows emitting dozens of events per item, this is steady CPU on the hot path.

**Files:**
- Modify: `src/tracker/state/apply.ts` — hoist `db.prepare(...)` calls into a per-DB statement cache via `WeakMap<Database, Statements>`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Map every `db.prepare(` site in apply.ts**

```bash
rg -n "db\.prepare" src/tracker/state/apply.ts
```

Note each call. Group by SQL body (some may be identical between functions). Each unique SQL string becomes one cached `Statement`.

- [ ] **Step 3: Add cache scaffolding at the top of `apply.ts`**

After the imports, add:

```ts
type Database = ReturnType<typeof getStateDb>; // or import the actual type from the shim
type Statement = ReturnType<Database["prepare"]>;

interface CachedStatements {
  insertRunEvent: Statement;
  upsertRun: Statement;
  upsertItem: Statement;
  insertLog: Statement;
  upsertItemLogTs: Statement;
  insertSessionEvent: Statement;
  insertFile: Statement;
  selectRunForScreenshot: Statement;
  countScreenshotsForRun: Statement;
  // (Add any others surfaced by Step 2.)
}

const stmtCache = new WeakMap<Database, CachedStatements>();

function stmts(db: Database): CachedStatements {
  let cached = stmtCache.get(db);
  if (cached) return cached;
  cached = {
    insertRunEvent: db.prepare(`INSERT OR IGNORE INTO run_events (...) VALUES (...)`),
    upsertRun:      db.prepare(`INSERT INTO runs (...) ON CONFLICT (...) DO UPDATE SET ...`),
    upsertItem:     db.prepare(`INSERT INTO items (...) ON CONFLICT (...) DO UPDATE SET ...`),
    insertLog:      db.prepare(`INSERT OR IGNORE INTO logs (...) VALUES (...)`),
    upsertItemLogTs: db.prepare(`UPDATE items SET ... WHERE workflow = ? AND tracker_date = ? AND item_id = ? AND latest_run_id = ?`),
    insertSessionEvent: db.prepare(`INSERT OR IGNORE INTO session_events (...) VALUES (...)`),
    insertFile:     db.prepare(`INSERT OR IGNORE INTO files (...) VALUES (...)`),
    selectRunForScreenshot: db.prepare(`SELECT workflow, item_id FROM runs WHERE run_id = ?`),
    countScreenshotsForRun: db.prepare(`SELECT COUNT(*) AS n FROM files WHERE kind = 'screenshot' AND run_id = ?`),
  };
  stmtCache.set(db, cached);
  return cached;
}
```

(The exact SQL strings come from the current `db.prepare(...)` calls. Read them out of the file and copy verbatim. The keys above are illustrative — match the SQL groups you actually find.)

- [ ] **Step 4: Replace each in-function `db.prepare(...).run/.get/.all(...)` with `stmts(db).<name>.run/.get/.all(...)`**

For each callsite found in Step 2:
- `db.prepare(`INSERT INTO run_events ...`).run({...})` → `stmts(db).insertRunEvent.run({...})`
- ...and so on.

After all replacements, run:

```bash
rg -n "db\.prepare" src/tracker/state/apply.ts
```

Expected: zero hits (or only the ones inside the `stmts()` factory itself).

- [ ] **Step 5: Tests**

```bash
npm run test -- --grep "state-jsonl-live-apply|applyTrackerEntry|applyLogEntry|applyScreenshotFiles"
```

Expected: pass. The behavior is byte-identical; only the prepare-time cost moved.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 7: Commit**

```bash
git add src/tracker/state/apply.ts
git commit -m "$(cat <<'EOF'
perf(tracker): cache prepared statements per-DB via WeakMap

apply.ts called db.prepare(...) on every emit — node:sqlite re-parses
and re-plans the SQL on each call. Multi-step workflows emit dozens
of tracker / log / session events per item; the prepare overhead was
steady CPU on the kernel hot path.

Hoist into a WeakMap<Database, CachedStatements>: first call lazily
prepares all statements for that DB, subsequent calls reuse. WeakMap
lets the cache GC if the DB is closed (test isolation cleanup).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Incremental projection rebuild + `recomputeRunOrdinals` CTE

**Why:** `rebuildProjectionForDate` does a full DELETE + replay of every JSONL row even though `projection_sources.byte_offset` is already tracked. On dashboard restart (and every `dashboard:watch` file save) it re-applies thousands of rows. `recomputeRunOrdinals` does N row-by-row UPDATEs where one CTE-driven UPDATE would do.

**Files:**
- Modify: `src/tracker/state/rebuild.ts` — change DELETE+replay to skip rows ≤ existing `byte_offset`; replace per-row update loop in `recomputeRunOrdinals` with a single `UPDATE ... FROM` CTE.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read current `rebuildProjectionForDate` (line ~103-177)**

```bash
sed -n '90,210p' src/tracker/state/rebuild.ts
```

Note: (a) where it DELETEs from `run_events` / `runs` / `items` / `logs` for the date, (b) where it reads `projection_sources` byte_offsets, (c) where it walks each JSONL file, (d) where it calls `applyTrackerEntry` per line.

- [ ] **Step 3: Edit `rebuildProjectionForDate`** — make rebuild incremental.

Replace the DELETE block with a query that pulls existing per-path byte_offset:

```ts
// Instead of DELETE + replay, skip lines already projected. UNIQUE
// (source_path, source_offset) on run_events / logs / session_events
// makes the live-apply paths idempotent (INSERT OR IGNORE), so re-running
// stale lines is safe but wasteful. Tracking byte_offset per source lets
// us skip them.
const existingOffsets = new Map<string, number>();
const offsetRows = db.prepare(`
  SELECT path, byte_offset
  FROM projection_sources
  WHERE source_kind IN ('tracker', 'log', 'session')
    AND tracker_date = ?
`).all(date) as Array<{ path: string; byte_offset: number }>;
for (const row of offsetRows) existingOffsets.set(row.path, row.byte_offset);
```

Then in the per-file loop, for each line, compute the line's offset before parsing. Skip lines whose end-offset is ≤ `existingOffsets.get(filePath) ?? 0`. After the file is fully consumed, update `projection_sources.byte_offset = stat.size` for that path. Pseudocode:

```ts
for (const file of jsonlFiles) {
  const stat = statSync(file.path);
  const startAt = existingOffsets.get(file.path) ?? 0;
  if (stat.size <= startAt) continue; // nothing new
  const fd = openSync(file.path, "r");
  try {
    const remaining = stat.size - startAt;
    const buf = Buffer.alloc(remaining);
    readSync(fd, buf, 0, remaining, startAt);
    const text = buf.toString("utf-8");
    let offset = startAt;
    for (const line of text.split("\n")) {
      if (!line) { offset += 1; continue; }
      const lineEnd = offset + Buffer.byteLength(line, "utf-8") + 1; // +1 for \n
      try {
        const payload = JSON.parse(line);
        applyTrackerEntry(payload, db, { path: file.path, offset, kind: file.kind });
      } catch { /* skip malformed line */ }
      offset = lineEnd;
    }
  } finally {
    closeSync(fd);
  }
  db.prepare(`
    INSERT INTO projection_sources (path, source_kind, tracker_date, byte_offset)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (path, source_kind, tracker_date) DO UPDATE SET byte_offset = excluded.byte_offset
  `).run(file.path, file.kind, date, stat.size);
}
```

(Adjust to match the actual `applyXxx` per-source shape used in the file. The key invariants: (a) read only [byte_offset, EOF], (b) save the post-read size to `projection_sources`.)

The DELETE block at the top of the function should be removed. The per-row `applyXxxLive` functions already use `INSERT OR IGNORE` keyed on `UNIQUE(source_path, source_offset)` — duplicates from a stale projection are silently de-duped, so no DELETE is needed.

- [ ] **Step 4: Replace `recomputeRunOrdinals` (line ~179-201) with one CTE**

Find the function. Replace the per-row `for (const row of rows) update.run({...})` body with a single statement:

```ts
export function recomputeRunOrdinals(db: Database, date: string): void {
  db.exec(`
    WITH ordered AS (
      SELECT
        workflow, item_id, run_id,
        ROW_NUMBER() OVER (
          PARTITION BY workflow, item_id
          ORDER BY COALESCE(first_work_ts, first_any_ts), run_id
        ) AS ordinal
      FROM runs
      WHERE tracker_date = '${date.replace(/'/g, "''")}'
    )
    UPDATE runs
    SET run_ordinal = (
      SELECT ordinal FROM ordered
      WHERE ordered.workflow = runs.workflow
        AND ordered.item_id = runs.item_id
        AND ordered.run_id = runs.run_id
    )
    WHERE tracker_date = '${date.replace(/'/g, "''")}'
      AND EXISTS (
        SELECT 1 FROM ordered
        WHERE ordered.workflow = runs.workflow
          AND ordered.item_id = runs.item_id
          AND ordered.run_id = runs.run_id
      );
  `);
}
```

Note: `db.exec` doesn't support parameter binding for top-level statements, hence the inline-with-quote-escape `${date.replace(...)}`. Date is a controlled YYYY-MM-DD string from `dateLocal()` — not user input. If the project prefers parameterized statements via `db.prepare(...).run()`, refactor to two prepared statements. The CTE form here is the cleanest expression.

- [ ] **Step 5: Tests**

```bash
npm run test -- --grep "rebuild|recomputeRunOrdinals|projection_sources"
```

Critical tests: rebuild idempotency (calling twice produces same result), incremental rebuild (adding lines to an already-rebuilt source applies only the new lines). If those tests don't exist, add them — the change is non-trivial and a regression here corrupts the projection.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 7: Commit**

```bash
git add src/tracker/state/rebuild.ts
git commit -m "$(cat <<'EOF'
perf(tracker): incremental rebuild + recomputeRunOrdinals CTE

rebuildProjectionForDate did a full DELETE + replay every dashboard
restart (and every dashboard:watch file save). With 10k+ tracker rows
on a busy day that's 30k+ inserts of work that's already in the DB.
projection_sources.byte_offset was tracked but not consulted.

Make rebuild incremental: per-file byte_offset gates which bytes are
parsed; INSERT OR IGNORE on UNIQUE(source_path, source_offset)
absorbs any over-read. After consuming a file, persist the new offset.

recomputeRunOrdinals went from N row-by-row UPDATEs to one CTE-driven
UPDATE FROM with ROW_NUMBER() — same semantics, one statement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Drop `raw_json` column from `run_events`

**Why:** `run_events.raw_json` stores the entire entry serialized as JSON, *in addition to* the typed columns (`data_json`, `typed_data_json`, `input_json`, etc.). Every emit pays for the duplicate `JSON.stringify`; every read parses both. Readers in `queries.ts` reconstruct from typed columns anyway — `raw_json` is dead weight.

**Files:**
- Modify: `src/tracker/state/schema.ts` — migration to drop the column.
- Modify: `src/tracker/state/apply.ts` — stop writing `raw_json`.
- Modify: `src/tracker/state/queries.ts` — confirm no caller reads `raw_json`. (Likely already true.)

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Confirm no read-side consumer**

```bash
rg -n "raw_json|rawJson" src/
```

Note every site. Expected: schema (column def), apply.ts (INSERT writing `raw_json`), possibly tests. If any read-site exists in `queries.ts`, dashboard, or kernel — STOP. Do not drop the column until those readers are migrated to typed columns.

- [ ] **Step 3: Add migration N+2 in `src/tracker/state/schema.ts`**

(N is from Task 1; this is N+2 since Task 1 used N+1.)

```ts
{
  version: <N+2>,
  up: (db) => {
    // SQLite 3.35+ supports DROP COLUMN. node:sqlite ships modern SQLite
    // so this is fine. If it ever fails on an older runtime, fall back
    // to "ALTER TABLE rename, CREATE new without col, INSERT SELECT, DROP rename".
    db.exec(`ALTER TABLE run_events DROP COLUMN raw_json;`);
  },
},
```

- [ ] **Step 4: Update `apply.ts` to stop writing `raw_json`**

In Task 2's cached `insertRunEvent` statement, remove the `raw_json` column from the column list and `@raw_json` from the values list. Remove the `JSON.stringify(entry)` that builds the raw_json parameter.

If Task 2 hasn't shipped yet (sequential ordering means it has — but in case of merge order issues), the same edit applies to the inline `db.prepare(...)` callsites.

- [ ] **Step 5: Tests**

```bash
npm run test -- --grep "raw_json|run_events|state-jsonl"
```

Update any test that asserts the existence or value of `raw_json`.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 7: Commit**

```bash
git add src/tracker/state/schema.ts src/tracker/state/apply.ts
git commit -m "$(cat <<'EOF'
perf(tracker): drop run_events.raw_json column (dead duplicate)

run_events.raw_json stored the entire entry serialized as JSON in
addition to the typed columns it duplicated (data_json, typed_data_json,
input_json, etc.). Every emit paid for the duplicate JSON.stringify;
queries.ts reconstructs from typed columns and never reads raw_json.

DROP COLUMN migration; remove the field from apply.ts inserts. ~10-50%
of the per-emit JSON serialization cost goes away on entries with
substantial data fields.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Wave B — Parallel batch (six worktrees)

Wave B kicks off after Wave A is fully merged on master. Six independent tasks; dispatch in one parallel message with six Agent calls, each in its own worktree + branch (`feature/perf-tier-3-task-N` for N=5..10).

## Task 5: `readQueueState` N+1 + `registerBrowserProcesses` skip-after-init

**Why:** `readQueueState` (`src/core/daemon/queue.ts:40-58`) does a `SELECT id` then per-id `store.getTask(row.id)` — N+1 prepared-statement executions per call. `registerBrowserProcesses` (`src/core/daemon/daemon.ts:256-271`) is called 3× per claim (onReady, post-Session.launch, every claim) when the chromePids don't change between claims.

**Files:**
- Modify: `src/core/daemon/queue.ts:40-58` — replace the per-id loop with a single SQL that returns full task rows.
- Modify: `src/core/daemon/daemon.ts:256-271` (and callsites at 420/427/529) — track `browsersRegistered` boolean; skip after the first registration succeeds.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `queue.ts:40-58`**

Replace:

```ts
export async function readQueueState(workflow: string, trackerDir?: string): Promise<QueueState> {
  const store = openQueueTaskStore(trackerDir)
  const state: QueueState = { queued: [], claimed: [], done: [], failed: [] }
  const rows = store.db.prepare(`
    SELECT id
    FROM tasks
    WHERE workflow = ?
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as Array<{ id: string }>
  for (const row of rows) {
    const task = store.getTask(row.id)
    if (!task) continue
    const item = taskToQueueItem(task)
    state[item.state].push(item)
  }
  return state
}
```

With a single SQL that returns the full row (whatever `store.getTask` selects):

```ts
export async function readQueueState(workflow: string, trackerDir?: string): Promise<QueueState> {
  const store = openQueueTaskStore(trackerDir)
  const state: QueueState = { queued: [], claimed: [], done: [], failed: [] }
  // One query for full task rows. The previous shape (SELECT id then
  // per-id store.getTask(...)) was an N+1.
  const rows = store.db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = ?
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as Array<TaskRow>
  for (const row of rows) {
    const task = rowToTask(row); // — see below
    if (!task) continue
    const item = taskToQueueItem(task)
    state[item.state].push(item)
  }
  return state
}
```

Adapter: look at `store.getTask` (in `src/core/task-store/` or wherever it lives) and extract its row→Task transformer into a local exported helper `rowToTask(row)` that takes the same row shape. If `store.getTask` is just a `prepare + .get(id)` then a `WHERE id = ?` returning `*`, the row shape is the same as what `SELECT *` returns and the transformer is whatever `getTask` does after `.get`.

(Read `store.getTask`'s implementation before writing the adapter. If it does additional DB calls per task — e.g., fetches related task_attempts — those need to either be bulked alongside this query or reconsidered; if N+1 inside `getTask` is the real cost, fixing here just shifts it.)

- [ ] **Step 3: Edit `daemon.ts:256-271`** — track init status

Find `registerBrowserProcesses`. Wrap it:

```ts
let browsersRegistered = false;

function registerBrowserProcessesOnce(): void {
  if (browsersRegistered) return;
  if (!activeSession || !workerStore) return;
  // ... existing body of registerBrowserProcesses ...
  browsersRegistered = true;
}
```

(Or keep the original `registerBrowserProcesses` function but add the `browsersRegistered` guard at the top + flip on success.)

Update the three callsites at lines ~420, ~427, ~529 (and the `onBrowserDisconnect` reset path) to call `registerBrowserProcessesOnce` instead. The disconnect path should reset the flag so the next session can re-register:

```ts
// onBrowserDisconnect handler:
browsersRegistered = false;
```

- [ ] **Step 4: Tests**

```bash
npm run test -- --grep "readQueueState|registerBrowserProcesses|daemon"
```

- [ ] **Step 5: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 6: Commit**

```bash
git add src/core/daemon/queue.ts src/core/daemon/daemon.ts
git commit -m "$(cat <<'EOF'
perf(daemon): readQueueState SELECT * + registerBrowserProcesses once

readQueueState ran SELECT id then per-id store.getTask() — N+1
prepared-statement executions per call. With 100+ historical task
rows on a busy day, every wake (and every /status) paid for hundreds
of round-trips. Replace with one SELECT * + local row→Task transformer.

registerBrowserProcesses ran 3× per claim (onReady, post-launch,
per-claim) when chromePids don't change between claims. Track an
init flag; skip after the first success. Reset on browser disconnect
so the next Session re-registers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Parallelize `runKeepaliveTick` healthCheck loop

**Why:** With 4 systems (separations) and 4 daemons, every 15 min there are 16 health-checks. Each `session.healthCheck(sys.id)` is a Playwright RPC (page evaluate or navigation probe) — order of seconds. Sequential 4 × ~3s = ~12s. Parallel = ~3s. The daemon's idle and there's no claim contention; reduces the "phase=keepalive" stuck window.

**Files:**
- Modify: `src/core/daemon/keepalive.ts` — replace the `for (const sys of systems)` loop with `Promise.allSettled`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `src/core/daemon/keepalive.ts`** — replace the body of `runKeepaliveTick`

Replace:

```ts
export async function runKeepaliveTick(opts: KeepaliveOpts): Promise<void> {
  const { instanceId, session, systems, recoverOrphanedClaims } = opts

  await recoverOrphanedClaims()

  for (const sys of systems) {
    try {
      const ok = await session.healthCheck(sys.id)
      if (!ok) {
        log.warn(
          `[Daemon ${instanceId}] healthCheck(${sys.id}) failed — next claim may re-auth`,
        )
      }
    } catch (e) {
      log.warn(
        `[Daemon ${instanceId}] healthCheck(${sys.id}) error: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }
}
```

With:

```ts
export async function runKeepaliveTick(opts: KeepaliveOpts): Promise<void> {
  const { instanceId, session, systems, recoverOrphanedClaims } = opts

  await recoverOrphanedClaims()

  // Per-system healthChecks are independent — parallelize. Sequential
  // (the previous shape) made the daemon's "phase=keepalive" window
  // ~N×3s; parallel makes it ~max(3s).
  await Promise.allSettled(
    systems.map(async (sys) => {
      try {
        const ok = await session.healthCheck(sys.id)
        if (!ok) {
          log.warn(
            `[Daemon ${instanceId}] healthCheck(${sys.id}) failed — next claim may re-auth`,
          )
        }
      } catch (e) {
        log.warn(
          `[Daemon ${instanceId}] healthCheck(${sys.id}) error: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }),
  )
}
```

- [ ] **Step 3: Tests**

```bash
npm run test -- --grep "keepalive|runKeepaliveTick"
```

If a test asserts sequential probe ordering (unlikely — the contract is "all systems probed"), update.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon/keepalive.ts
git commit -m "$(cat <<'EOF'
perf(daemon): parallelize keepalive healthCheck across systems

runKeepaliveTick ran healthCheck per system sequentially. With 4
systems × ~3s/probe = ~12s "phase=keepalive" window per daemon per
15min. Each probe is independent — switch to Promise.allSettled so
wall time becomes max(per-probe).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `/api/find-prior-by-key` SQLite path

**Why:** `findPriorEntriesByKey` walks up to 365 days of tracker JSONL per request via `for (date of recentDates) readEntriesForDate(...)`. Default 90 days × ~8 workflow files = 90 sync reads per call (cold cache). Operator clicks "Copy from prior" → 100ms+ blocking the event loop. SQLite-able.

**Files:**
- Add: `src/tracker/state/queries.ts` — new function `queryPriorEntriesByKey({ workflow, key, value, lookbackDays }) => entries[]`.
- Modify: `src/tracker/dashboard/ops/queue.ts:300-327` — route through SQLite when projection ready; fall back to JSONL otherwise.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read current `findPriorEntriesByKey`**

```bash
sed -n '290,335p' src/tracker/dashboard/ops/queue.ts
```

Note the input shape (`workflow`, `key`, `value`, `lookbackDays`?) and the return shape (entries array).

- [ ] **Step 3: Add `queryPriorEntriesByKey` to `src/tracker/state/queries.ts`**

```ts
export interface PriorEntriesByKeyOpts {
  workflow: string;
  key: string;
  value: string;
  lookbackDays: number;
  cutoffDate: string; // YYYY-MM-DD — inclusive lower bound
}

export function queryPriorEntriesByKey(
  db: Database,
  opts: PriorEntriesByKeyOpts,
): Array<{
  workflow: string;
  timestamp: string;
  id: string;
  runId: string;
  status: string;
  data: Record<string, unknown>;
}> {
  // SQLite JSON1: data_json ->> '$."<key>"' returns the field value as TEXT.
  // We want every entry where data->>key === value, on tracker_date >= cutoff.
  // Indexed via idx_run_events_workflow_date — SQLite's planner will use
  // the leftmost (workflow, tracker_date) prefix, then filter rows by JSON.
  const rows = db.prepare(`
    SELECT workflow, timestamp, item_id AS id, run_id AS runId, status, data_json
    FROM run_events
    WHERE workflow = @workflow
      AND tracker_date >= @cutoff
      AND data_json IS NOT NULL
      AND json_extract(data_json, '$.' || @key) = @value
    ORDER BY tracker_date DESC, timestamp DESC
  `).all({
    workflow: opts.workflow,
    cutoff: opts.cutoffDate,
    key: opts.key,
    value: opts.value,
  }) as Array<{ workflow: string; timestamp: string; id: string; runId: string; status: string; data_json: string }>;

  return rows.map((row) => ({
    workflow: row.workflow,
    timestamp: row.timestamp,
    id: row.id,
    runId: row.runId,
    status: row.status,
    data: parseJsonObject(row.data_json, {}),
  }));
}
```

- [ ] **Step 4: Wire `findPriorEntriesByKey` to use SQLite when ready**

In `ops/queue.ts`, find `findPriorEntriesByKey`. Add at the top:

```ts
import { isStateDbReady, getStateDb } from "../../state/runtime.js";
import { queryPriorEntriesByKey } from "../../state/queries.js";
```

Replace the function body:

```ts
export function findPriorEntriesByKey(
  workflow: string,
  key: string,
  value: string,
  dir: string,
  lookbackDays = 90,
): PriorEntry[] {
  const today = dateLocal();
  const cutoff = isoOffsetDate(today, -lookbackDays);

  if (isStateDbReady(dir)) {
    try {
      const db = getStateDb(dir);
      const rows = queryPriorEntriesByKey(db, {
        workflow, key, value, lookbackDays, cutoffDate: cutoff,
      });
      return rows.map(/* map to PriorEntry shape */);
    } catch (err) {
      // Fall through to JSONL on any SQLite hiccup.
    }
  }

  // JSONL fallback (original implementation).
  const recentDates = enumerateDates(today, lookbackDays);
  const out: PriorEntry[] = [];
  for (const date of recentDates) {
    const entries = readEntriesForDate(workflow, date, dir);
    for (const entry of entries) {
      if (entry.data?.[key] === value) {
        out.push(/* original mapping */);
      }
    }
  }
  return out;
}
```

(Read the original to copy the mapping shape exactly. The `isoOffsetDate`/`enumerateDates` helpers may already exist; check imports.)

- [ ] **Step 5: Tests**

```bash
npm run test -- --grep "find-prior-by-key|findPriorEntriesByKey|queryPriorEntriesByKey"
```

Add a test for `queryPriorEntriesByKey` if none exists — basic SQL-injection-safe + lookback boundary checks.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 7: Commit**

```bash
git add src/tracker/state/queries.ts src/tracker/dashboard/ops/queue.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): SQLite path for /api/find-prior-by-key

findPriorEntriesByKey walked 90 days × ~8 workflow files synchronously
per "Copy from prior" click. Cold cache = 90 readFileSync calls = ~100ms
blocking the event loop.

Add queryPriorEntriesByKey using JSON1 (data_json ->> '$.key' = value),
indexed via existing idx_run_events_workflow_date. Wire findPrior...
to prefer SQLite when projection is ready; JSONL fallback unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `/api/daemons` parallelize + `countItemsProcessed` hoist

**Why:** GET `/api/daemons` (`src/tracker/dashboard/ops/worker-control.ts`) serializes `findAliveDaemons` per workflow (line ~257-259) AND `probeDaemonStatus` per daemon (line ~287-309). With 4 daemons × ~50ms each = 200ms baseline; one slow probe makes it 1000ms+. `countItemsProcessed` reads queue JSONL once per daemon — 4 reads when one would do.

**Files:**
- Modify: `src/tracker/dashboard/ops/worker-control.ts:257-309`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read current shape**

```bash
sed -n '230,320p' src/tracker/dashboard/ops/worker-control.ts
```

Find the per-workflow `findAliveDaemons` loop, the per-daemon `probeDaemonStatus` loop, and the per-daemon `countItemsProcessed` (which reads queue JSONL).

- [ ] **Step 3: Parallelize `findAliveDaemons`**

```ts
// Before:
for (const wf of workflows) {
  aliveByWorkflow.set(wf, await findAliveDaemons(wf, dir));
}

// After:
const aliveResults = await Promise.all(
  workflows.map(async (wf) => [wf, await findAliveDaemons(wf, dir)] as const),
);
for (const [wf, alive] of aliveResults) aliveByWorkflow.set(wf, alive);
```

- [ ] **Step 4: Parallelize `probeDaemonStatus`**

```ts
// Before:
for (const d of daemons) {
  results.push(await probeDaemonStatus(d));
}

// After:
const results = await Promise.all(daemons.map(probeDaemonStatus));
```

(Probe already has its own 1s timeout; one slow daemon doesn't drag siblings.)

- [ ] **Step 5: Hoist `countItemsProcessed` queue reads**

Find `countItemsProcessed`. It currently does `readFileSync(queueFilePath(wf, dir))` per call. Hoist to handler scope:

```ts
// At handler top, before the per-daemon loop:
const queueLinesByWorkflow = new Map<string, string[]>();
for (const wf of workflows) {
  try {
    const text = readFileSync(queueFilePath(wf, dir), "utf-8");
    queueLinesByWorkflow.set(wf, text.split("\n").filter(Boolean));
  } catch {
    queueLinesByWorkflow.set(wf, []);
  }
}

// Then change countItemsProcessed signature:
function countItemsProcessed(workflow: string, workerId: string, queueLines: string[]): number {
  let count = 0;
  for (const line of queueLines) {
    try {
      const evt = JSON.parse(line);
      if (evt.workerId === workerId && evt.type === 'done') count++;
    } catch { /* skip */ }
  }
  return count;
}

// Callsites:
const processed = countItemsProcessed(wf, daemon.workerId, queueLinesByWorkflow.get(wf) ?? []);
```

(The exact shape of `countItemsProcessed`'s logic depends on what the function currently does — preserve its semantics, just take the parsed lines as input.)

- [ ] **Step 6: Tests**

```bash
npm run test -- --grep "/api/daemons|worker-control|countItemsProcessed"
```

- [ ] **Step 7: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 8: Commit**

```bash
git add src/tracker/dashboard/ops/worker-control.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): parallelize /api/daemons + hoist queue reads

The handler serialized findAliveDaemons across workflows AND
probeDaemonStatus across daemons. Both are independent — Promise.all
both. Worst-case latency on one slow daemon was 1000ms+ before
returning the daemons list; now bounded by max(probe latency).

countItemsProcessed read the queue JSONL once per daemon. Hoist to
one read per workflow into a Map; pass parsed lines into each call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `/api/ocr/reocr-whole-pdf` fire-and-forget

**Why:** The handler awaits `watchChildRuns(...)` with `timeoutMs: 60 * 60_000` (one hour). The HTTP request is held open up to an hour; operator's HTTP client will time out at 60–120s leaving them with no completion signal. Should be fire-and-forget like `/api/ocr/approve-batch`.

**Files:**
- Modify: `src/tracker/dashboard/ocr/reocr-whole-pdf.ts:134-140`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read the current handler shape**

```bash
sed -n '110,160p' src/tracker/dashboard/ocr/reocr-whole-pdf.ts
```

Note where the `await watchChildRuns(...)` happens and what wraps it.

- [ ] **Step 3: Wrap the watch in `void (async () => {...})()`** — return 202 immediately.

```ts
// Before:
const result = await watchChildRuns({
  parentRunId,
  expected: ...,
  timeoutMs: 60 * 60_000,
  // ...
});
return jsonResponse({ ok: true, result });

// After:
void (async () => {
  try {
    await watchChildRuns({
      parentRunId,
      expected: ...,
      timeoutMs: 60 * 60_000,
      // ...
    });
  } catch (err) {
    log.warn(`[reocr-whole-pdf] watch failed for parent=${parentRunId}: ${err instanceof Error ? err.message : String(err)}`);
  }
})();
return jsonResponse({ ok: true, accepted: true, parentRunId }, 202);
```

The frontend already polls SSE for OCR row state — it doesn't need this handler to block.

- [ ] **Step 4: Tests**

```bash
npm run test -- --grep "reocr-whole-pdf|reocrWholePdf"
```

If a test awaited the watch result via the handler return, update it to poll SSE / tracker state instead (or remove if redundant with `approve-batch`'s test pattern).

- [ ] **Step 5: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/dashboard/ocr/reocr-whole-pdf.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): fire-and-forget /api/ocr/reocr-whole-pdf

The handler awaited watchChildRuns with timeoutMs=1h, holding the
HTTP request open. Operator's client times out at 60-120s leaving
them with no completion signal — but the server-side work continues.

Mirror /api/ocr/approve-batch's pattern: void(async()=>{...})() the
watch, return 202 + parentRunId immediately. The frontend polls SSE
for OCR row state regardless.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Frontend bundle — log streams + JSON-stringify hashes + central useNow

**Why:** Six small wins across the dashboard frontend that all touch components/hooks; bundling them into one commit per concern keeps the diff coherent. They are:
- `useLogs` log collapsing not memoized (re-runs O(N) per render).
- `LogStream` "all" tab uses `localeCompare` per element (slow vs. ASCII compare).
- `LogLine` not wrapped in `React.memo`; `handleCopy` not stable.
- `LogPanel` and `useSessions` use `JSON.stringify` deep-equality short-circuits — replace with structural fingerprints.
- 11+ uncoordinated `setInterval` 1Hz timers (`useElapsed` per-running-row) → centralized `useNow()` singleton.
- OCR `localStorage.setItem` on every keystroke → debounce 300ms.

**Files:**
- Modify: `src/dashboard/components/hooks/useLogs.ts`
- Modify: `src/dashboard/components/log-panel/LogStream.tsx`
- Modify: `src/dashboard/components/log-panel/LogLine.tsx`
- Modify: `src/dashboard/components/log-panel/LogPanel.tsx`
- Modify: `src/dashboard/components/hooks/useSessions.ts`
- Modify: `src/dashboard/components/hooks/useElapsed.ts` — convert to consume central clock.
- Add: `src/dashboard/components/hooks/useNow.ts` — module singleton.
- Modify: `src/dashboard/components/ocr/OcrReviewPane.tsx`

This task has more files than the others — split into four commits within the same task to keep each diff reviewable. The subagent dispatching this task should make four commits, not one.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2 (Commit A): `useLogs` collapse memo + `LogStream` tab sort + `LogLine` memo + `handleCopy` useCallback**

In `src/dashboard/components/hooks/useLogs.ts`, find the for-loop that builds `collapsed` (around line 81-91). Wrap in `useMemo`:

```ts
import { useMemo, useState, useEffect } from "react";

// ...

const collapsed = useMemo(() => {
  const out: CollapsedLogEntry[] = [];
  for (const log of rawLogs) {
    const prev = out[out.length - 1];
    if (prev && prev.message === log.message) prev.count++;
    else out.push({ ...log, count: 1 });
  }
  return out;
}, [rawLogs]);
return { logs: collapsed, loading };
```

In `src/dashboard/components/log-panel/LogStream.tsx`, find the "all" tab `displayed` computation (lines ~106-127). Wrap in `useMemo` and replace `localeCompare` with `<` / `>`:

```ts
const displayed = useMemo<DisplayItem[]>(() => {
  if (tab?.source === "events") return events.map((e) => ({ kind: "event" as const, entry: e }));
  if (filter === "all") {
    const merged: DisplayItem[] = [
      ...visibleLogs.map((l) => ({ kind: "log" as const, entry: l })),
      ...events.map((e) => ({ kind: "event" as const, entry: e })),
    ];
    merged.sort((a, b) => {
      const ta = a.kind === "log" ? a.entry.ts : (a.entry.timestamp ?? "");
      const tb = b.kind === "log" ? b.entry.ts : (b.entry.timestamp ?? "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    return merged;
  }
  return visibleLogs
    .filter((l) => tab?.categories.includes(getLogCategory(l.level, l.message)))
    .map((l) => ({ kind: "log" as const, entry: l }));
}, [filter, tab, visibleLogs, events]);
```

In `LogStream.tsx`, find `handleCopy` (likely line ~146 inline). Wrap in `useCallback`:

```ts
const handleCopy = useCallback((text: string) => {
  void navigator.clipboard.writeText(text);
}, []);
```

In `src/dashboard/components/log-panel/LogLine.tsx`, wrap the export in `React.memo`:

```ts
import { memo } from "react";

function LogLineImpl(props: LogLineProps) {
  // ... existing body ...
}

export const LogLine = memo(LogLineImpl);
```

(The default `React.memo` shallow comparison is enough as long as `entry` and `onCopy` are stable, which they are after the previous changes.)

Verify and commit:

```bash
npm run typecheck && npm run test:architecture
git add src/dashboard/components/hooks/useLogs.ts src/dashboard/components/log-panel/LogStream.tsx src/dashboard/components/log-panel/LogLine.tsx
git commit -m "$(cat <<'EOF'
perf(dashboard): memo log collapse + sort + LogLine

useLogs' collapse loop wasn't memoized; ran on every parent render.
LogStream's "all" tab sort used localeCompare per element when ISO
timestamps are lexicographically chronological (use < / >). LogLine
wasn't React.memo'd. handleCopy was inline.

Memoize collapse, fix the sort, memo LogLine, useCallback handleCopy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3 (Commit B): `LogPanel` + `useSessions` JSON-stringify hash → fingerprint**

In `src/dashboard/components/log-panel/LogPanel.tsx`, find the `JSON.stringify(prev) === JSON.stringify(data)` short-circuit (around line 74-78). Replace with structural compare:

```ts
setRuns((prev) => {
  if (prev.length === data.length && prev.every((r, i) =>
    r.runId === data[i].runId &&
    r.status === data[i].status &&
    r.lastLogTs === data[i].lastLogTs
  )) {
    return prev;
  }
  return data;
});
```

In `src/dashboard/components/hooks/useSessions.ts`, find the `JSON.stringify(data)` short-circuit (around line 21-23). Drop it entirely — `useSessions`' downstream consumers (`TerminalDrawer`, `WorkflowBox`) already memoize their derived UIs, so no-op deduping at this layer is unnecessary. Just `setState(data)` on every message.

Verify and commit:

```bash
npm run typecheck && npm run test:architecture
git add src/dashboard/components/log-panel/LogPanel.tsx src/dashboard/components/hooks/useSessions.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): replace JSON.stringify hash short-circuits

LogPanel and useSessions both used JSON.stringify(prev)===JSON.stringify(data)
to dedupe SSE messages. With 5-25 entries and 5-20KB payloads, that's
1-5ms per message just for the dedupe.

LogPanel: structural compare on (runId, status, lastLogTs).
useSessions: drop the dedupe — downstream components already memoize.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4 (Commit C): Centralized `useNow()` singleton replaces per-row 1Hz timers**

Add `src/dashboard/components/hooks/useNow.ts`:

```ts
import { useEffect, useState } from "react";

let now = Date.now();
const subscribers = new Set<(n: number) => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  now = Date.now();
  for (const sub of subscribers) sub(now);
}

/**
 * Subscribe to a shared 1Hz clock. One module-level setInterval drives
 * all subscribers — replaces N independent setIntervals across all
 * useElapsed call sites. Component re-renders happen in the same React
 * batch (React 18+ auto-batching).
 */
export function useNow(): number {
  const [n, setN] = useState(now);
  useEffect(() => {
    subscribers.add(setN);
    if (subscribers.size === 1) intervalId = setInterval(tick, 1000);
    return () => {
      subscribers.delete(setN);
      if (subscribers.size === 0 && intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
  }, []);
  return n;
}
```

Modify `src/dashboard/components/hooks/useElapsed.ts` to consume `useNow`:

```ts
import { useNow } from "./useNow";

/** Returns a live "Xm Ys" string that counts up from startTime. */
export function useElapsed(startTime: string | null): string {
  const now = useNow();
  if (!startTime) return "";
  const start = new Date(startTime).getTime();
  const diff = Math.max(0, Math.floor((now - start) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function formatDuration(startIso: string, endIso: string): string {
  const diff = Math.max(0, Math.floor((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000));
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
```

Verify and commit:

```bash
npm run typecheck && npm run test:architecture
git add src/dashboard/components/hooks/useNow.ts src/dashboard/components/hooks/useElapsed.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): centralized useNow() replaces N per-row 1Hz timers

useElapsed spun a setInterval per call site. With 5 running rows + 3
daemon cards + 1 LogPanel + 2 ParentChildRows + ParentChildRow timers
that's 11+ uncoordinated 1Hz intervals each forcing a React commit.

One module-level setInterval drives all subscribers; React 18+ batches
the resulting setStates in the same render pass. Behavior identical;
overhead drops to one timer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5 (Commit D): OCR localStorage debounce**

In `src/dashboard/components/ocr/OcrReviewPane.tsx`, find the `useEffect` that writes `localEdits` to localStorage (around line 143-153). Replace synchronous write with debounced:

```ts
useEffect(() => {
  const handle = window.setTimeout(() => {
    if (Object.keys(localEdits).length === 0) {
      try { window.localStorage.removeItem(storageKey); } catch { /* ignore */ }
      return;
    }
    try { window.localStorage.setItem(storageKey, JSON.stringify(localEdits)); } catch { /* quota / unavailable */ }
  }, 300);
  return () => window.clearTimeout(handle);
}, [localEdits, storageKey]);
```

Verify and commit:

```bash
npm run typecheck && npm run test:architecture
git add src/dashboard/components/ocr/OcrReviewPane.tsx
git commit -m "$(cat <<'EOF'
perf(dashboard): debounce OCR localEdits localStorage writes (300ms)

The effect fired on every keystroke in any OCR review field; with
20+ records and many fields each the JSON write hit ~50KB and
localStorage.setItem is synchronous (5-15ms blocking).

Wrap in setTimeout(300ms) + clearTimeout — batches keystrokes within
the same input pass. Final write still lands; intermediate writes
are dropped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Final verification for the whole task**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

All four commits should be present on the task's branch.

---

## End-of-Wave-B checklist (orchestrator runs after all 6 subagents return)

- [ ] All six subagents reported completion.
- [ ] For each branch `feature/perf-tier-3-task-N` (N=5..10): verified — commit present, status clean, HEAD on expected branch.
- [ ] Merge sequentially: `git merge --no-ff feature/perf-tier-3-task-5`, ..., `git merge --no-ff feature/perf-tier-3-task-10`.
- [ ] After each merge, `npm run typecheck && npm run test:architecture` on master.
- [ ] After all merges: `git worktree remove <each-path>` + `git branch -d feature/perf-tier-3-task-N`.
- [ ] Sweep: `git worktree list` shows no perf-tier-3-* entries; `git branch --list 'feature/perf-tier-3-*'` empty.

---

## End-of-Tier-3 verification (full-suite + manual smoke)

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

All three pass. Then a manual smoke test in dev (one operator session):

1. `npm run dashboard` — backend boots, frontend loads.
2. Open a long-running workflow (separations or onboarding) and watch the queue panel during a multi-step run. Re-render flicker should be visibly reduced vs. pre-Tier 2.
3. Hit `/api/preflight` twice within 60s — the second response should be near-instant (cached).
4. Trigger a "Copy from prior" affordance with cold cache (restart backend first) — should return < 50ms instead of 100ms+.
5. Watch a daemon's logs while it's idle; the keepalive tick should now log per-system healthChecks within ~3s of each other rather than ~12s apart.

---

## Handoff back to project / closing

Tier 3 lands. The perf-review arc is complete.

Recommended next step: ask the user whether they want a final consolidated review of all three tiers' diffs (`superpowers:requesting-code-review` over the combined Tier 1+2+3 diff). The user's global CLAUDE.md prescribes Claude reports findings only — they implement fixes themselves based on findings.

Out-of-scope items deferred for separate sessions:
- HeroUI calendar swap (`@heroui/styles` global import → `react-day-picker`). ~50–100KB gzip win on initial paint. Needs its own brainstorm + ui-ux-pro-max + frontend-design chain since it's a UI redesign.
- LogStream virtualization (`react-window` / `react-virtual`). Tier 3 added `React.memo(LogLine)` and the foundation for `content-visibility: auto` CSS-only virtualization; library-based virtualization is a follow-up if measured load > 500 lines proves problematic.
