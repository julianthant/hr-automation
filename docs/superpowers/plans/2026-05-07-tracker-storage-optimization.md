# Tracker Storage Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the five concrete scaling smells in the tracker storage layer (unbounded `sessions.jsonl`, unindexed disk scan for screenshots, no SQLite TTL, unbounded parse cache, dual queue backends) without changing observable workflow behavior.

**Architecture:** SQLite (`.tracker/state.db`) is already the live projection of every JSONL append via `applyTrackerEntryLive` / `applyLogEntryLive` / `applySessionEventLive` (`src/tracker/state/runtime.ts`). This plan completes the migration so SSE reads come from SQLite where the data already exists, JSONL writes are bounded by date rotation, and cleanup prunes both layers in lockstep.

**Tech Stack:** TypeScript / **Node 26** (ESM, `"type": "module"`, target ES2024) / `node:sqlite` via the project's compat shim at `src/infra/sqlite/index.ts` / Hono SSE / `node:test` (run via `tsx --test`). No new runtime dependencies.

**Working branch:** `tracker-storage-opt` (= local `master` + the plan commit). Master itself is checked out in another worktree, so subagent worktrees branch off `tracker-storage-opt` and merge back into it.

---

## Master codebase reality (read this before writing code)

The plan was originally drafted against an older branch with different paths. These are the *real* paths on master, verified at plan-write time:

| Concept | Path on master |
|---|---|
| JSONL append/read | `src/tracker/jsonl.ts` |
| Sessions emit/read | `src/tracker/session-events.ts` |
| SQLite open/migrate | `src/tracker/state/db.ts` (uses `openDatabase` from `src/infra/sqlite/index.js`) |
| Live projection apply | `src/tracker/state/runtime.ts` |
| SQLite read queries | `src/tracker/state/queries.ts` |
| Schema migrations | `src/tracker/state/schema.ts` |
| `/events/run-events` SSE handler | `src/tracker/dashboard/hono/routes/events.ts` |
| Screenshots handler | `src/tracker/dashboard/screenshots.ts` (impl) + `src/tracker/dashboard/hono/routes/screenshots.ts` (HTTP wiring) |
| `filterEventsForRun` / `rebuildSessionState` | `src/tracker/dashboard/session-state.ts` |
| `clean:tracker` CLI | `src/scripts/ops/clean-tracker.ts` |
| Daemon queue (jsonl + sqlite paths) | `src/core/daemon/queue.ts` |

**SQLite shim API** (`src/infra/sqlite/index.ts`) — important differences from `better-sqlite3`:

```ts
// Open
import { openDatabase, transaction, type Database } from "../infra/sqlite/index.js";
const db = openDatabase(path, { readonly: false }); // pragmas applied automatically

// Type — never import from "better-sqlite3" or "node:sqlite" directly
function take(db: Database, ...): ... { ... }

// Transaction is a FREE FUNCTION, not a method
transaction(db, () => { /* body */ });   // ✅
db.transaction(() => { /* body */ })();  // ❌ does not exist on the shim

// prepare/all/get/run shape is unchanged from better-sqlite3
db.prepare("SELECT ... WHERE x = @x").all({ x: 1 });

// Unknown named params are silently ignored (shim sets setAllowUnknownNamedParameters(true))
```

**Test framework** is `node:test` (NOT vitest). Pattern from `tests/unit/tracker/jsonl.test.ts:1-14`:

```ts
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "fs";
import { /* ... */ } from "../../../src/tracker/jsonl.js"; // .js extensions required
```

Run a single test file: `tsx --test tests/unit/tracker/jsonl.test.ts`.
Run a directory: `node scripts/run-tests.mjs tests/unit/tracker`.
Run all: `npm run test`.

---

## Task decomposition

Six independent tasks. Each is a single-subagent dispatch on its own worktree branched off `tracker-storage-opt`. The orchestrator merges sequentially after every parallel subagent has been verified per `~/.claude/CLAUDE.md` § "Parallel worktree discipline."

| Task | Branch | Primary files | Backstop tests |
|---|---|---|---|
| 1 | `feature/tracker-opt-1-sessions-rotation` | `src/tracker/session-events.ts`, `src/tracker/jsonl.ts` (add export only), `src/scripts/ops/clean-tracker.ts`, new `tests/unit/tracker/session-events-rotation.test.ts` | `tsx --test tests/unit/tracker/session-events-rotation.test.ts`, `tsx --test tests/unit/tracker/jsonl.test.ts`, `tsx --test tests/unit/scripts/ops/clean-tracker.test.ts` |
| 2 | `feature/tracker-opt-2-sse-from-sqlite` | `src/tracker/dashboard/hono/routes/events.ts`, `src/tracker/state/queries.ts`, `tests/unit/tracker/run-events-sse.test.ts` | `tsx --test tests/unit/tracker/run-events-sse.test.ts` |
| 3 | `feature/tracker-opt-3-screenshots-from-files` | `src/tracker/dashboard/screenshots.ts`, new `src/tracker/state/file-queries.ts`, `tests/unit/tracker/screenshots-endpoint.test.ts`, `tests/unit/tracker/dashboard-screenshots.test.ts` | `tsx --test tests/unit/tracker/screenshots-endpoint.test.ts`, `tsx --test tests/unit/tracker/dashboard-screenshots.test.ts` |
| 4 | `feature/tracker-opt-4-sqlite-prune` | `src/scripts/ops/clean-tracker.ts`, new `src/tracker/state/cleanup.ts`, `tests/unit/scripts/ops/clean-tracker.test.ts` | `tsx --test tests/unit/scripts/ops/clean-tracker.test.ts` |
| 5 | `feature/tracker-opt-5-parsecache-lru` | `src/tracker/jsonl.ts` (parseCache block only), `tests/unit/tracker/jsonl.test.ts` | `tsx --test tests/unit/tracker/jsonl.test.ts` |
| 6 | `feature/tracker-opt-6-retire-jsonl-queue` | `src/core/daemon/queue.ts`, `src/tracker/CLAUDE.md`, `tests/unit/core/daemon-queue.test.ts` | `tsx --test tests/unit/core/daemon-queue.test.ts`, `tsx --test tests/unit/core/daemon.test.ts` |

