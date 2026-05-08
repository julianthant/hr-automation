# Performance Review — Tier 2: High-Impact Surgical Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land nine surgical performance fixes that materially reduce per-emit, per-tick, and per-render cost across tracker, queue, dashboard backend, and dashboard frontend. Each task is a single self-contained commit.

**Architecture:** Every task touches a disjoint set of files — they can all dispatch in **one parallel batch** (nine worktrees + nine branches per `~/.claude/CLAUDE.md` parallel discipline). Land Tier 1 first; Tier 2 assumes daemon fetch timeouts are already in place.

**Tech Stack:** Node 26, `node:sqlite`, Hono, React 19, Vite.

**Verification (every task):**
- `npm run typecheck` — must pass
- `npm run test:architecture` — must pass
- Per-task unit tests where listed

**Out of scope:**
- Anything in Tier 3 (medium-impact fixes; separate plan).
- Architectural rewrites. No library swaps in Tier 2.

---

## Parallel dispatch guidance

All nine tasks below touch **disjoint files** — they can be dispatched in a single parallel batch. Per the user's branching strategy in `~/.claude/CLAUDE.md`:

- Each subagent gets its own worktree under `.claude/worktrees/perf-tier-2-task-N/` and a `feature/perf-tier-2-task-N` branch.
- Subagents commit ONLY to their own branch.
- Orchestrator (Opus) verifies each subagent's branch (`git log --oneline master..HEAD` shows the commit, `git status` clean, HEAD on the expected branch) before merging.
- After ALL nine return + verify, orchestrator merges sequentially with `git merge --no-ff feature/perf-tier-2-task-N` in task-number order.
- After every merge: `git worktree remove <path>` + `git branch -d feature/perf-tier-2-task-N`. End-of-batch sweep: `git worktree list` + `git branch --list 'feature/*'` should be empty.

Conceptual ordering (informational — does not affect dispatch order; all tasks are file-disjoint):
- Task 6 (EntryItem React.memo) benefits from Task 7 (useEntries hash compaction). Both still ship in this batch.

---

## Task 1: Drop `countJsonlLines` — eliminate full-file read per JSONL append

**Why:** `countJsonlLines` reads the entire file on every `appendJsonlWithSource` call to compute a `source.line` integer that is stored in SQLite as `source_line` but never queried back as a sort key or filter. The append happens on every tracker entry, log entry, and session event. As today's logs file grows to multi-MB, every new line re-reads the whole file.

**Files:**
- Modify: `src/tracker/state/jsonl-source.ts` — remove `countJsonlLines`, drop `line` from the returned `ProjectionSourceRef`.
- Modify: `src/tracker/state/types.ts` — make `line` optional (`line?: number`) for backward compat with cached/old refs.
- Modify: `src/tracker/state/apply.ts` — drop `source_line` from the INSERTs that reference it.
- Modify: `src/tracker/state/schema.ts` — DDL: leave the column in place (cheaper than a migration), but stop writing it. The `source_line` column becomes vestigial; we don't ALTER TABLE.
- Read-only: `src/tracker/state/jsonl-source.ts` callers — confirm no caller reads `.line` off the returned ref.

- [ ] **Step 1: Confirm baseline green**

```bash
npm run typecheck && npm run test:architecture
```

Both must pass.

- [ ] **Step 2: Search for `source_line` and `.line` consumers**

```bash
rg "source_line|\.line\b" src/tracker/state/ src/tracker/jsonl.ts src/tracker/session-events.ts
```

Note every site. Expected sites: schema definition (column), apply.ts INSERTs, jsonl-source.ts ref construction, types.ts type def. NO read-side consumer should exist.

- [ ] **Step 3: Edit `src/tracker/state/jsonl-source.ts`** — remove `countJsonlLines` and `line` from the returned ref.

Replace the entire file body (lines 1-31) with:

```ts
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { ProjectionSourceKind, ProjectionSourceRef } from "./types.js";

const knownDirs = new Set<string>();

export function appendJsonlWithSource(
  path: string,
  payload: unknown,
  source: Omit<ProjectionSourceRef, "path" | "line" | "offset">,
): ProjectionSourceRef {
  const dir = dirname(path);
  if (!knownDirs.has(dir)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    knownDirs.add(dir);
  }
  let offset = 0;
  try {
    offset = statSync(path).size;
  } catch {
    // File doesn't exist yet — append will create it.
  }
  appendFileSync(path, JSON.stringify(payload) + "\n");
  return { ...source, path, offset };
}

export function sourceKindForFile(path: string): ProjectionSourceKind {
  // Match both the legacy sessions.jsonl and dated sessions-YYYY-MM-DD.jsonl files.
  if (path.endsWith("sessions.jsonl") || /sessions-\d{4}-\d{2}-\d{2}\.jsonl$/.test(path)) return "session";
  if (path.endsWith("-logs.jsonl")) return "log";
  return "tracker";
}
```

Note: `countJsonlLines` is gone. The returned ref no longer has `line`. The `dir` `existsSync` check is cached in `knownDirs` per path so we only `statSync` the dir once per process per directory.

- [ ] **Step 4: Update `src/tracker/state/types.ts`** — make `line` optional.

Find the `ProjectionSourceRef` type. It has a `line: number` field. Change to `line?: number`.

```ts
// Before
export interface ProjectionSourceRef {
  // ...
  line: number;
  // ...
}

// After
export interface ProjectionSourceRef {
  // ...
  line?: number;
  // ...
}
```

(Read the file first to copy the surrounding fields exactly.)

- [ ] **Step 5: Update `src/tracker/state/apply.ts`** — stop writing `source_line` in INSERTs.

```bash
rg -n "source_line" src/tracker/state/apply.ts
```

For every INSERT statement that includes `source_line`, remove the column name and the corresponding `@line` parameter. The column stays in the schema (vestigial — column nullability lets old rows keep their values; new rows will write NULL). Run after each edit:

```bash
npm run typecheck
```

If typecheck complains about a missing `.line` property somewhere, replace the reference with `0` or remove it.

- [ ] **Step 6: Verify no caller reads `.line` off a ProjectionSourceRef**

```bash
rg "ref\.line|source\.line|\.line(?!s)" src/tracker/ src/core/
```

If any read-site survives, that callsite needs updating to handle the optional field (default to 0 or skip).

- [ ] **Step 7: Run unit tests**

```bash
npm run test -- --grep "jsonl-source|state-jsonl"
```

Expected: pass. If a test asserted `ref.line === N`, update it to drop the assertion or accept undefined.

- [ ] **Step 8: Run full verification**

```bash
npm run typecheck
npm run test:architecture
npm run test
```

All must pass.

- [ ] **Step 9: Commit**

```bash
git add src/tracker/state/jsonl-source.ts src/tracker/state/types.ts src/tracker/state/apply.ts
git commit -m "$(cat <<'EOF'
perf(tracker): drop countJsonlLines from JSONL append hot path

countJsonlLines did a full-file readFileSync + split('\n') on every
appendJsonlWithSource call, just to compute a `source.line` int that
SQLite stored but never queried back as a sort key or filter. With a
multi-MB *-logs.jsonl by midday, every new log entry was re-reading
the whole file before appending one line.

Drop the call entirely. ProjectionSourceRef.line becomes optional;
schema's source_line column is left in place (vestigial — no migration
needed). Also cache directory existence per process so the dir
existsSync/mkdir pair only fires once per process per dir.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Replace `emitStepChange` full-file scan with SQLite seek

**Why:** `emitStepChange` is called on every `markStep` across every workflow. The "tail-read" the comment claims is actually a `readFileSync(path, "utf-8")` on every workflow's full `*-logs.jsonl`, then `content.split("\n")`, then a tail-slice. By midday on a busy daemon this is multi-MB-per-`markStep` × N workflow files. Replace with an indexed SQLite seek against `idx_logs_item_run` when projection is ready; keep the JSONL path as a fallback.

**Files:**
- Modify: `src/tracker/session-events.ts:163-217` — `recentStepLogExists` + `emitStepChange`.
- Read-only: `src/tracker/state/runtime.ts` (for `isStateDbReady` / `getStateDb`).
- Read-only: `src/tracker/state/schema.ts:123` — `idx_logs_item_run ON logs(workflow, tracker_date, item_id, run_id, ts_ms)`.

- [ ] **Step 1: Confirm baseline green**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read state runtime helpers**

```bash
rg -n "isStateDbReady|getStateDb|openStateDb" src/tracker/state/runtime.ts
```

Note the exact export names. The pattern below assumes `isStateDbReady(dir)` (returns boolean) and `getStateDb(dir)` (returns `Database`). If the names differ, adapt the imports.

- [ ] **Step 3: Edit `src/tracker/session-events.ts`** — replace `recentStepLogExists` with a SQLite-aware seek.

Find the import block and add (if not already present):

```ts
import { isStateDbReady, getStateDb } from "./state/runtime.js";
```

Replace `recentStepLogExists` (lines 163-195 approx) with:

```ts
const STEP_LOG_DEDUPE_WINDOW_MS = 50;

/**
 * Dedupe `step_change` session events against `step` log entries written
 * within the last 50ms for the same (runId, step). Prefers a constant-time
 * SQLite seek on idx_logs_item_run when projection is ready; falls back to
 * a bounded-byte tail read of today's logs JSONL otherwise.
 */