**Task 1 and Task 5** both touch `src/tracker/jsonl.ts` but in non-overlapping sections (Task 1 only adds an export at the bottom; Task 5 only modifies the existing `parseCache` block ~lines 67–83). They can dispatch in parallel; trivial merge in the orchestrator if anything overlaps.

**Tasks 1 and 4** both touch `src/scripts/ops/clean-tracker.ts`. They overlap at the import block plus one block inside `cleanTrackerMain`. Easiest: dispatch Task 1 first (small change, lands quickly), then dispatch Task 4. Or dispatch in parallel and resolve the import-list conflict in the orchestrator.

Every task ends with `npm run typecheck && npm run test:architecture && tsx --test <relevant>` green before commit.

---

## Task 1: Rotate `sessions.jsonl` into dated files

**Files:**
- Modify: `src/tracker/session-events.ts:66-99` — switch `getSessionsFilePath` + read/write to date-aware behavior
- Modify: `src/tracker/jsonl.ts` — append `cleanOldSessionFiles(maxAgeDays, dir)` near the existing `cleanOldTrackerFiles` (find via grep — function lives there)
- Modify: `src/scripts/ops/clean-tracker.ts` — call `cleanOldSessionFiles` from `cleanTrackerMain`
- Create: `tests/unit/tracker/session-events-rotation.test.ts`

**Why:** `.tracker/sessions.jsonl` is one file for the project's lifetime. Every `/events/run-events` SSE tick re-parses it on mtime change. After months of daemon uptime it's multi-MB. Rotation gives clean per-day files that prune automatically with the existing `clean:tracker` flow.

**Migration strategy:** Going forward, writes go to `sessions-{YYYY-MM-DD}.jsonl`. Reads aggregate every `sessions-*.jsonl` PLUS the legacy single `sessions.jsonl` (until it ages out via `cleanOldSessionFiles`). No one-time migration script — the legacy file is read alongside dated files until pruning removes it.

- [ ] **Step 1: Anchor edits**

```bash
grep -n "SESSIONS_FILE\|getSessionsFilePath\|readSessionEvents\|emitSessionEvent" src/tracker/session-events.ts
grep -n "cleanOldTrackerFiles\|cleanOldScreenshots" src/tracker/jsonl.ts
grep -n "cleanOldTrackerFiles\|cleanOldScreenshots\|cleanOldSession" src/scripts/ops/clean-tracker.ts
```

- [ ] **Step 2: Write failing rotation test**

Create `tests/unit/tracker/session-events-rotation.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emitSessionEvent,
  readSessionEvents,
  getSessionsFilePath,
  getSessionsFilePathForDate,
} from "../../../src/tracker/session-events.js";

describe("sessions.jsonl rotation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sess-rot-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes new events to a date-suffixed file", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Test 1" }, dir);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(existsSync(join(dir, `sessions-${today}.jsonl`)));
    assert.equal(existsSync(join(dir, "sessions.jsonl")), false);
  });

  it("reads from both dated files and legacy single file", () => {
    // Seed legacy file (pre-rotation data we still need to surface).
    writeFileSync(
      join(dir, "sessions.jsonl"),
      JSON.stringify({
        type: "workflow_start",
        timestamp: "2026-01-01T00:00:00.000Z",
        pid: 1,
        workflowInstance: "Legacy 1",
      }) + "\n",
    );
    // Seed an old dated file.
    writeFileSync(
      join(dir, "sessions-2026-04-01.jsonl"),
      JSON.stringify({
        type: "workflow_start",
        timestamp: "2026-04-01T00:00:00.000Z",
        pid: 2,
        workflowInstance: "Apr 1",
      }) + "\n",
    );
    // Fresh emit lands in today's file.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Today 1" }, dir);

    const events = readSessionEvents(dir);
    const instances = events.map((e) => e.workflowInstance).sort();
    assert.deepEqual(instances, ["Apr 1", "Legacy 1", "Today 1"]);
  });

  it("getSessionsFilePathForDate returns the dated path", () => {
    assert.equal(
      getSessionsFilePathForDate("2026-05-07", dir),
      join(dir, "sessions-2026-05-07.jsonl"),
    );
  });

  it("getSessionsFilePath returns today's dated path", () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(getSessionsFilePath(dir), join(dir, `sessions-${today}.jsonl`));
  });
});
```

Run: `tsx --test tests/unit/tracker/session-events-rotation.test.ts` — Expected: FAIL (`getSessionsFilePathForDate` not exported, dated file not written).

- [ ] **Step 3: Implement rotation in session-events.ts**

Replace the file-path constants and helpers (`src/tracker/session-events.ts:66-99`):

```ts
// ── File paths ─────────────────────────────────────────
//
// Sessions rotate into dated files (`sessions-YYYY-MM-DD.jsonl`) the same
// way tracker entries do. Reads aggregate every dated file plus a legacy
// single `sessions.jsonl` written before rotation landed; that legacy
// file ages out via `cleanOldSessionFiles` like any other dated file.

const LEGACY_SESSIONS_FILE = "sessions.jsonl";
const SESSIONS_PREFIX = "sessions-";
const SESSIONS_SUFFIX = ".jsonl";

export function getSessionsFilePath(dir: string = DEFAULT_DIR): string {
  return getSessionsFilePathForDate(dateLocal(), dir);
}

export function getSessionsFilePathForDate(
  date: string,
  dir: string = DEFAULT_DIR,
): string {
  return join(dir, `${SESSIONS_PREFIX}${date}${SESSIONS_SUFFIX}`);
}

// ── Read / Write ───────────────────────────────────────

export function emitSessionEvent(
  event: Omit<SessionEvent, "timestamp" | "pid">,
  dir: string = DEFAULT_DIR,
): void {
  const runId = event.runId ?? getLogRunId();
  const full: SessionEvent = {
    ...event,
    ...(runId ? { runId } : {}),
    timestamp: new Date().toISOString(),
    pid: process.pid,
  };
  // Route to the dated file matching `full.timestamp`'s local date — same
  // rule tracker entries follow (see `dateLocal(new Date(entry.timestamp))`
  // in jsonl.ts:trackEvent). Keeps batch-scope events emitted near local
  // midnight in the same file as the per-item rows from the same run.
  const trackerDate = dateLocal(new Date(full.timestamp));
  const path = getSessionsFilePathForDate(trackerDate, dir);
  const source = appendJsonlWithSource(path, full, {
    sourceKind: "session",
    trackerDate,
  });
  applySessionEventLive(full, source, dir);
}

export function readSessionEvents(dir: string = DEFAULT_DIR): SessionEvent[] {
  const out: SessionEvent[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(
      (f) => f === LEGACY_SESSIONS_FILE ||
        (f.startsWith(SESSIONS_PREFIX) && f.endsWith(SESSIONS_SUFFIX)),
    );
  } catch {
    return out; // dir doesn't exist
  }
  // Sort by date for deterministic ordering. Legacy file sorts first
  // (no date in its name; treat as oldest).
  files.sort();
  for (const f of files) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip malformed lines — same tolerance as the prior implementation.
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Add `cleanOldSessionFiles` to `src/tracker/jsonl.ts`**

Find the existing `cleanOldTrackerFiles` (`grep -n cleanOldTrackerFiles src/tracker/jsonl.ts`). Right after it, add:

```ts
/**
 * Delete `sessions-YYYY-MM-DD.jsonl` files older than `maxAgeDays`. Also
 * deletes the legacy single `sessions.jsonl` if its mtime is older than
 * `maxAgeDays` — matches the existing age-gated treatment that file
 * receives elsewhere.
 */