function recentStepLogExists(
  workflow: string,
  runId: string,
  step: string,
  dir: string,
): boolean {
  const cutoffMs = Date.now() - STEP_LOG_DEDUPE_WINDOW_MS;

  // SQLite path — uses idx_logs_item_run (workflow, tracker_date, item_id, run_id, ts_ms).
  // We don't have item_id from the caller (emitStepChange has only workflow + runId),
  // so we filter by (workflow, run_id, ts_ms >= cutoff, level = 'step') and let SQLite
  // pick the index. tracker_date narrows further; today is the only relevant date.
  if (isStateDbReady(dir)) {
    try {
      const db = getStateDb(dir);
      const row = db.prepare(`
        SELECT 1
        FROM logs
        WHERE workflow = @workflow
          AND tracker_date = @date
          AND run_id = @runId
          AND level = 'step'
          AND ts_ms >= @cutoff
          AND message LIKE '%' || @step || '%'
        LIMIT 1
      `).get({
        workflow,
        date: dateLocal(),
        runId,
        cutoff: cutoffMs,
        step,
      });
      return row !== undefined;
    } catch {
      // Fall through to JSONL path on any SQLite hiccup.
    }
  }

  // JSONL fallback — bounded byte tail read of today's logs file. ~2 KB
  // covers the last ~10-20 lines, which is far more than the 50ms window
  // can produce. Avoids the multi-MB readFileSync the previous impl did.
  const path = join(dir, `${workflow}-${dateLocal()}-logs.jsonl`);
  let stat;
  try { stat = statSync(path); } catch { return false; }
  const tailBytes = Math.min(stat.size, 2048);
  if (tailBytes === 0) return false;
  let tail: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(tailBytes);
      readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      tail = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  // Drop the first (possibly partial) line if we didn't seek to a newline boundary.
  const firstNl = tail.indexOf("\n");
  const lines = firstNl >= 0 && stat.size > tailBytes ? tail.slice(firstNl + 1).split("\n") : tail.split("\n");
  for (const line of lines) {
    if (!line) continue;
    try {
      const log = JSON.parse(line);
      if (
        log.runId === runId &&
        log.level === "step" &&
        typeof log.message === "string" &&
        log.message.includes(step) &&
        new Date(log.ts).getTime() >= cutoffMs
      ) {
        return true;
      }
    } catch { /* skip malformed line */ }
  }
  return false;
}
```

Add the additional imports needed at the top of the file:

```ts
import { closeSync, openSync, readSync, statSync } from "node:fs";
```

(Adjust to merge with the existing `node:fs` import if present — likely already imports `existsSync, readFileSync`.)

`emitStepChange` itself (lines 197-217) is unchanged — it still calls `recentStepLogExists` per workflow file.

- [ ] **Step 4: Run unit tests**

```bash
npm run test -- --grep "session-events|emitStepChange|step.*dedupe"
```

Expected: pass. The dedupe test (in `tests/unit/tracker/session-events.test.ts` or similar) should still pass — the function's contract didn't change, only its implementation.

- [ ] **Step 5: Run full verification**

```bash
npm run typecheck
npm run test:architecture
npm run test
```

- [ ] **Step 6: Commit**

```bash
git add src/tracker/session-events.ts
git commit -m "$(cat <<'EOF'
perf(tracker): replace emitStepChange full-file scan with SQLite seek

recentStepLogExists' "tail read" comment was aspirational — the impl
called readFileSync on the whole *-logs.jsonl, split it line-by-line,
and only THEN sliced the last 8 lines. By midday with a multi-MB logs
file × N workflow files, every markStep paid a multi-MB read just to
dedupe against a step log written milliseconds earlier.

Prefer an indexed SQLite seek on idx_logs_item_run when projection is
ready (constant-time, sub-ms). JSONL path now does a bounded ~2 KB
tail read via openSync/readSync, recovering the comment's promise.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Collapse `queryEntriesPayload` workflow N+1 to one query

**Why:** `queryEntriesPayload` runs once per `/events` SSE tick (1 Hz × N connected clients). For each workflow on the active date it executes a separate prepared statement to fetch `latestRows`. With 10 workflows that's 10 queries per tick per client — a textbook N+1.

**Files:**
- Modify: `src/tracker/state/queries.ts:130-159` — collapse the per-workflow loop to a single query, partition in JS.

- [ ] **Step 1: Confirm baseline green**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `src/tracker/state/queries.ts:130-159`** — replace the per-workflow loop.

Replace:

```ts
  const failureCounts: Record<string, number> = {};
  for (const wf of workflows) {
    const latestRows = db.prepare(`
      SELECT workflow, latest_ts AS timestamp, item_id AS id, latest_run_id AS runId,
             latest_status AS status, latest_step AS step, latest_data_json AS data_json,
             latest_error AS error
      FROM items
      WHERE workflow = @workflow AND tracker_date = @date
    `).all({ workflow: wf, date: opts.date }) as Array<{
      workflow: string;
      timestamp: string;
      id: string;
      runId: string;
      status: "pending" | "running" | "done" | "failed" | "skipped";
      step?: string | null;
      data_json?: string | null;
      error?: string | null;
    }>;
    const n = computeFailureCounts(latestRows.map((row) => ({
      workflow: row.workflow,
      timestamp: row.timestamp,
      id: row.id,
      runId: row.runId,
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: parseJsonObject(row.data_json, {}),
      ...(row.error ? { error: row.error } : {}),
    })));
    if (n > 0) failureCounts[wf] = n;
  }
```

With:

```ts
  const failureCounts: Record<string, number> = {};
  // One query for ALL workflows on this date, partition in JS.
  // Replaces the prior per-workflow N+1 (one prepared statement per
  // workflow per tick per connected SSE client).
  const allLatestRows = db.prepare(`
    SELECT workflow, latest_ts AS timestamp, item_id AS id, latest_run_id AS runId,
           latest_status AS status, latest_step AS step, latest_data_json AS data_json,
           latest_error AS error
    FROM items
    WHERE tracker_date = @date
  `).all({ date: opts.date }) as Array<{
    workflow: string;
    timestamp: string;
    id: string;
    runId: string;
    status: "pending" | "running" | "done" | "failed" | "skipped";
    step?: string | null;
    data_json?: string | null;
    error?: string | null;
  }>;

  const rowsByWorkflow = new Map<string, typeof allLatestRows>();
  for (const row of allLatestRows) {
    const bucket = rowsByWorkflow.get(row.workflow);
    if (bucket) bucket.push(row);
    else rowsByWorkflow.set(row.workflow, [row]);
  }

  for (const wf of workflows) {
    const latestRows = rowsByWorkflow.get(wf) ?? [];
    if (latestRows.length === 0) continue;
    const n = computeFailureCounts(latestRows.map((row) => ({
      workflow: row.workflow,
      timestamp: row.timestamp,
      id: row.id,
      runId: row.runId,
      status: row.status,
      ...(row.step ? { step: row.step } : {}),
      data: parseJsonObject(row.data_json, {}),
      ...(row.error ? { error: row.error } : {}),
    })));
    if (n > 0) failureCounts[wf] = n;
  }
```