export function cleanOldSessionFiles(maxAgeDays: number, dir: string = DEFAULT_DIR): number {
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    const full = join(dir, f);
    if (f === "sessions.jsonl") {
      try {
        const stat = statSync(full);
        if (stat.mtimeMs < cutoffMs) {
          unlinkSync(full);
          deleted += 1;
        }
      } catch { /* missing or unreadable — skip */ }
      continue;
    }
    const m = f.match(/^sessions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    const dateStr = m[1];
    const dateMs = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(dateMs) || dateMs >= cutoffMs) continue;
    try {
      unlinkSync(full);
      deleted += 1;
    } catch { /* missing or unreadable — skip */ }
  }
  return deleted;
}
```

(`statSync` and `unlinkSync` should already be imported in `jsonl.ts`. Verify with grep; if missing, extend the existing `import { ... } from "node:fs"` line.)

- [ ] **Step 5: Wire into `src/scripts/ops/clean-tracker.ts`**

Add to the import group at the top:

```ts
import {
  cleanOldTrackerFiles,
  cleanOldSessionFiles,
  cleanOldScreenshots,
  DEFAULT_DIR,
} from "../../tracker/jsonl.js";
```

Inside `cleanTrackerMain`, in the existing `if (cleanTracker)` block — after the existing `cleanOldTrackerFiles` log line, before the orphan-uploads sweep:

```ts
const sessionsDeleted = cleanOldSessionFiles(days, dir);
if (sessionsDeleted > 0) {
  log.success(
    `Deleted ${sessionsDeleted} stale sessions file${sessionsDeleted === 1 ? "" : "s"} (older than ${days} day${days === 1 ? "" : "s"}) from ${dir}`,
  );
}
```

Extend the return type to include `sessionsDeleted`:

```ts
export function cleanTrackerMain(argv: string[] = process.argv.slice(2)): {
  trackerDeleted: number;
  screenshotsDeleted: number;
  sessionsDeleted: number;
} {
```

Update the test in `tests/unit/scripts/ops/clean-tracker.test.ts` to assert the new field exists.

- [ ] **Step 6: Run tests**

```bash
tsx --test tests/unit/tracker/session-events-rotation.test.ts
tsx --test tests/unit/tracker/jsonl.test.ts
tsx --test tests/unit/scripts/ops/clean-tracker.test.ts
npm run typecheck
npm run test:architecture
```

All must pass. Existing tests that referenced `sessions.jsonl` directly may need to use `getSessionsFilePathForDate(today, dir)` — fix breakage as you go.

- [ ] **Step 7: Commit**

```bash
git add src/tracker/session-events.ts src/tracker/jsonl.ts \
        src/scripts/ops/clean-tracker.ts \
        tests/unit/tracker/session-events-rotation.test.ts \
        tests/unit/scripts/ops/clean-tracker.test.ts
git commit -m "$(cat <<'EOF'
refactor(tracker): rotate sessions.jsonl into dated files

Bound sessions.jsonl growth: writes go to sessions-YYYY-MM-DD.jsonl
matching the timestamp's local date; reads aggregate every dated
file plus a legacy sessions.jsonl until it ages out. clean:tracker
now prunes session files alongside tracker files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Switch `/events/run-events` SSE to query SQLite for session events

**Files:**
- Modify: `src/tracker/dashboard/hono/routes/events.ts` — replace `readSessionEventsTolerant` call with a SQLite query when DB is ready
- Modify: `src/tracker/state/queries.ts` — add `querySessionEventsForRun(db, opts)`
- Test: `tests/unit/tracker/run-events-sse.test.ts` (existing, extend)

**Why:** `session_events` table is already populated synchronously via `applySessionEventLive` on every emit (`src/tracker/session-events.ts:89` → `src/tracker/state/runtime.ts:33`). The SSE handler still parses the entire JSONL on every tick. Switching the read to an indexed SQL query (`idx_session_events_run` on `(run_id, ts_ms)`, `idx_session_events_instance` on `(workflow_instance, ts_ms)` per `src/tracker/state/schema.ts:140-141`) is constant-time. After Task 1 lands, the JSONL fallback only ever scans today's file.

**Backwards compatibility:** Keep the JSONL fallback when `isStateDbReady(dir)` returns false (DB missing, schema mismatch, or read-only failure). Same gate the projection's other read sites already use.

- [ ] **Step 1: Read the existing handler**

```bash
grep -n "/events/run-events\|readSessionEventsTolerant\|filterEventsForRun" src/tracker/dashboard/hono/routes/events.ts
```

- [ ] **Step 2: Add the query function to `src/tracker/state/queries.ts`**

Append (after `queryRunsForItem`):

```ts
import type { Database } from "../../infra/sqlite/index.js";
import type { SessionEvent } from "../session-events.js";

/**
 * Read every session event whose `run_id` matches `opts.runId` OR (for
 * batch-scope events emitted before the per-item ALS context was
 * established) whose `workflow_instance` matches `opts.workflowInstance`.
 * Time-window filtering happens client-side via `filterEventsForRun` so the
 * caller can pass the result straight through and get identical output to
 * the JSONL path.
 *
 * Returns events ordered by ts_ms ASC for deterministic SSE rendering.
 *
 * The session_events row stores the full event payload as `raw_json` (see
 * src/tracker/state/schema.ts:135). We deserialize that to recover the same
 * shape `readSessionEvents` returns from JSONL.
 */
export function querySessionEventsForRun(
  db: Database,
  opts: { runId: string; workflowInstance?: string },
): SessionEvent[] {
  const params: Record<string, unknown> = { runId: opts.runId };
  let where = "run_id = @runId";
  if (opts.workflowInstance) {
    where += " OR (run_id IS NULL AND workflow_instance = @instance)";
    params.instance = opts.workflowInstance;
  }
  const rows = db.prepare(`
    SELECT raw_json FROM session_events
    WHERE ${where}
    ORDER BY ts_ms ASC, id ASC
  `).all(params) as Array<{ raw_json: string }>;
  const out: SessionEvent[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.raw_json) as SessionEvent);
    } catch {
      // Skip — projection rebuild will reconcile.
    }
  }
  return out;
}
```

- [ ] **Step 3: Update the handler in `src/tracker/dashboard/hono/routes/events.ts`**

Find the line that calls `readSessionEventsTolerant(deps.dir)` for `/events/run-events`. Replace with:

```ts
let allEvents: SessionEvent[];
if (isStateDbReady(deps.dir)) {
  const trackerEntry = trackerEntries.find((e) => e.runId === requestedRunId);
  const wfInstance =
    typeof trackerEntry?.data?.instance === "string"
      ? trackerEntry.data.instance
      : undefined;
  allEvents = querySessionEventsForRun(openStateDb(deps.dir), {
    runId: requestedRunId,
    ...(wfInstance ? { workflowInstance: wfInstance } : {}),
  });
} else {
  allEvents = await readSessionEventsTolerant(deps.dir);
}
```

Add imports near the top of `events.ts`:

```ts
import { isStateDbReady, openStateDb } from "../../state/db.js";
import { querySessionEventsForRun } from "../../state/queries.js";
```

(Verify the relative depth — `events.ts` is at `src/tracker/dashboard/hono/routes/events.ts`, so it's `../../state/db.js` reaching `src/tracker/state/db.ts`. Confirm with the existing imports in that file before committing.)

`filterEventsForRun(allEvents, trackerEntries, requestedRunId)` runs unchanged — its inputs are the same shape from either source.

- [ ] **Step 4: Extend the SSE test**

In `tests/unit/tracker/run-events-sse.test.ts`, add a test that asserts identical output between the two paths. Pattern:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
// ... existing imports

describe("/events/run-events SQLite vs JSONL parity", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(/* ... */); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns identical events from SQLite and JSONL fallback paths", async () => {
    // Seed via the normal emit path so both stores are populated.
    // ... emit a tracker entry + session events ...

    const fromSqlite = await callRunEventsHandler({ dir, runId: "r1" });

    // Force fallback by closing+removing the DB.
    closeStateDbForTests(dir);
    rmSync(stateDbPath(dir));

    const fromJsonl = await callRunEventsHandler({ dir, runId: "r1" });

    assert.deepEqual(
      fromJsonl.map((e) => ({ ...e })), // spread for null-prototype-row compat
      fromSqlite.map((e) => ({ ...e })),
    );
  });
});
```

(See `src/infra/sqlite/CLAUDE.md` lessons learned: `node:sqlite` returns `[Object: null prototype]` rows; spread `{ ...row }` before `assert.deepEqual`.)

- [ ] **Step 5: Run tests**

```bash
tsx --test tests/unit/tracker/run-events-sse.test.ts
npm run typecheck
npm run test:architecture
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/dashboard/hono/routes/events.ts \
        src/tracker/state/queries.ts \
        tests/unit/tracker/run-events-sse.test.ts
git commit -m "$(cat <<'EOF'
perf(server): serve /events/run-events from SQLite when projection ready

Replaces the per-tick full-file JSONL parse of sessions.jsonl with an
indexed SQL query against session_events (idx_session_events_run +
idx_session_events_instance). JSONL fallback retained for when
isStateDbReady returns false.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Screenshots endpoint queries `files` table instead of scanning disk

**Files:**
- Modify: `src/tracker/dashboard/screenshots.ts` — both overloads of `buildScreenshotsHandler`
- Create: `src/tracker/state/file-queries.ts`
- Test: `tests/unit/tracker/screenshots-endpoint.test.ts` (existing, extend) and `tests/unit/tracker/dashboard-screenshots.test.ts`

**Why:** Every screenshot is registered in SQLite `files` table at capture time (see schema in `src/tracker/state/schema.ts:143-162`: `kind`, `storage_path`, `workflow`, `item_id`, `run_id`, `sha256`, `bytes`, with index `idx_files_owner` on `(workflow, item_id, run_id)`). The current handler still parses `sessions.jsonl` AND `readdirSync`s the disk to build its grouped + legacy view. With the data already indexed by `(workflow, item_id, run_id)`, neither read is needed.

**Backwards compatibility:** Keep the legacy disk-scan path as a fallback when `isStateDbReady(dir)` is false OR when the `files` table has zero rows for the queried `(workflow, itemId)` (so a stale projection doesn't blank a real screenshot list — disk fallback still surfaces "legacy" entries correctly).

- [ ] **Step 1: Read existing handler**

```bash
grep -n "buildScreenshotsHandler\|getSessionsFilePath\|readdirSync" src/tracker/dashboard/screenshots.ts
```

- [ ] **Step 2: Create `src/tracker/state/file-queries.ts`**

```ts
import type { Database } from "../../infra/sqlite/index.js";

export interface FileRow {
  file_id: string;
  kind: string;
  storage_path: string;
  workflow: string | null;
  item_id: string | null;
  run_id: string | null;
  source: string;
  bytes: number;
  created_at: string; // ISO-8601
  last_accessed_at: string | null;
}

/**
 * List every screenshot registered in the `files` table for a workflow +
 * itemId. The schema indexes on (workflow, item_id, run_id) so this is a
 * direct seek. Files whose storage_path no longer exists on disk should be
 * filtered by the caller via `existsSync` — projection rebuild does not
 * unregister files when the disk copy is removed by `cleanOldScreenshots`.
 */
export function queryScreenshotsForItem(
  db: Database,
  opts: { workflow: string; itemId: string },
): FileRow[] {
  return db.prepare(`
    SELECT file_id, kind, storage_path, workflow, item_id, run_id, source, bytes,
           created_at, last_accessed_at
    FROM files
    WHERE workflow = @workflow AND item_id = @itemId AND kind = 'screenshot'
    ORDER BY created_at DESC
  `).all(opts) as FileRow[];
}
```

- [ ] **Step 3: Switch grouped handler in `src/tracker/dashboard/screenshots.ts`**

In the `groupedHandler` branch, replace the JSONL parse + disk scan with a SQLite-first path:

```ts
return async function groupedHandler(
  query: { workflow: string; itemId: string },
): Promise<ScreenshotGroupedEntry[]> {
  const { workflow, itemId } = query;

  // Prefer SQLite when ready and populated.
  if (isStateDbReady(dir)) {
    const db = openStateDb(dir);
    const rows = queryScreenshotsForItem(db, { workflow, itemId });
    if (rows.length > 0) {
      // Pull the matching screenshot session_events from SQLite to recover
      // group labels (kind/step). Group rows by ts when an event matches;
      // unmatched rows fall under the synthetic "legacy" bucket.
      const events = rows[0]?.run_id
        ? querySessionEventsForRun(db, { runId: rows[0].run_id })
            .filter((e) => e.type === "screenshot")
        : [];
      const grouped = groupScreenshotRows(
        rows.filter((r) => existsSync(r.storage_path)),
        events as Array<{
          ts: number;
          kind: "form" | "error" | "manual";
          label: string;
          step: string | null;
          files: Array<{ system: string; path: string }>;
        }>,
      );
      if (grouped.length > 0) return grouped;
    }
  }

  // Fallback: original JSONL + disk implementation, unchanged.
  return groupedHandlerLegacy({ dir, screenshotsDir, workflow, itemId });
};
```

Move the existing JSONL+disk implementation into a private `groupedHandlerLegacy` function in the same file so both paths are testable.

Add a private helper next to it:

```ts
function groupScreenshotRows(
  rows: FileRow[],
  events: Array<{ ts: number; kind: "form" | "error" | "manual"; label: string; step: string | null; files: Array<{ system: string; path: string }> }>,
): ScreenshotGroupedEntry[] {
  const eventByPath = new Map<string, { ts: number; kind: "form" | "error" | "manual"; label: string; step: string | null; system: string }>();
  for (const ev of events) {
    for (const f of ev.files) {
      eventByPath.set(f.path, { ts: ev.ts, kind: ev.kind, label: ev.label, step: ev.step, system: f.system });
    }
  }
  const groupedByTs = new Map<number, ScreenshotGroupedEntry>();
  const legacyFiles: ScreenshotGroupedEntry["files"] = [];
  let legacyTs = 0;

  for (const row of rows) {
    const ev = eventByPath.get(row.storage_path);
    const fileEntry = {
      system: ev?.system ?? "unknown",
      path: row.storage_path,
      url: `/screenshots/${encodeURIComponent(row.storage_path.split(/[/\\]/).pop() ?? "")}`,
    };
    if (ev) {
      const existing = groupedByTs.get(ev.ts);
      if (existing) existing.files.push(fileEntry);
      else groupedByTs.set(ev.ts, { ts: ev.ts, kind: ev.kind, label: ev.label, step: ev.step, files: [fileEntry] });
    } else {
      const fileTs = Date.parse(row.created_at);
      if (Number.isFinite(fileTs) && fileTs > legacyTs) legacyTs = fileTs;
      legacyFiles.push(fileEntry);
    }
  }

  const out = [...groupedByTs.values()];
  if (legacyFiles.length > 0) {
    out.push({ ts: legacyTs, kind: "error", label: "legacy", step: null, files: legacyFiles });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}
```

For the legacy flat-list overload, apply the same SQLite-first pattern: query `queryScreenshotsForItem`, fall back to `readdirSync`. Both return the same `ScreenshotListEntry[]` shape so callers don't change.

Imports at the top of `src/tracker/dashboard/screenshots.ts`:

```ts
import { isStateDbReady, openStateDb } from "../state/db.js";
import { queryScreenshotsForItem, type FileRow } from "../state/file-queries.js";
import { querySessionEventsForRun } from "../state/queries.js";
```

- [ ] **Step 4: Extend the screenshots tests**

Add a parity test in `tests/unit/tracker/screenshots-endpoint.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";

it("SQLite path returns same shape as disk path", async () => {
  // Seed via normal emit so files table is populated.
  // ... emit a screenshot session event + register file ...
  const fromSqlite = await handler({ workflow, itemId });

  // Force disk fallback.
  closeStateDbForTests(dir);
  rmSync(stateDbPath(dir));

  const fromDisk = await handler({ workflow, itemId });

  assert.deepEqual(
    fromDisk.map((e) => ({ ...e, files: e.files.map((f) => ({ ...f })) })),
    fromSqlite.map((e) => ({ ...e, files: e.files.map((f) => ({ ...f })) })),
  );
});
```

- [ ] **Step 5: Run tests**

```bash
tsx --test tests/unit/tracker/screenshots-endpoint.test.ts
tsx --test tests/unit/tracker/dashboard-screenshots.test.ts
npm run typecheck
npm run test:architecture
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/dashboard/screenshots.ts \
        src/tracker/state/file-queries.ts \
        tests/unit/tracker/screenshots-endpoint.test.ts \
        tests/unit/tracker/dashboard-screenshots.test.ts
git commit -m "$(cat <<'EOF'
perf(server): serve /api/screenshots from SQLite files table

Replaces sessions.jsonl parse + readdirSync scan with an indexed SQL
query against the files table (idx_files_owner). Disk-scan path
retained as fallback for missing/stale projection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Extend `clean:tracker` to prune SQLite

**Files:**
- Create: `src/tracker/state/cleanup.ts`
- Modify: `src/scripts/ops/clean-tracker.ts`
- Modify: `tests/unit/scripts/ops/clean-tracker.test.ts`

**Why:** `state.db` accumulates `run_events`, `runs`, `items`, `logs`, `session_events`, `files`, `task_attempts`, `worker_commands` rows indefinitely. JSONL pruning leaves them behind. Single transaction-wrapped DELETE plus VACUUM keeps the DB bounded.

**Retention semantics:** Match the JSONL `--days` flag. Anything whose `tracker_date` (TEXT YYYY-MM-DD) or applicable timestamp column is older than the cutoff gets deleted. **All schema timestamp columns on master are TEXT ISO-8601 strings**, not numeric ms — comparisons use string ordering (which works correctly for ISO format).

- [ ] **Step 1: Read schema column names**

```bash
grep -n "CREATE TABLE\|tracker_date\|created_at\|ts_ms" src/tracker/state/schema.ts
```

Verify the columns used below match the actual schema. The plan assumes:
- `run_events`, `runs`, `items`, `logs`: `tracker_date` (TEXT YYYY-MM-DD)
- `session_events`: `ts_ms` (INTEGER)
- `files`: `created_at` (TEXT ISO)
- `tasks`: `created_at` (TEXT ISO)
- `task_attempts`: `created_at` (TEXT ISO)
- `worker_commands`: needs to be checked (likely `created_at` TEXT ISO or `enqueued_at`)
- `workers`: `last_heartbeat_at` for stale, `stopped_at` for completed (TEXT ISO)
- `browser_processes`: `terminated_at` (TEXT ISO) for completed

If a column name differs, adjust the SQL — the schema is the source of truth.

- [ ] **Step 2: Write the failing test in `tests/unit/scripts/ops/clean-tracker.test.ts`**

Add:

```ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackEvent } from "../../../../src/tracker/jsonl.js";
import {
  openStateDb,
  closeStateDbForTests,
} from "../../../../src/tracker/state/db.js";
import { cleanTrackerMain } from "../../../../src/scripts/ops/clean-tracker.js";