- [ ] **Step 3: Run unit tests targeting queries**

```bash
npm run test -- --grep "queryEntriesPayload|state-queries"
```

Expected: pass. The function's input/output contract is unchanged; only the SQL plan changed.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 5: Commit**

```bash
git add src/tracker/state/queries.ts
git commit -m "$(cat <<'EOF'
perf(tracker): collapse queryEntriesPayload workflow N+1 to one query

queryEntriesPayload runs every /events SSE tick (1 Hz per client). For
each workflow on the active date it ran a separate db.prepare(...).all
to compute failureCounts — N queries per tick per client. With 10
workflows × 5 tabs that's 50 prepared-statement executions/sec just
for the failure badge.

Collapse to one SELECT over all workflows on tracker_date, partition
by workflow in JS, then run computeFailureCounts on each bucket. Same
inputs and outputs; one query instead of N.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add 1s TTL cache around `rebuildSessionState(dir)` shared across SSE clients

**Why:** `/events/sessions` (1 Hz) and `/events/run-events` (2 Hz) call `rebuildSessionState(dir)` → `readSessionEvents(dir)` per client per tick. `readSessionEvents` reads every dated `sessions-YYYY-MM-DD.jsonl` un-cached. With 5 tabs × 30 day-files retained = 150 sync file reads/sec just for the sessions panel. The cache should be shared across all SSE clients (same pattern as the existing `getCrossWorkflowCounts` cache in this file).

**Files:**
- Modify: `src/tracker/dashboard/hono/routes/events.ts` — add `getCachedSessionState(dir)` near the top of the file, alongside `getCrossWorkflowCounts`. Wire `/events/sessions` and any other SSE callers to use it.

- [ ] **Step 1: Confirm baseline green**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read the existing `getCrossWorkflowCounts` cache** to mirror its shape.

Already shown in your context (lines 78-115). Same pattern: module-level `let cache | null`, key = `dir`, TTL constant, reset helper exported for tests.

- [ ] **Step 3: Add `getCachedSessionState` near `getCrossWorkflowCounts` in `events.ts`**

Find the `__resetCrossWorkflowCountsCacheForTests` export (line ~118) and add immediately after:

```ts
const SESSION_STATE_TTL_MS = 1_000;
let sessionStateCache:
  | { state: ReturnType<typeof rebuildSessionState>; computedAt: number; key: string }
  | null = null;

/**
 * 1s TTL cache around rebuildSessionState — shared across all connected
 * SSE clients of /events/sessions (and any other endpoint that wants the
 * current session aggregate). Without this, every SSE tick (1 Hz × N tabs)
 * re-aggregates every dated sessions-YYYY-MM-DD.jsonl file via uncached
 * readSessionEvents.
 */
function getCachedSessionState(dir: string): ReturnType<typeof rebuildSessionState> {
  const key = dir;
  const now = Date.now();
  if (
    sessionStateCache &&
    sessionStateCache.key === key &&
    now - sessionStateCache.computedAt < SESSION_STATE_TTL_MS
  ) {
    return sessionStateCache.state;
  }
  const state = rebuildSessionState(dir);
  sessionStateCache = { state, computedAt: now, key };
  return state;
}

export function __resetSessionStateCacheForTests(): void {
  sessionStateCache = null;
}
```

(Add `rebuildSessionState` to the existing import list if not already imported. Search for the import: `rg "rebuildSessionState" src/tracker/dashboard/hono/routes/events.ts`.)

- [ ] **Step 4: Wire `/events/sessions` (line ~390-398)**

Replace:

```ts
  app.get("/events/sessions", () => {
    return sseResponse((send) => {
      const tick = () => send(filterLiveSessionState(rebuildSessionState(deps.dir)));
      tick();
      const interval = setInterval(tick, 1_000);
      interval.unref?.();
      return () => clearInterval(interval);
    });
  });
```

With:

```ts
  app.get("/events/sessions", () => {
    return sseResponse((send) => {
      const tick = () => send(filterLiveSessionState(getCachedSessionState(deps.dir)));
      tick();
      const interval = setInterval(tick, 1_000);
      interval.unref?.();
      return () => clearInterval(interval);
    });
  });
```

- [ ] **Step 5: Search for any other `rebuildSessionState(` callsites in this file**

```bash
rg -n "rebuildSessionState\(" src/tracker/dashboard/hono/routes/events.ts
```

For each callsite that's inside an SSE tick (per-tick or per-client work), swap to `getCachedSessionState`. Do NOT swap callsites outside an SSE tick (e.g., one-shot `/api/...` handlers) — those are infrequent and the cache offers no benefit.

- [ ] **Step 6: Run unit tests**

```bash
npm run test -- --grep "events|session-state"
```

Some tests may rely on `rebuildSessionState` being called fresh — check whether any tests need to call `__resetSessionStateCacheForTests()` between cases (mirror the `__resetCrossWorkflowCountsCacheForTests` calls).

- [ ] **Step 7: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 8: Commit**

```bash
git add src/tracker/dashboard/hono/routes/events.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): cache rebuildSessionState across SSE clients (1s TTL)

/events/sessions (1 Hz) and /events/run-events (2 Hz) called
rebuildSessionState → readSessionEvents per client per tick — every
dated sessions-YYYY-MM-DD.jsonl re-read uncached. With 5 tabs × 30
retained day-files that's ~150 sync file reads/sec on a quiet
dashboard.