describe("cleanTrackerMain SQLite prune", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "clean-sql-")); });
  afterEach(() => {
    closeStateDbForTests(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes SQLite rows whose tracker_date is older than --days", () => {
    // Seed two tracker entries: one fresh (today), one ancient (90 days ago).
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    trackEvent({
      workflow: "x", id: "1", runId: "r1", timestamp: old,
      status: "done", data: {},
    } as any, dir);
    trackEvent({
      workflow: "x", id: "2", runId: "r2", timestamp: today,
      status: "done", data: {},
    } as any, dir);

    const db = openStateDb(dir);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM run_events").get() as { n: number }).n,
      2,
    );

    cleanTrackerMain(["--days", "30", "--dir", dir, "--no-screenshots"]);

    const remaining = db.prepare("SELECT item_id FROM run_events").all() as Array<{ item_id: string }>;
    assert.deepEqual(remaining.map((r) => r.item_id), ["2"]);
  });
});
```

Run: `tsx --test tests/unit/scripts/ops/clean-tracker.test.ts` — Expected: FAIL (SQLite not pruned).

- [ ] **Step 3: Implement `src/tracker/state/cleanup.ts`**

```ts
import {
  isStateDbReady,
  openStateDb,
} from "./db.js";
import { transaction } from "../../infra/sqlite/index.js";

export interface PruneResult {
  runEventsDeleted: number;
  runsDeleted: number;
  itemsDeleted: number;
  logsDeleted: number;
  sessionEventsDeleted: number;
  filesDeleted: number;
  taskAttemptsDeleted: number;
  workerCommandsDeleted: number;
}

/**
 * Delete every projected row whose tracker_date (or timestamp, for tables
 * lacking tracker_date) is older than `cutoffDate` (YYYY-MM-DD ISO). Runs in
 * a single transaction via the shim's `transaction(db, fn)` so a partial
 * prune can't half-update the DB. VACUUM runs after commit (best-effort).
 *
 * Returns counts per table for log output. No-op (returns zeros) when the
 * projection isn't ready.
 */
export function pruneStateDb(dir: string, cutoffDate: string): PruneResult {
  const zero: PruneResult = {
    runEventsDeleted: 0, runsDeleted: 0, itemsDeleted: 0, logsDeleted: 0,
    sessionEventsDeleted: 0, filesDeleted: 0, taskAttemptsDeleted: 0,
    workerCommandsDeleted: 0,
  };
  if (!isStateDbReady(dir)) return zero;
  const db = openStateDb(dir);
  const cutoffIso = `${cutoffDate}T00:00:00.000Z`;
  const cutoffMs = Date.parse(cutoffIso);
  const result = { ...zero };

  transaction(db, () => {
    result.runEventsDeleted = db.prepare(
      "DELETE FROM run_events WHERE tracker_date < @cutoffDate"
    ).run({ cutoffDate }).changes;
    result.runsDeleted = db.prepare(
      "DELETE FROM runs WHERE tracker_date < @cutoffDate"
    ).run({ cutoffDate }).changes;
    result.itemsDeleted = db.prepare(
      "DELETE FROM items WHERE tracker_date < @cutoffDate"
    ).run({ cutoffDate }).changes;
    result.logsDeleted = db.prepare(
      "DELETE FROM logs WHERE tracker_date < @cutoffDate"
    ).run({ cutoffDate }).changes;
    // session_events stores ts_ms (numeric), all others TEXT ISO.
    result.sessionEventsDeleted = db.prepare(
      "DELETE FROM session_events WHERE ts_ms < @cutoffMs"
    ).run({ cutoffMs }).changes;
    // files: created_at (TEXT ISO). String comparison works for ISO.
    result.filesDeleted = db.prepare(
      "DELETE FROM files WHERE created_at < @cutoffIso"
    ).run({ cutoffIso }).changes;
    result.taskAttemptsDeleted = db.prepare(
      "DELETE FROM task_attempts WHERE created_at < @cutoffIso"
    ).run({ cutoffIso }).changes;
    // worker_commands — use whatever timestamp column exists (created_at
    // typical). Adjust per schema.ts at write time.
    result.workerCommandsDeleted = db.prepare(
      "DELETE FROM worker_commands WHERE created_at < @cutoffIso"
    ).run({ cutoffIso }).changes;
  });

  // VACUUM cannot run inside a transaction. Best-effort — WAL exclusive
  // locking can fail if another connection is open; that's fine, the next
  // run will pick it up.
  try { db.exec("VACUUM"); } catch { /* skip if busy */ }
  return result;
}
```

- [ ] **Step 4: Wire into `src/scripts/ops/clean-tracker.ts`**

Add to imports:

```ts
import { pruneStateDb } from "../../tracker/state/cleanup.js";
```

Inside `cleanTrackerMain`, after the existing tracker-files log line:

```ts
const cutoffDate = new Date(Date.now() - days * 24 * 3600 * 1000)
  .toISOString().slice(0, 10);