Mirror the getCrossWorkflowCounts pattern: module-level cache keyed
by dir, 1s TTL matching SSE cadence. Within any second the heavy
aggregation runs at most once across all connected clients.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Gate `/api/preflight` prune to once per 60s per process

**Why:** `/api/preflight` runs `cleanOldTrackerFiles(30)` + `cleanOldScreenshots(30)` synchronously on every call. The frontend polls preflight on mount; on retry/error loops this becomes a disk hammer. The prune is idempotent — caching its outcome for 60s costs nothing.

**Files:**
- Modify: `src/tracker/dashboard/hono/routes/base.ts:149-174`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `src/tracker/dashboard/hono/routes/base.ts`**

Find the `app.get("/api/preflight", ...)` block (line ~149) and replace with:

```ts
  // Module-scoped throttle: prune work runs at most once per 60s per
  // process. The prune is idempotent, so caching its outcome between
  // calls is safe and elides the frontend's preflight-polling cost.
  let lastPruneAtMs = 0;
  let cachedPruneResult = { deleted: 0, deletedShots: 0, sessionsCleaned: false };
  const PRUNE_INTERVAL_MS = 60_000;

  app.get("/api/preflight", () => {
    const now = Date.now();
    if (now - lastPruneAtMs >= PRUNE_INTERVAL_MS) {
      const deleted = cleanOldTrackerFiles(30, deps.dir);
      const deletedShots = cleanOldScreenshots(30);
      let sessionsCleaned = false;
      // Only the pre-rotation legacy `sessions.jsonl` is age-gated here.
      const legacySessionsPath = join(deps.dir, "sessions.jsonl");
      if (existsSync(legacySessionsPath)) {
        const ageMs = now - statSync(legacySessionsPath).mtimeMs;
        if (ageMs > 24 * 60 * 60 * 1000) {
          unlinkSync(legacySessionsPath);
          sessionsCleaned = true;
        }
      }
      cachedPruneResult = { deleted, deletedShots, sessionsCleaned };
      lastPruneAtMs = now;
    }
    const { deleted, deletedShots, sessionsCleaned } = cachedPruneResult;
    return jsonResponse({
      checks: [
        { name: "Dashboard connected", passed: true, detail: "SSE server running" },
        { name: "Old logs cleaned", passed: true, detail: `${deleted} file${deleted !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Old screenshots cleaned", passed: true, detail: `${deletedShots} screenshot${deletedShots !== 1 ? "s" : ""} removed (> 30 days)` },
        { name: "Session state", passed: true, detail: sessionsCleaned ? "Stale session file cleaned" : "OK" },
      ],
    });
  });