const sqlPrune = pruneStateDb(dir, cutoffDate);
const totalSqlDeleted =
  sqlPrune.runEventsDeleted + sqlPrune.runsDeleted + sqlPrune.itemsDeleted +
  sqlPrune.logsDeleted + sqlPrune.sessionEventsDeleted + sqlPrune.filesDeleted +
  sqlPrune.taskAttemptsDeleted + sqlPrune.workerCommandsDeleted;
if (totalSqlDeleted > 0) {
  log.success(
    `Deleted ${totalSqlDeleted} SQLite row${totalSqlDeleted === 1 ? "" : "s"} ` +
    `(run_events=${sqlPrune.runEventsDeleted} runs=${sqlPrune.runsDeleted} ` +
    `items=${sqlPrune.itemsDeleted} logs=${sqlPrune.logsDeleted} ` +
    `session_events=${sqlPrune.sessionEventsDeleted} files=${sqlPrune.filesDeleted} ` +
    `task_attempts=${sqlPrune.taskAttemptsDeleted} worker_commands=${sqlPrune.workerCommandsDeleted}) ` +
    `older than ${days} day${days === 1 ? "" : "s"}`,
  );
}
```

- [ ] **Step 5: Run tests**

```bash
tsx --test tests/unit/scripts/ops/clean-tracker.test.ts
npm run typecheck
npm run test:architecture
```

If a column name differs from the assumption, adjust the SQL and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/tracker/state/cleanup.ts src/scripts/ops/clean-tracker.ts \
        tests/unit/scripts/ops/clean-tracker.test.ts
git commit -m "$(cat <<'EOF'
feat(tracker): prune SQLite state.db on clean:tracker

Deletes run_events / runs / items / logs / session_events / files /
task_attempts / worker_commands rows older than --days, then VACUUMs.
Was a slow leak — JSONL pruned but projection grew indefinitely.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: LRU eviction on `parseCache`

**Files:**
- Modify: `src/tracker/jsonl.ts` — replace `Map` with bounded LRU at the `parseCache` block (find via `grep -n parseCache src/tracker/jsonl.ts`)
- Test: `tests/unit/tracker/jsonl.test.ts` (existing, extend)

**Why:** `parseCache` is `new Map()` with no eviction. Every `(workflow, date)` ever read by the dashboard adds an entry that never gets removed. After a long-lived dashboard session walking through historical dates, this grows unboundedly.

**Sizing:** Default cap = 64. ~10 workflows × ~7 active dates = 70 entries; 64 covers active use without re-parsing today's hot file. Trivial to tune later.

- [ ] **Step 1: Read the existing block**

```bash
grep -n -A 20 "const parseCache\|function readJsonlCached" src/tracker/jsonl.ts
```

- [ ] **Step 2: Write failing test in `tests/unit/tracker/jsonl.test.ts`**

```ts
import {
  __resetParseCacheForTests,
  __getParseCacheSizeForTests,
  readEntries,
} from "../../../src/tracker/jsonl.js";

describe("parseCache LRU", () => {
  beforeEach(() => __resetParseCacheForTests());

  it("caps cache size at 64 entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "lru-"));
    for (let i = 0; i < 100; i++) {
      const wf = `wf${i}`;
      writeFileSync(
        join(dir, `${wf}-2026-05-07.jsonl`),
        '{"workflow":"' + wf + '","id":"x","runId":"r","timestamp":"2026-05-07T00:00:00Z","status":"done","data":{}}\n',
      );
      readEntries(wf, dir);
    }
    assert.ok(__getParseCacheSizeForTests() <= 64);
  });
});
```

Run: `tsx --test tests/unit/tracker/jsonl.test.ts` — Expected: FAIL (`__getParseCacheSizeForTests` not exported, cache uncapped).

- [ ] **Step 3: Implement bounded LRU**

Replace the `parseCache` block in `src/tracker/jsonl.ts` with:

```ts
// Cache parsed JSONL by file path with LRU eviction. Map's insertion-order
// iteration plus delete-on-hit + re-set gives a 6-line LRU without a dep.
// Cap chosen for ~10 workflows × ~7 active dates.
const PARSE_CACHE_MAX = 64;
type ParseCacheEntry = { mtimeMs: number; size: number; entries: unknown[] };
const parseCache = new Map<string, ParseCacheEntry>();

function readJsonlCached<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  const cached = parseCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Bump to most-recent.
    parseCache.delete(path);
    parseCache.set(path, cached);
    return cached.entries as T[];
  }
  const entries = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  parseCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  if (parseCache.size > PARSE_CACHE_MAX) {
    const oldestKey = parseCache.keys().next().value;
    if (oldestKey !== undefined) parseCache.delete(oldestKey);
  }
  return entries as T[];
}

/** Test-only — reset between cases. */
export function __resetParseCacheForTests(): void {
  parseCache.clear();
}

/** Test-only — observable cache size for size-cap assertions. */
export function __getParseCacheSizeForTests(): number {
  return parseCache.size;
}
```

- [ ] **Step 4: Run tests**

```bash
tsx --test tests/unit/tracker/jsonl.test.ts
npm run typecheck
npm run test:architecture
```

- [ ] **Step 5: Commit**

```bash
git add src/tracker/jsonl.ts tests/unit/tracker/jsonl.test.ts
git commit -m "$(cat <<'EOF'
perf(tracker): cap parseCache at 64 entries with LRU eviction

The JSONL read cache had no eviction — long-lived dashboard sessions
walking through historical dates accumulated entries indefinitely.
Map iteration-order + delete-on-hit gives LRU in 6 lines, no dep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Retire the JSONL queue backend

**Files:**
- Modify: `src/core/daemon/queue.ts` — delete `legacyReadQueueState`, `queueBackend()`, the `HRAUTO_QUEUE_BACKEND` env-var dispatch
- Modify: `src/tracker/CLAUDE.md` — drop the "`HRAUTO_QUEUE_BACKEND=jsonl` is a temporary cutover fallback" line
- Modify: `tests/unit/core/daemon-queue.test.ts` — remove tests targeting the legacy path; keep audit-append tests
- Verify: `tests/unit/core/daemon.test.ts` and `tests/unit/core/daemon-client.test.ts` still pass

**Why:** SQLite has been the default queue backend. The JSONL fallback (`legacyReadQueueState` at `src/core/daemon/queue.ts:54`) is parallel code that needs to be maintained, exercised by tests, and is O(n) on claim. Removing it shrinks `queue.ts` and removes a configuration footgun.

**Audit-only writes preserved:** `appendEvent` in `queue.ts` keeps appending to `.queue.jsonl` so existing dashboards/operators can `tail -f` for debugging. Only the *read* path is retired.

**Pre-flight check:** Search for production callers and CI configs that set `HRAUTO_QUEUE_BACKEND=jsonl`:

```bash
grep -rn "HRAUTO_QUEUE_BACKEND" --include="*.ts" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.md" .
```

If any non-test caller exists, **stop and surface to the orchestrator** — the legacy path may still be load-bearing. The task then converts to "deprecate with warning, remove in a follow-up" instead of a hard removal.

- [ ] **Step 1: Verify no production callers**

```bash
grep -rn "HRAUTO_QUEUE_BACKEND" --include="*.ts" --include="*.yml" --include="*.yaml" --include="*.json" --include="*.md" .
```

Expected: matches only in `src/core/daemon/queue.ts`, `src/tracker/CLAUDE.md`, `src/core/CLAUDE.md`, and test files. Halt and flag if anything else matches.

- [ ] **Step 2: Map all branches that gate on `queueBackend()`**

```bash
grep -n "queueBackend\|HRAUTO_QUEUE_BACKEND\|legacyReadQueueState\|legacy[A-Z]" src/core/daemon/queue.ts
```

- [ ] **Step 3: Delete the legacy branches**

In `src/core/daemon/queue.ts`:
1. Remove `queueBackend()` function (line 16-18).
2. Remove `legacyReadQueueState` (line 54+) and any `legacy*` write/claim/done/failed helpers.
3. For every `if (queueBackend() === 'jsonl') { /* legacy */ } else { /* sqlite */ }` branch — keep only the SQLite branch.
4. Keep `appendEvent` and the JSONL audit-write side effects in the SQLite path. Audit trail stays.

- [ ] **Step 4: Update `src/tracker/CLAUDE.md`**

Remove:
> `HRAUTO_QUEUE_BACKEND=jsonl` is a temporary cutover fallback only. Default queue authority is SQLite.

Replace with:
> Queue authority is SQLite. The `.queue.jsonl` file in `.tracker/daemons/` is an append-only audit trail only — readers must not consume it as state.

Check `src/core/CLAUDE.md` for similar mentions and update.

- [ ] **Step 5: Update tests**

In `tests/unit/core/daemon-queue.test.ts`:
- Delete every test that explicitly sets `process.env.HRAUTO_QUEUE_BACKEND = 'jsonl'`. The existing `withQueueBackend` helper (file:25) becomes a no-op or is removed.
- Keep tests that verify `.queue.jsonl` audit lines are still appended on enqueue/claim/done/failed.
- Confirm SQLite-path tests still pass without the env var dispatch.

- [ ] **Step 6: Run the broader daemon test suite**

```bash
tsx --test tests/unit/core/daemon-queue.test.ts
tsx --test tests/unit/core/daemon.test.ts
tsx --test tests/unit/core/daemon-client.test.ts
tsx --test tests/unit/core/enqueue-dispatch.test.ts
npm run typecheck
npm run test:architecture
```

All must pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/daemon/queue.ts src/tracker/CLAUDE.md src/core/CLAUDE.md \
        tests/unit/core/daemon-queue.test.ts
git commit -m "$(cat <<'EOF'
refactor(daemon): retire JSONL queue backend, SQLite is sole authority

HRAUTO_QUEUE_BACKEND=jsonl was a transitional fallback; SQLite has
been default. Removed legacyReadQueueState + every queueBackend()
gate. .queue.jsonl audit-append preserved for tail-f debugging.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final Sweep

After all six tasks merge to `tracker-storage-opt`:

- [ ] Full suite over the combined diff:

```bash
npm run typecheck:all
npm run test
npm run test:architecture
```

- [ ] Smoke test the dashboard:

```bash
npm run dashboard
# Browser: http://localhost:5173 — click into a recent run, open Events tab,
# confirm events render. Page through dates in the date picker. If a separation
# fails locally, confirm screenshots show in the failure card.
```

- [ ] Run `clean:tracker` end-to-end against a real `.tracker/` and confirm both file deletes, session-file deletes, and SQLite row deletes are reported.

- [ ] Update `src/tracker/CLAUDE.md` "Lessons Learned" with one dated entry per non-obvious change (rotation read order, SQLite-first SSE fallback, LRU sizing rationale, queue-backend retirement).

- [ ] Run codex:rescue over the combined diff (read-only review per the global execution model). Findings go to the orchestrator session for follow-up commits if any.

- [ ] Fast-forward `master` to `tracker-storage-opt` from the user's primary worktree, then delete `tracker-storage-opt`.

---

## Self-Review Notes

- **Path correctness:** Every plan-touched path was verified against master at write time (2026-05-07 PT).
- **SQLite shim:** All DB access goes through `openDatabase` + `transaction(db, fn)` — no `better-sqlite3` imports introduced.
- **Test framework:** All tests use `node:test` + `node:assert/strict`. No vitest helpers (`expect`, `vi`) appear.
- **Imports:** All `.js` extensions on relative imports per repo convention.
- **Schema columns:** TEXT ISO (`created_at`, `last_accessed_at`, `tracker_date`) compared as strings; INTEGER ms (`ts_ms`) compared numerically.
- **Risk concentrated in Task 6.** It's the only task that *removes* a code path. The pre-flight grep is mandatory; if a non-test caller exists, the task degrades to deprecation-with-warning rather than hard removal.
- **Welcome's 6 server hardening fixes** (CORS bind, 4xx codes, sweep DB cleanup, await enqueue, daemon-log streaming, preview-inbox now-injection) are NOT in this plan. They live in deleted welcome commits and need a separate follow-up plan to port to master's `src/tracker/dashboard/` paths.