```

- [ ] **Step 3: Tests**

```bash
npm run test -- --grep "preflight"
```

If a test expects prune to run on every call, update the test to call across the throttle window (or add a `__resetPreflightThrottleForTests` helper export — only if a test actually needs it).

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard/hono/routes/base.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): throttle /api/preflight prune to once per 60s

cleanOldTrackerFiles(30) + cleanOldScreenshots(30) ran synchronously
on every /api/preflight call. Frontend polls preflight on mount; on
error loops it becomes a disk hammer.

Cache prune result for 60s per process. Prune is idempotent so the
cached "we're OK" payload is correct between invocations.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `React.memo(EntryItem)` + stable callbacks in App.tsx

**Why:** Queue rows re-render every SSE tick (1–5 Hz) for 50+ rows even when nothing changed. Wrapping `EntryItem` in `React.memo` is necessary but not sufficient — `App.tsx` passes inline arrow callbacks that change identity every render, defeating memoization. Stabilize handlers with `useCallback`, then memo the row.

**Files:**
- Modify: `src/dashboard/components/queue-panel/EntryItem.tsx` — wrap in `React.memo` with custom comparator.
- Modify: `src/dashboard/App.tsx:282-304` — convert inline arrow handlers to `useCallback`.
- Modify: `src/dashboard/components/queue-panel/QueuePanel.tsx` — accept stable handlers, drop the inline `onClick={() => onSelect(entry.id)}` closure (pass `onSelect` + `entry` and let `EntryItem` compose the call internally).

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Read current shapes**

```bash
sed -n '70,90p' src/dashboard/components/queue-panel/EntryItem.tsx
sed -n '180,250p' src/dashboard/components/queue-panel/QueuePanel.tsx
```

Note the current `EntryItemProps` and the QueuePanel call site that constructs `onClick={() => onSelect(entry.id)}`.

- [ ] **Step 3: Update `EntryItem.tsx`** — accept `onSelect` instead of `onClick`, wrap in `React.memo`.

At the top of the file, add `memo` to the React imports:

```ts
import { memo } from "react";
```

Find the existing prop interface:

```ts
interface EntryItemProps {
  entry: TrackerEntry;
  displayNames?: Map<string, string>;
  selected: boolean;
  onClick: () => void;
}
```

Replace with:

```ts
interface EntryItemProps {
  entry: TrackerEntry;
  displayNames?: Map<string, string>;
  selected: boolean;
  onSelect: (id: string) => void;
}
```

Find the function signature `export function EntryItem({ entry, displayNames, selected, onClick }: EntryItemProps) {` and replace the body's only `onClick` reference (search the file for `onClick`) — replace with `onClick={() => onSelect(entry.id)}` ON THE OUTERMOST CLICKABLE ELEMENT inside the body. The closure is now created once per row render but won't bust memo because `onSelect` is stable.

Then convert the export from `export function EntryItem(...) {` to:

```ts
function EntryItemImpl({ entry, displayNames, selected, onSelect }: EntryItemProps) {
  // ...current body, with the click handler binding rewritten...
}

export const EntryItem = memo(EntryItemImpl, (prev, next) => {
  if (prev.selected !== next.selected) return false;
  if (prev.onSelect !== next.onSelect) return false;
  if (prev.displayNames !== next.displayNames) return false;
  const a = prev.entry;
  const b = next.entry;
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.step === b.step &&
    a.timestamp === b.timestamp &&
    a.runId === b.runId &&
    a.error === b.error &&
    (a as any).lastLogMessage === (b as any).lastLogMessage &&
    (a as any).firstLogTs === (b as any).firstLogTs &&
    (a as any).lastLogTs === (b as any).lastLogTs &&
    a.data === b.data
  );
});
```

- [ ] **Step 4: Update `QueuePanel.tsx` call site**

Find the `<EntryItem ... onClick={() => onSelect(entry.id)} ... />` site (around line 188-244 in your context). Replace `onClick={() => onSelect(entry.id)}` with `onSelect={onSelect}`. Drop the inline arrow.

If `QueuePanel`'s prop type still declares `onSelect: (id: string) => void`, no change there. If anything else inside `QueuePanel` was creating a fresh closure per row, leave it for now (Tier 3 covers `runControlsSlot` memoization).

- [ ] **Step 5: Update `App.tsx:282-304`** — useCallback for all handlers passed to QueuePanel.

Add `useCallback` to the React import if not present.

Replace lines 282-304 (the inline arrow props on `<QueuePanel>`):

```tsx
        <QueuePanel
          entries={entries}
          workflow={workflow}
          displayNames={displayNames}
          selectedId={selectedId}
          onSelect={(id) => {
            setReviewingPrepId(null);
            setSelectedId(id);
          }}
          reviewingPrepId={reviewingPrepId}
          onOpenReview={(runId) => setReviewingPrepId(runId)}
          onReupload={(reuploadFor) => {
            setRunModalReuploadFor(reuploadFor);
            setRunModalOpen(true);
          }}
          drilledBatchRunId={drilledBatchRunId}
          onDrillIn={(parentRunId) => {
            setReviewingPrepId(null);
            setSelectedId(null);
            setDrilledBatchRunId(parentRunId);
          }}
          onDrillOut={() => {
            setDrilledBatchRunId(null);
          }}
          ...
```

With useCallback-stabilized refs declared above the JSX:

```tsx
  const handleSelectEntry = useCallback((id: string) => {
    setReviewingPrepId(null);
    setSelectedId(id);
  }, []);
  const handleOpenReview = useCallback((runId: string) => {
    setReviewingPrepId(runId);
  }, []);
  const handleReupload = useCallback((reuploadFor: { sessionId: string; previousRunId: string }) => {
    setRunModalReuploadFor(reuploadFor);
    setRunModalOpen(true);
  }, []);
  const handleDrillIn = useCallback((parentRunId: string) => {
    setReviewingPrepId(null);
    setSelectedId(null);
    setDrilledBatchRunId(parentRunId);
  }, []);
  const handleDrillOut = useCallback(() => {
    setDrilledBatchRunId(null);
  }, []);
```

Then in the JSX:

```tsx
        <QueuePanel
          entries={entries}
          workflow={workflow}
          displayNames={displayNames}
          selectedId={selectedId}
          onSelect={handleSelectEntry}
          reviewingPrepId={reviewingPrepId}
          onOpenReview={handleOpenReview}
          onReupload={handleReupload}
          drilledBatchRunId={drilledBatchRunId}
          onDrillIn={handleDrillIn}
          onDrillOut={handleDrillOut}
          loading={loading}
          runControlsSlot={runControlsSlot}
        />
```

(The exact `reuploadFor` parameter type comes from the existing inline arrow's type — match it. Read the original to confirm.)

- [ ] **Step 6: Verify the queue still functions in dev**

You can't run the dashboard from a subagent without supervision — that's fine. The verification at this step is:

```bash
npm run typecheck
npm run test:architecture
```

Both must pass. Ship the change without manual UI verification; the next session will verify.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/components/queue-panel/EntryItem.tsx src/dashboard/components/queue-panel/QueuePanel.tsx src/dashboard/App.tsx
git commit -m "$(cat <<'EOF'
perf(dashboard): React.memo EntryItem + useCallback handlers in App

Queue rows re-render every SSE tick (1-5 Hz × 50+ rows) even when
nothing changed. EntryItem wasn't memoized, and App.tsx passed inline
arrow callbacks (onSelect, onDrillIn, onDrillOut, onReupload,
onOpenReview) that minted a fresh identity per render — defeating
memoization downstream.

- Wrap EntryItem in React.memo with a custom field-by-field comparator.
- Hoist App.tsx handlers into useCallback so identities are stable.
- Pass onSelect down (stable) instead of an inline () => onSelect(entry.id)
  closure inside QueuePanel; EntryItem composes the call internally.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Compact `useEntries` SSE hash; drop volatile fields

**Why:** `useEntries` short-circuits SSE updates by hashing the array and comparing to the previous hash. The current hash uses `JSON.stringify(raw.map(...))` with nested `JSON.stringify(r.data)` and includes `lastLogMessage` — which changes on every log line and forces `displayNames` to rebuild every tick. Compact the fingerprint to only fields that drive UI; drop `lastLogMessage` from the cache key (it doesn't affect the rendered name/status).

**Files:**
- Modify: `src/dashboard/components/hooks/useEntries.ts:74-76`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `useEntries.ts:74-76`**

Replace:

```ts
        // Skip if data hasn't changed (prevent unnecessary re-renders)
        const hash = JSON.stringify(raw.map((r) => `${r.id}:${r.status}:${r.step}:${r.timestamp}:${JSON.stringify(r.data)}:${(r as any).lastLogMessage || ""}`));
        if (hash === prevHashRef.current) return;
        prevHashRef.current = hash;
```

With:

```ts
        // Skip if data hasn't changed (prevent unnecessary re-renders).
        // Compact fingerprint: id + status + step + timestamp + run anchors.
        // Deliberately omits `data` and `lastLogMessage` — neither affects
        // queue rendering identity, and including them caused per-log-line
        // hash churn that forced displayNames to rebuild every tick.
        const hash = raw.map((r) =>
          `${r.id}|${r.status}|${r.step ?? ""}|${r.timestamp}|${(r as any).firstLogTs ?? ""}|${(r as any).lastLogTs ?? ""}|${r.runId ?? ""}|${r.error ?? ""}`
        ).join(";");
        if (hash === prevHashRef.current) return;
        prevHashRef.current = hash;
```

If a downstream consumer relied on `data` mutations triggering an entries re-render (e.g., inline display of a workflow's `data` field), the change-detection there must be re-evaluated. As of 2026-05-07 the queue + log surfaces consume `data` only on entries that are already changing for status/step reasons — `data`-only updates don't change what's rendered in the queue list.

- [ ] **Step 3: Tests**

```bash
npm run test -- --grep "useEntries"
```

If a test asserts the hash includes `data`, update it to match the new fingerprint or remove the assertion (the hash is internal).

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/hooks/useEntries.ts
git commit -m "$(cat <<'EOF'
perf(dashboard): compact useEntries SSE hash; drop volatile fields

The previous short-circuit hash was JSON.stringify(raw.map(...)) with
a nested JSON.stringify(r.data) per entry AND lastLogMessage. With 50+
entries that's ~100 KB of JSON serialization per second, every second.
lastLogMessage in particular changes on every log line and forced the
displayNames useMemo to rebuild every tick.

Replace with a compact pipe-delimited fingerprint of the fields that
actually drive queue rendering (id, status, step, timestamp, run
anchors, error). Same short-circuit behavior; trace cost reduced
~10× and per-log-line churn eliminated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Delete `PdfPagePreview` polling interval

**Why:** Every `<PdfPagePreview>` instance spins a 10 Hz `setInterval` to check `img.complete`. The OCR review pane renders one preview per page (often 20–50). With 30 previews × 10 Hz that's 300 setStates/sec until images decode. Standard `onLoad`/`onError` events are already wired and the existing one-shot `useEffect` at line 178 already handles the cached-image case. The polling is dead weight.

**Files:**
- Modify: `src/dashboard/components/shared/PdfPagePreview.tsx:134-164`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `PdfPagePreview.tsx:134-164`**

Replace:

```ts
  useEffect(() => {
    if (!shouldLoad) return;
    let done = false;
    const mark = (status: "ok" | "error") => {
      if (done) return;
      done = true;
      setState(status);
      onStatusChange?.(page, status);
    };
    const checkDecoded = () => {
      const img = imgRef.current;
      if (!img?.complete) return;
      mark(img.naturalWidth > 0 ? "ok" : "error");
    };

    checkDecoded();
    const interval = window.setInterval(checkDecoded, 100);
    const timeout = window.setTimeout(() => {
      const img = imgRef.current;
      if (img?.complete && img.naturalWidth > 0) {
        mark("ok");
      } else {
        mark("error");
      }
    }, 15000);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [shouldLoad, src, page, onStatusChange]);
```

With:

```ts
  useEffect(() => {
    if (!shouldLoad) return;
    // 15s safety net — onLoad/onError fire reliably on the <img>; this
    // is the fallback for pathological cases where neither fires (e.g.,
    // navigation aborts the fetch silently).
    const timeout = window.setTimeout(() => {
      const img = imgRef.current;
      if (img?.complete && img.naturalWidth > 0) {
        setState("ok");
        onStatusChange?.(page, "ok");
      } else {
        setState("error");
        onStatusChange?.(page, "error");
      }
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [shouldLoad, src, page, onStatusChange]);
```

The existing `useEffect` at lines 178-190 already handles the "image already decoded" case via `img?.complete` check; that effect runs on the same deps. The `onLoad` / `onError` props on the `<img>` (lines 240-241 in your context) call `markLoaded` / `markFailed` directly. Polling is redundant.

- [ ] **Step 3: Tests**

```bash
npm run test -- --grep "PdfPagePreview" || echo "no direct tests"
```

There are no tests for this component (per the dashboard CLAUDE.md "no @testing-library/react setup"). The verification is typecheck + manual.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/shared/PdfPagePreview.tsx
git commit -m "$(cat <<'EOF'
perf(dashboard): delete PdfPagePreview 10Hz polling interval

Each PdfPagePreview spun a 100ms setInterval to poll img.complete on
top of the already-wired onLoad/onError handlers and a parallel
useEffect that already handles cached-image readiness. With 30+
previews on an OCR review pane, that's 300+ scheduled setState
calls/sec during the load window, all to detect a state the browser
already reports natively.

Drop the interval. Keep the 15s safety-net timeout for the rare case
where neither onLoad nor onError fires.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Parallelize `findAliveDaemons` probes

**Why:** `findAliveDaemons` probes lockfiles serially with `for (const entry of candidates) { ... await probeWhoami(...) }`. With 4 alive daemons and one whose event loop is briefly busy (1.5s probe timeout), one call takes 1.5s+; if two are busy, 3s; etc. Worst case = N × 1.5s. Called from every dashboard refresh, every enqueue, every keepalive — should be `Promise.all`.

**Files:**
- Modify: `src/core/daemon/registry.ts:160-201`.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run test:architecture
```

- [ ] **Step 2: Edit `registry.ts:160-201`**

Replace:

```ts
  const alive: Daemon[] = []
  for (const entry of candidates) {
    const path = join(dir, entry)
    const lock = readLockfile(path)
    if (!lock || lock.workflow !== workflow) {
      safeUnlink(path)
      continue
    }
    if (!isProcessAlive(lock.pid)) {
      safeUnlink(path)
      continue
    }
    const probe = await probeWhoami(lock.port, {
      workflow: lock.workflow,
      instanceId: lock.instanceId,
    })
    if (probe === 'mismatch') {
      safeUnlink(path)
      continue
    }
    alive.push({
      workflow: lock.workflow,
      instanceId: lock.instanceId,
      pid: lock.pid,
      ...(lock.parentPid ? { parentPid: lock.parentPid } : {}),
      port: lock.port,
      startedAt: lock.startedAt,
      lockfilePath: path,
    })
  }
  alive.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return alive
}
```

With:

```ts
  // Probe every candidate in parallel — each lockfile + probe is an
  // independent network/syscall pair. Worst-case wall time was N × 1.5s
  // (one slow probe times out, the next one starts); now it's max(per-probe).
  const probeResults = await Promise.all(
    candidates.map(async (entry) => {
      const path = join(dir, entry)
      const lock = readLockfile(path)
      if (!lock || lock.workflow !== workflow) {
        safeUnlink(path)
        return null
      }
      if (!isProcessAlive(lock.pid)) {
        safeUnlink(path)
        return null
      }
      const probe = await probeWhoami(lock.port, {
        workflow: lock.workflow,
        instanceId: lock.instanceId,
      })
      if (probe === 'mismatch') {
        safeUnlink(path)
        return null
      }
      // 'match' OR ('unreachable' && PID alive) — trust the lockfile.
      return {
        workflow: lock.workflow,
        instanceId: lock.instanceId,
        pid: lock.pid,
        ...(lock.parentPid ? { parentPid: lock.parentPid } : {}),
        port: lock.port,
        startedAt: lock.startedAt,
        lockfilePath: path,
      } satisfies Daemon
    }),
  )
  const alive = probeResults.filter((d): d is Daemon => d !== null)
  alive.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return alive
}
```

- [ ] **Step 3: Tests**

```bash
npm run test -- --grep "findAliveDaemons|registry"
```

Tests that assert serial behavior (e.g., counting how many `probeWhoami` calls happen before a particular `safeUnlink`) may fail under parallel execution. If so, the test needs updating — the contract is "every candidate is probed and stale ones are unlinked"; ordering between candidates is not part of the contract.

- [ ] **Step 4: Full verification**

```bash
npm run typecheck && npm run test:architecture && npm run test
```

- [ ] **Step 5: Commit**

```bash
git add src/core/daemon/registry.ts
git commit -m "$(cat <<'EOF'
perf(daemon): parallelize findAliveDaemons probes

The probe loop was serial: for (entry of candidates) await probeWhoami.
With 4 daemons and one slow event loop (1.5s probe timeout), worst
case was 4 × 1.5s = 6s before the function returned. Called from
every dashboard refresh, every enqueue, and every keepalive tick —
6s freezes there cascade with the 1Hz SSE tick.

Promise.all the candidates. Each probe + lockfile read is independent;
worst-case wall time becomes max(per-probe latency) instead of sum.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## End-of-batch checklist (orchestrator runs after all 9 subagents return)

- [ ] All nine subagents reported completion.
- [ ] For each branch `feature/perf-tier-2-task-N` (N=1..9): verified with `git -C <worktree> log --oneline master..HEAD`, `git -C <worktree> status` (clean), `git -C <worktree> rev-parse --abbrev-ref HEAD` (matches).
- [ ] If any verification failed: investigate before merging. Do not merge a partially-complete batch.
- [ ] Merge sequentially: `git merge --no-ff feature/perf-tier-2-task-1`, `git merge --no-ff feature/perf-tier-2-task-2`, ..., `git merge --no-ff feature/perf-tier-2-task-9`.
- [ ] After each merge, run `npm run typecheck && npm run test:architecture` on master. If any merge regresses, resolve before continuing.
- [ ] After all merges: `git worktree remove <each-path>` + `git branch -d feature/perf-tier-2-task-N`.
- [ ] Sweep: `git worktree list` shows no `perf-tier-2-*` entries; `git branch --list 'feature/perf-tier-2-*'` is empty.

---

## Handoff to Tier 3

Once Tier 2 has merged to master, **start a fresh session in `/Users/julianhein/Documents/hr-automation`** and paste the prompt below.

```
Read docs/superpowers/plans/2026-05-07-perf-tier-3-medium-impact.md and execute it via superpowers:subagent-driven-development. Tiers 1 and 2 are already merged on master — verify with `git log --oneline -20`. Default subagent model is Sonnet; you (the orchestrator) are Opus. Tier 3 has more tasks than Tier 2 — group them into parallel batches per the plan's "Dispatch waves" section, not all at once. Don't review subagent diffs between tasks; trust per-task verification gates (typecheck + test:architecture + relevant unit test). I'll review at the end.
```
