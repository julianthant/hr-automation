# Code Review Fixes — Core + Tracker + Infra Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user is running this inline). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land every correctness, performance, and simplification finding the 2026-05-14 codebase review surfaced for `src/core/`, `src/tracker/`, `src/infra/`, `src/utils/`, `src/scripts/`, and `src/cli.ts`. Exclude the `src/config.ts:48-50` `ANNUAL_DATES` bump (intentional).

**Architecture:** Sequential per-task work on master (no worktrees — these touch shared kernel/tracker code that downstream plans depend on). Each task is one commit. Order minimizes conflicts: correctness fixes first (small surgical edits), then performance hot paths (also surgical), then dead-code deletion, then shared-helper extractions (largest blast radius last).

**Tech Stack:** TypeScript, Node 26 (node:sqlite, node:timers/promises, Promise.withResolvers), tsx, Playwright, Hono, SQLite, JSONL.

**Verification per task (run after each commit unless noted):**
```bash
npm run typecheck && npm run test && npm run test:architecture
```

The test runner requires directory paths, not individual file paths (LESSONS.md). If a task adds a new helper, run the relevant `tests/unit/<dir>` directory.

---

## Phase A — Correctness (high priority bugs)

### Task A1: Daemon HTTP listen error handler

**File:** `src/core/daemon/http.ts:275-285`

- [ ] **Step 1:** Open the file and locate `server.listen(0, ...)`. Wrap the listen call in a `Promise` that handles both success and `'error'` events:

```ts
const listenPromise = new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, () => {
    server.off("error", reject);
    resolve();
  });
});
```

Currently the success callback resolves but a port-bind error never rejects, causing `await listenPromise` in `daemon.ts:208` to hang forever.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(core): reject daemon HTTP listen on port-bind error`.

### Task A2: retryTaskFromAttempt carries forward parent_run_id

**File:** `src/core/task-store/retry.ts:48-62`

- [ ] **Step 1:** Read the file. The current `UPDATE tasks` statement does not touch `parent_run_id`. Confirm the column exists in the schema; if so, explicitly set it from the originating task's `parent_run_id` in the same UPDATE (or re-read it before the UPDATE and pass it through `RETURNING`). Ensure `EnqueuedTask` returned includes `parentRunId` so callers in the daemon's `/api/retry` path can re-stamp it.

```ts
// Before
UPDATE tasks
SET run_id = @runId,
    control_state = 'queued',
    ...
WHERE id = @taskId
RETURNING ...;

// After — add parent_run_id explicitly so retried delegation children keep their parent link
UPDATE tasks
SET run_id = @runId,
    control_state = 'queued',
    parent_run_id = parent_run_id,  -- explicit no-op preserves invariant; document with comment
    ...
WHERE id = @taskId
RETURNING ..., parent_run_id;
```

If `parent_run_id` is dropped by the existing UPDATE due to an unset column, fix by inspecting the actual schema in `src/core/control-schema.ts` and ensure the carry is real.

- [ ] **Step 2:** Add a unit test in `tests/unit/core/task-store/retry.test.ts` (or extend the existing one) asserting a retried task preserves `parentRunId`.
- [ ] **Step 3:** Run `npm run test -- tests/unit/core/task-store`.
- [ ] **Step 4:** Commit: `fix(core): preserve parent_run_id when retrying delegated tasks`.

### Task A3: Kernel double-terminal write guard

**File:** `src/core/kernel/workflow.ts:487-493`

- [ ] **Step 1:** Track whether `markInProcessControlTerminal(control, false, err)` has already fired in the `catch` block. Suppress the `finally`-block call when failure has already been written:

```ts
let terminalWritten = false;
try {
  // ... handler + session work ...
  completed = true;
} catch (err) {
  markInProcessControlTerminal(control, false, err);
  terminalWritten = true;
  throw err;
} finally {
  if (completed && !terminalWritten) {
    markInProcessControlTerminal(control, true);
  }
}
```

This eliminates the case where `session.close()` throws after `completed = true` — currently both branches fire and write contradictory rows.

- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/core/kernel`.
- [ ] **Step 3:** Commit: `fix(core): avoid double terminal write when session.close throws`.

### Task A4: Daemon runId fallback safety

**File:** `src/core/daemon/daemon.ts:599`

- [ ] **Step 1:** Replace `const runId = item.runId ?? randomUUID()` with an explicit assertion that the queue contract guarantees `runId`. Throwing here surfaces the bug immediately (matches the "fail loud" feedback memory):

```ts
if (!item.runId) {
  throw new Error(`Queue invariant violated: task ${item.id} missing runId at claim time`);
}
const runId = item.runId;
```

- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `fix(core): assert daemon claim invariant instead of silently inventing runId`.

### Task A5: Tracker SIGINT date-local fix

**File:** `src/tracker/jsonl.ts:492-505`

- [ ] **Step 1:** Replace `now.slice(0, 10)` (UTC) with `dateLocal(new Date(now))` at every line in the SIGINT/SIGTERM handler. This matches the 2026-04-27 lesson and ensures the terminal `failed` row lands in the local-date-named JSONL file the dashboard reads.

```ts
// Before
const date = now.slice(0, 10);

// After
import { dateLocal } from "./date-local.js"; // already imported at top of file
const date = dateLocal(new Date(now));
```

- [ ] **Step 2:** Add a unit test in `tests/unit/tracker` covering a fake date crossing local midnight while UTC stays the same day.
- [ ] **Step 3:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 4:** Commit: `fix(tracker): SIGINT terminal row writes to local-date file`.

### Task A6: dashboard/sweeps.ts SQLite leak

**File:** `src/tracker/dashboard/sweeps.ts:126-127`

- [ ] **Step 1:** Wrap `openControlDb` in try/finally and close in `finally`, matching `src/tracker/dashboard/ops/shared.ts`:

```ts
const controlDb = openControlDb({ trackerDir: dir });
try {
  const taskStore = createTaskStore(controlDb);
  for (const item of stale) {
    // ... existing body ...
  }
} finally {
  controlDb.close();
}
```

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(tracker): close controlDb in sweep to avoid fd leak`.

### Task A7: jsonl.ts runId race for concurrent retries

**File:** `src/tracker/jsonl.ts:407-411`

- [ ] **Step 1:** Replace the read-then-count scheme with `randomUUID()` for auto-generated runIds (matching the batch path):

```ts
// Before
const existing = readEntries(workflow, dir);
const priorRuns = new Set(existing.filter((e) => e.id === id).map((e) => e.runId));
runId = `${id}#${priorRuns.size + 1}`;

// After
import { randomUUID } from "node:crypto";
runId = `${id}#${randomUUID().slice(0, 8)}`;
```

Note: this changes the user-visible runId format from `id#N` to `id#<8 hex chars>`. Dashboards already handle both formats (per CLAUDE.md lesson 2026-04-21). If you want to keep `#N` and serialize on SQLite, you may instead query `SELECT MAX(...) FROM runs WHERE item_id=? AND workflow=?` inside a transaction. **Pick the UUID path** — it is race-free without locking.

- [ ] **Step 2:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `fix(tracker): race-free runId allocation for concurrent retries`.

### Task A8: Tracker base.ts projectionReady guard

**File:** `src/tracker/dashboard/hono/routes/base.ts:102`

- [ ] **Step 1:** Replace `(deps.projectionReady ?? true) && deps.stateDb && date` with `deps.projectionReady && deps.stateDb && date`. Match every other call site in the codebase that has no `?? true`.
- [ ] **Step 2:** Grep for other `?? true` defaults in `src/tracker/dashboard/hono/`: `rg "projectionReady \?\? true" src/tracker`. If any remain, fix them.
- [ ] **Step 3:** Run `npm run typecheck`.
- [ ] **Step 4:** Commit: `fix(tracker): require explicit projectionReady before SQLite reads`.

### Task A9: Tracker projection routes stateDb null guard

**File:** `src/tracker/dashboard/hono/routes/projection.ts:9-10` (and any other v2 route handler)

- [ ] **Step 1:** Add a top-of-handler guard to every v2 route that calls `.prepare()` on `deps.stateDb`:

```ts
app.get("/api/v2/projection/health", () => {
  if (!deps.stateDb) {
    return jsonResponse({ ok: false, error: "projection not ready" }, 503);
  }
  return jsonResponse(queryProjectionHealth(deps.stateDb, deps.dir));
});
```

Repeat for `/api/v2/entries` and `/api/v2/runs`.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(tracker): guard v2 projection routes against unready stateDb`.

### Task A10: cancel.ts atomic write

**File:** `src/tracker/dashboard/ops/cancel.ts:234-236`

- [ ] **Step 1:** Replace the two-step `writeFileSync(..., { flag: "w" })` + `writeFileSync(..., { flag: "a" })` with a single write of the full new contents:

```ts
const finalText =
  (text.endsWith("\n") || text === "" ? text : text + "\n") +
  JSON.stringify(cancelEvent) + "\n";
writeFileSync(path, finalText, { flag: "w" });
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `fix(tracker): write cancel event atomically to avoid truncation on crash`.

### Task A11: ocr.ts reupload sessionId guard

**File:** `src/tracker/dashboard/hono/routes/ocr.ts:104-113`

- [ ] **Step 1:** Add a 400 short-circuit before `writeFileSync` when reupload mode lacks a sessionId:

```ts
const isReupload = fields.isReupload === "true";
const sessionId = fields.sessionId?.trim() || undefined;
if (isReupload && !sessionId) {
  return jsonResponse({ ok: false, error: "sessionId required for reupload" }, 400);
}
// ... rest of handler ...
```

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(tracker): reject OCR reupload without sessionId before writing file`.

### Task A12: utils/screenshot.ts default dir + never-throws

**File:** `src/utils/screenshot.ts:1-30`

- [ ] **Step 1:** Replace `DEFAULT_DIR = ".auth"` with `DEFAULT_DIR = PATHS.screenshotDir` (import `PATHS` from `src/config.js`).
- [ ] **Step 2:** Wrap the body of `debugScreenshot` in try/catch matching the documented "never throws" contract:

```ts
import { PATHS } from "../config.js";

export async function debugScreenshot(
  page: Page,
  label: string,
  opts: { fullPage?: boolean; dir?: string } = {},
): Promise<void> {
  try {
    const dir = opts.dir ?? PATHS.screenshotDir;
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const path = `${dir}/${label}-${ts}.png`;
    await page.screenshot({ path, fullPage: opts.fullPage ?? false });
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `fix(utils): debug screenshots write to PATHS.screenshotDir and never throw`.

### Task A13: scripts/ops/setup.ts Node 26 floor

**File:** `src/scripts/ops/setup.ts:99`

- [ ] **Step 1:** Change the floor check from `< 20` to `< 26`, and update the failure message: `"Node.js 26 or later is required (project uses node:sqlite + Node 26 features)."`.
- [ ] **Step 2:** Run `tsx --env-file=.env src/scripts/ops/setup.ts --check-only` (or whatever the script's smoke command is — read the script to find it).
- [ ] **Step 3:** Commit: `fix(scripts): bump setup.ts Node floor to 26`.

### Task A14: scripts/codegen/export-schemas.ts add missing workflows

**File:** `src/scripts/codegen/export-schemas.ts:67`

- [ ] **Step 1:** Add four entries to `SCHEMA_REGISTRY`: `oath-signature` (`src/workflows/oath-signature/schema.ts`, exporting `OathSignatureInputSchema`), `oath-upload` (`src/workflows/oath-upload/schema.ts`), `active-check` (`src/workflows/active-check/schema.ts`), `crm-doc-download` (`src/workflows/crm-doc-download/schema.ts`). Inspect each schema file to find the actual exported schema name.
- [ ] **Step 2:** Run `npm run schemas:export` and verify each new workflow produces a JSON Schema file.
- [ ] **Step 3:** Tighten the `isMain` guard to also accept the `.js` suffix variant used by other scripts.
- [ ] **Step 4:** Commit: `fix(scripts): include all kernel workflows in schemas:export`.

### Task A15: CLAUDE.md / AGENTS.md clean:tracker default

**Files:** `CLAUDE.md:73`, `AGENTS.md:52`

- [ ] **Step 1:** Change both lines from `Prune .tracker/*.jsonl older than 7 days` → `Prune .tracker/*.jsonl older than 30 days (default)`.
- [ ] **Step 2:** Commit: `docs: clean:tracker default is 30 days, not 7`.

---

## Phase B — Performance hot paths

### Task B1: entries-payload.ts legacy screenshot scan

**File:** `src/tracker/dashboard/hono/routes/entries-payload.ts:171`

- [ ] **Step 1:** Read the function. Identify the per-failed-entry `readdirSync(SCREENSHOTS_DIR)` + per-file `statSync` block memoized on `${workflow}::${id}`.
- [ ] **Step 2:** Route through the SQLite `queryScreenshotsForItem` path used by `queryEntriesPayload`. When `deps.projectionReady && deps.stateDb`, skip the readdir entirely and use `runs.screenshot_count` directly. When projection is not ready, keep the fallback but at minimum index by item_id rather than re-scanning the whole directory.

```ts
if (deps.projectionReady && deps.stateDb) {
  // Use SQLite — runs already carries screenshot_count
  return queryEntriesPayload(deps.stateDb, ...);
}
// Fallback for cold-start window only
```

- [ ] **Step 3:** Run dashboard locally, monitor `top` for the SSE process. Confirm CPU drops when many failed items exist.
- [ ] **Step 4:** Run `npm run typecheck`.
- [ ] **Step 5:** Commit: `perf(tracker): use SQLite screenshot_count instead of readdirSync per failed entry`.

### Task B2: daemon claim-loop queue-depth query

**File:** `src/core/daemon/daemon.ts:581`

- [ ] **Step 1:** Replace the `readQueueState()` full-scan with a count-only query:

```sql
SELECT COUNT(*) AS depth FROM tasks
WHERE workflow = @workflow
  AND task_kind = 'workflow_item'
  AND source = 'daemon'
  AND control_state = 'queued';
```

Expose as `taskStore.countQueued(workflow)`. Use the result to populate `queueDepthCache`.

- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/core`.
- [ ] **Step 3:** Commit: `perf(core): replace per-claim full queue-state scan with COUNT query`.

### Task B3: daemon recoverOrphanedClaims audit path

**File:** `src/core/daemon/queue.ts:251-263`

- [ ] **Step 1:** Modify `recoverClaimsForDeadWorkers` to return the recovered items so `recoverOrphanedClaims` no longer needs to call `readQueueState()` purely for the audit emit. Wire the returned items into the JSONL audit append.

- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `perf(core): orphan-recovery audit reuses recovered items instead of full state scan`.

### Task B4: Kernel captureFullPage scoping

**File:** `src/core/kernel/session.ts:507`

- [ ] **Step 1:** Replace `document.querySelectorAll('*')` + `getComputedStyle` per-element scan with a scoped selector list. Read the function and identify what the scan is checking for (likely `overflow: scroll` containers). Scope to `'[style*=overflow], .modal, iframe, [class*=scroll], [class*=Scroll]'`.
- [ ] **Step 2:** Replace `await page.waitForTimeout(800)` with `await page.waitForFunction(() => document.readyState === 'complete')` or a more targeted signal. If a timeout is genuinely needed, use `await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {})`.
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `perf(core): scope captureFullPage element scan and drop hardcoded 800ms wait`.

### Task B5: daemon dual-timer collapse

**File:** `src/core/daemon/daemon.ts:464, 294`

- [ ] **Step 1:** Inspect both `commandPollInterval` and `heartbeatInterval`. Both default to 5000ms. Collapse into a single `setInterval(tick, 5000)` where `tick()` does both heartbeat write + command poll back-to-back. Ensure both bodies remain in their original error-handling envelopes.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `perf(core): merge daemon heartbeat and command-poll into single timer`.

### Task B6: tracker apply.ts recomputeRunOrdinals gate

**File:** `src/tracker/state/apply.ts:256, 146-162`

- [ ] **Step 1:** In `applyTrackerEntryLive`, capture `db.changes()` after the `upsertRun` call. Only invoke `recomputeRunOrdinalsForItem` when a NEW run row was inserted (changes() > 0 from INSERT path), not on every status update for an existing run.
- [ ] **Step 2:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `perf(tracker): only recompute run ordinals when a new run row is inserted`.

### Task B7: tracker apply.ts countScreenshots delta

**File:** `src/tracker/state/apply.ts:362-363`

- [ ] **Step 1:** Replace the per-screenshot-event `COUNT(*) + UPDATE` with `UPDATE runs SET screenshot_count = screenshot_count + ?` using the delta from the loop above.
- [ ] **Step 2:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `perf(tracker): increment screenshot_count instead of recounting per event`.

### Task B8: tracker queries.ts emplId map cache

**File:** `src/tracker/state/queries.ts:26-49`

- [ ] **Step 1:** Wrap `resolvedEmplIdMapFromRunEvents` in the same `ttlMemoize`-style cache used by `getCrossWorkflowCounts` (1s TTL). Key by `tracker_date`. The 2026-05-07 lesson establishes the precedent.
- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `perf(tracker): cache resolvedEmplIdMap per SSE tick`.

### Task B9: selector-warnings.ts via SQLite

**File:** `src/tracker/dashboard/selector-warnings.ts:68-89`

- [ ] **Step 1:** Replace the multi-file `readFileSync` + JSON.parse loop with:

```sql
SELECT ... FROM logs
WHERE level IN ('warn','error')
  AND tracker_date >= @cutoff
  AND message LIKE '%selector fallback triggered%';
```

Use `deps.stateDb` when `deps.projectionReady`. Keep the JSONL fallback path for the cold-start window.

- [ ] **Step 2:** Run `curl http://localhost:3838/api/selector-warnings | head` against a live dashboard and verify the response shape unchanged.
- [ ] **Step 3:** Commit: `perf(tracker): selector-warnings reads from SQLite logs table`.

### Task B10: topics-emitters.ts zero-row gate

**File:** `src/tracker/dashboard/hono/topics-emitters.ts:303-306`

- [ ] **Step 1:** Replace `usedSqlite = sqliteEvents.length > 0` with a guard based on projection-readiness:

```ts
const usedSqlite = deps.projectionReady && deps.stateDb !== undefined;
const allEvents = usedSqlite ? sqliteEvents : await readJsonlEvents(...);
```

This stops the expensive JSONL fallback from firing every tick for runs that simply have zero events.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `perf(tracker): distinguish empty SQLite result from projection-not-ready`.

### Task B11: tracker emitStepChange JSONL fallback short-circuit

**File:** `src/tracker/session-events.ts:281-294`

- [ ] **Step 1:** Thread the `workflow` name into `emitStepChange` from `withTrackedWorkflow` so the JSONL fallback can read only the matching `<workflow>-logs.jsonl` instead of `readdirSync` + per-file probe.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `perf(tracker): emitStepChange JSONL fallback reads only matching workflow file`.

### Task B12: state/runtime.ts isStateDbReady cache

**File:** `src/tracker/state/runtime.ts:8-10`

- [ ] **Step 1:** Cache the "ready" flag in module scope after first success. The current code opens a fresh readonly DB handle on every write to probe `schema_version`.

```ts
let readyCache: { dir: string; ready: boolean } | null = null;
export function isStateDbReady(dir: string): boolean {
  if (readyCache?.dir === dir && readyCache.ready) return true;
  // ... existing check ...
  if (ready) readyCache = { dir, ready };
  return ready;
}
```

- [ ] **Step 2:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `perf(tracker): cache stateDb readiness after first probe`.

---

## Phase C — Quick wins (dead code & one-liners)

### Task C1: Delete src/utils/pii.ts (dead module)

**Files:** `src/utils/pii.ts`, `src/tracker/jsonl.ts` (call sites)

- [ ] **Step 1:** `rg "from \"../../utils/pii" src` to find all import sites. There are 2 call sites in `src/tracker/jsonl.ts`. Inline each one as `String(value ?? "")`.
- [ ] **Step 2:** Delete `src/utils/pii.ts`.
- [ ] **Step 3:** `rg "redactPii|maskPii" src` to confirm zero remaining references.
- [ ] **Step 4:** Run `npm run typecheck && npm run test`.
- [ ] **Step 5:** Commit: `chore(utils): inline trivial pii.ts pass-throughs and delete module`.

### Task C2: CLI dynamic stdlib imports → static

**File:** `src/cli.ts:406-408`

- [ ] **Step 1:** Find the `await import("node:fs" | "node:path" | "node:crypto")` chain in the hot action. Move to top-of-file static imports.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(cli): static-import stdlib modules at top of file`.

### Task C3: CLI dashboard registry static imports

**File:** `src/cli.ts:516-533`

- [ ] **Step 1:** The `dashboard` command does `await Promise.all([...11 dynamic imports...])` for side-effect registry population. Move all 11 imports to top-of-file (or a dedicated `src/workflows/registry-load.ts` barrel that the dashboard command imports).
- [ ] **Step 2:** Run `npm run dashboard` briefly to confirm workflows still appear in the registry.
- [ ] **Step 3:** Commit: `refactor(cli): static-import dashboard workflow registry`.

### Task C4: Tracker E2E-TEMP cleanup

**Files:** `src/tracker/jsonl.ts:60-67,199-235`, `src/tracker/dashboard/hono/topics-emitters.ts:198,216-217,223-224,233-234,276,322,330,341`, `src/tracker/dashboard/ops/cancel.ts:140,251,361`

- [ ] **Step 1:** Audit all `log.e2e(...)` and `// E2E-TEMP` calls listed above. If the E2E verification work is complete, delete them outright. If not, gate them behind a single `if (E2E_DEBUG_ENABLED)` check rather than emitting unconditionally on every JSONL write.
- [ ] **Step 2:** Run `rg "log\.e2e|E2E-TEMP" src/tracker` and confirm only intentional remaining sites.
- [ ] **Step 3:** Run `npm run test`.
- [ ] **Step 4:** Commit: `chore(tracker): remove or gate E2E-TEMP debug emissions from hot paths`.

### Task C5: Drop no-op close on openControlStores

**File:** `src/tracker/dashboard/ops/shared.ts:19-33`

- [ ] **Step 1:** Remove the `close: () => {}` no-op field from `openControlStores`. Update every caller's `try { ... } finally { stores.close(); }` to remove the empty finally call.
- [ ] **Step 2:** `rg "stores\.close" src/tracker` to confirm zero remaining call sites.
- [ ] **Step 3:** Run `npm run typecheck`.
- [ ] **Step 4:** Commit: `refactor(tracker): drop no-op close on openControlStores`.

### Task C6: Tracker date-utils renames

**File:** `src/tracker/jsonl.ts:49,193`

- [ ] **Step 1:** Rename `getLogPath` → `getTrackerJsonlPath` and `getLogFilePath` → `getLogsJsonlPath`. Update every caller (`rg "getLogPath\|getLogFilePath" src`).
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(tracker): rename JSONL path helpers for clarity`.

### Task C7: scripts isMainModule consolidation

**Files:** `src/scripts/codegen/export-schemas.ts:107`, `src/scripts/ops/clean-tracker.ts:264-266`, `src/scripts/ops/setup.ts:637-640`

- [ ] **Step 1:** Create `src/scripts/_main.ts` exporting `isMainModule(metaUrl: string): boolean` with the canonical implementation (URL match + filename-endswith fallback handling both `.ts` and `.js`).
- [ ] **Step 2:** Replace the three call sites with `import { isMainModule } from "../_main.js"; if (isMainModule(import.meta.url)) { ... }`.
- [ ] **Step 3:** Run each script briefly to confirm the gate still fires.
- [ ] **Step 4:** Commit: `refactor(scripts): consolidate isMainModule check into shared helper`.

### Task C8: clean-tracker.ts use node:util parseArgs

**File:** `src/scripts/ops/clean-tracker.ts:126-184`

- [ ] **Step 1:** Replace the hand-rolled `parseArgs(argv)` with `import { parseArgs } from "node:util"`. Define the options struct (`days`, `dir`, `dry-run`, etc.). The native parser gives `--help` for free.
- [ ] **Step 2:** Run `npm run clean:tracker -- --days 30 --dir .tracker --dry-run` to confirm behavior unchanged.
- [ ] **Step 3:** Commit: `refactor(scripts): use node:util parseArgs in clean-tracker`.

### Task C9: scripts/ops timers → node:timers/promises

**Files:** `src/scripts/ops/setup.ts:378,401`, `src/core/kernel/ctx.ts:26-42`, any other `new Promise(r => setTimeout(r, ms))` in this plan's scope

- [ ] **Step 1:** `rg "new Promise.*setTimeout" src/{core,tracker,infra,utils,scripts,cli.ts}` to find all hand-rolled abortable sleeps.
- [ ] **Step 2:** Replace each with `import { setTimeout as sleep } from "node:timers/promises"; await sleep(ms);` (or `await sleep(ms, undefined, { signal })` where an AbortSignal is available).
- [ ] **Step 3:** Run `npm run typecheck`.
- [ ] **Step 4:** Commit: `refactor: use node:timers/promises for abortable sleeps`.

### Task C10: Drop signal.throwIfAborted polyfill

**File:** `src/infra/auth/duo-poll.ts:102-110`

- [ ] **Step 1:** Replace `duoAbortReason` and `throwIfDuoAborted` helpers with `signal?.throwIfAborted()` at every call site. The signal-native primitive has been standard since Node 18.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `refactor(infra): drop custom throwIfDuoAborted in favor of native signal.throwIfAborted`.

### Task C11: cli.ts platform-gate wmic

**File:** `src/tracker/jsonl.ts:482`

- [ ] **Step 1:** Wrap the `execSync('wmic process ...')` call in `if (process.platform === "win32")`. The call fires on every SIGINT regardless of platform; on macOS it just fails silently per `execSync`.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `fix(tracker): gate wmic process-cleanup to Windows only`.

### Task C12: Static imports for old-kronos config + fs

**Files:** `src/systems/old-kronos/navigate.ts:509` (NOTE: in systems area but blocks no plan-2 work; do it here to keep config-touching commits together), `src/systems/old-kronos/reports.ts:310-311`

> **Defer this task to Plan 2.** It touches `src/systems/`. Skip in Plan 1.

### Task C13: Tracker convention-violation comments

**File:** `src/tracker/dashboard/hono/topics-emitters.ts:25-32`

- [ ] **Step 1:** Add `log.debug(...)` to the `try { return readSessionEvents(dir); } catch { return []; }` block so silent corruption doesn't hide forever.
- [ ] **Step 2:** Commit: `refactor(tracker): log silent JSONL parse failures at debug level`.

### Task C14: jsonl.ts emit defensive copies

**File:** `src/tracker/jsonl.ts:415-438`

- [ ] **Step 1:** In `emit(...)`, stop spreading `data` and `typedData` snapshots on every status emit. The JSON serialization already isolates downstream consumers. Pass references directly:

```ts
// Before
const row = { ...data, ...typedData };

// After
const row = data === typedData ? data : Object.assign({}, data, typedData);
// (still single-pass merge but no needless spread when typedData absent)
```

- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `perf(tracker): drop unnecessary defensive copies in emit`.

### Task C15: jsonl.ts sort comparators

**File:** `src/tracker/jsonl.ts:830-833` and `src/tracker/dashboard/ops/retry.ts:81,96,333`

- [ ] **Step 1:** Replace ISO-timestamp `localeCompare` with `<` comparator. Extract `byTimestampAsc(a, b)` once in `src/tracker/jsonl.ts` (or a new `src/tracker/_sort.ts`) and use everywhere.

```ts
export function byTimestampAsc<T extends { timestamp: string }>(a: T, b: T): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
}
```

- [ ] **Step 2:** `rg "localeCompare|timestamp < b" src/tracker` — replace remaining ad-hoc comparators with the shared helper.
- [ ] **Step 3:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 4:** Commit: `refactor(tracker): shared byTimestampAsc comparator`.

### Task C16: jsonl.ts getRunIdOr

**File:** `src/tracker/jsonl.ts:799,808` and call sites

- [ ] **Step 1:** Extract `getRunIdOr(e): string` returning `e.runId || \`${e.id}#1\``. Replace all 7+ inline copies. `rg 'runId \|\| \`\$\{' src/tracker`.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(tracker): shared getRunIdOr helper`.

### Task C17: jsonl.ts parseTrackerFilename

**File:** `src/tracker/jsonl.ts:601-606,609-621`

- [ ] **Step 1:** Extract `parseTrackerFilename(name: string): { workflow: string; date: string } | null` consumed by both `listWorkflows` and `listDatesForWorkflow`. Encode the `<wf>-YYYY-MM-DD.jsonl` format in exactly one place; reject `-logs.jsonl` once.
- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/tracker`.
- [ ] **Step 3:** Commit: `refactor(tracker): shared parseTrackerFilename helper`.

### Task C18: tracker rewriteJsonlFile

**File:** `src/tracker/dashboard/ops/delete.ts:48-52` + sibling `src/tracker/dashboard/ops/ocr-prepare-abort.ts` (verify via `rg "readFileSync.*split.*\\\\n" src/tracker`)

- [ ] **Step 1:** Promote `rewriteJsonlFile(path: string, keepPredicate: (line: object) => boolean)` into `src/tracker/jsonl-rewrite.ts`. Repoint both call sites.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `refactor(tracker): shared rewriteJsonlFile helper`.

### Task C19: log.ts envBool + appendFromContext

**File:** `src/utils/log.ts:15-18,46-80,99-101`

- [ ] **Step 1:** Extract `envBool(name: string): boolean` at module scope. Replace the duplicated `DEBUG_ENABLED`/`E2E_DEBUG_ENABLED` parse with single calls. If E2E debug verification is complete per Task C4, also delete the E2E channel here.
- [ ] **Step 2:** Extract `appendFromContext(level, msg, extra?)` so `emit` and `emitDebug` stop duplicating the ALS-context block (lines 46-60, 67-80).
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Commit: `refactor(utils): dedupe log.ts env-flag parsing and emit blocks`.

---

## Phase D — Shared helper extractions

### Task D1: CLI requireEnv + parsePositiveInt

**File:** `src/cli.ts:107-504`

- [ ] **Step 1:** Create `src/cli-helpers.ts` exporting:

```ts
import { validateEnv } from "./utils/env.js";

export function requireEnv(): void {
  try {
    validateEnv();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export function parsePositiveInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer (got "${value}")`);
  }
  return n;
}
```

- [ ] **Step 2:** Replace the 10 `try { validateEnv() } catch { process.exit(1) }` blocks with `requireEnv()`. Replace the 8 `--parallel must be a positive integer` validations with `parsePositiveInt(value, "--parallel")` either inline in actions or via Commander's `.option("-p, --parallel <N>", desc, (v) => parsePositiveInt(v, "--parallel"))`.
- [ ] **Step 3:** Run `npm run typecheck && tsx --env-file=.env src/cli.ts --help`.
- [ ] **Step 4:** Commit: `refactor(cli): extract requireEnv + parsePositiveInt helpers`.

### Task D2: CLI runLogin + 2-attempt loop

**File:** `src/cli.ts:35-91`

- [ ] **Step 1:** Replace the duplicated launch/login/close + hand-rolled retry-once wrapper with:

```ts
async function runLogin(label: string, fn: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ok = await fn();
      if (ok) return true;
    } catch (err) {
      log.warn(`${label} login attempt ${attempt} failed`, { error: String(err) });
    }
  }
  return false;
}
```

Use this for both `runAuthFlow` and `test-login`.

- [ ] **Step 2:** Run `npm run test-login` against your local env (or skip if no env).
- [ ] **Step 3:** Commit: `refactor(cli): unify login retry wrapper`.

### Task D3: infra/auth defineSsoLogin builder

**File:** `src/infra/auth/login.ts:1-657`

- [ ] **Step 1:** Read all 5 `loginToX` functions. Identify the shared pattern: navigateAndFill + submitAndWaitForDuo + stale-form check + already-logged-in short-circuit + post-Duo SAML retry. Design a builder:

```ts
type SsoLoginConfig = {
  id: string;
  url: string;
  alreadyLoggedInUrlSubstring?: string | RegExp;
  fillFn?: (page: Page) => Promise<void>;
  recovery?: (page: Page, err: unknown) => Promise<boolean>;
  successUrlMatch: (url: string) => boolean;
  successCheck?: (page: Page) => Promise<boolean>;
  duoTimeoutMs?: number;
  preCheckMs?: number;  // 0 for ACT CRM
};

export function defineSsoLogin(cfg: SsoLoginConfig): (page: Page) => Promise<boolean> {
  return async (page) => {
    // shared scaffold
  };
}
```

Convert each `loginToUCPath`, `loginToACTCrm`, `loginToUKG`, `loginToKuali`, `loginToNewKronos` (and ServiceNow if it exists in this file) to a config call.

- [ ] **Step 2:** Run `npm run typecheck && npm run test-login` if local env available.
- [ ] **Step 3:** Commit: `refactor(infra): SSO login builder collapses 5 near-identical flows`.

### Task D4: duo-poll waitForDuoPoll → node:timers/promises

**File:** `src/infra/auth/duo-poll.ts:112-139`

- [ ] **Step 1:** Replace the manual `addEventListener`/cleanup loop with:

```ts
import { setTimeout as sleep } from "node:timers/promises";

async function waitForDuoPoll(ms: number, signal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal });
}
```

`sleep` rejects with an AbortError naturally on signal abort.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(infra): native abortable sleep in duo-poll`.

### Task D5: duo-poll RETRYABLE_PATTERNS table

**File:** `src/infra/browser/launch.ts:20-56`

- [ ] **Step 1:** Extract `const RETRYABLE_PATTERNS = ["ERR_NETWORK", "ERR_TIMED_OUT", ...]` (read the current OR chain to list them all). Replace the chained `||` with `RETRYABLE_PATTERNS.some(p => msg.includes(p))`.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(infra): table-driven retryable error patterns in gotoWithRetry`.

### Task D6: infra/auth sso-fields inline

**File:** `src/infra/auth/sso-fields.ts:11-29,39-60`

- [ ] **Step 1:** Inline the `.or()` chains directly into the one caller (`fillSsoCredentials`) and delete the `getSsoFieldSelectors` indirection.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(infra): inline single-use sso-fields helper`.

### Task D7: infra/auth retrySelectCampus

**File:** `src/infra/auth/login.ts:42-62,125-139`

- [ ] **Step 1:** Extract `async function retrySelectCampus(page, label, attempts = 3)` covering the "click campus link, on chrome-error retry" loop. Call from both sites.

> **Note:** If Task D3 already absorbs this into the SSO builder, skip this task.

- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(infra): shared retrySelectCampus helper`.

### Task D8: Tracker hono ops postJson envelope

**File:** `src/tracker/dashboard/hono/routes/ops.ts:40-275`

- [ ] **Step 1:** Create `src/tracker/dashboard/hono/post-helper.ts` (or co-locate at the top of ops.ts):

```ts
import type { Context } from "hono";
import { jsonResponse, readJsonRequest } from "../responses.js";

type OpsResult<T> = { ok: true; data: T } | { ok: false; status?: number; error: string };

export async function postJson<T, B>(
  c: Context,
  parse: (body: unknown) => B | { ok: false; error: string },
  handler: (body: B) => Promise<OpsResult<T>> | OpsResult<T>,
  okStatus = 200,
): Promise<Response> {
  const body = await readJsonRequest(c.req.raw);
  if (!body.ok) return jsonResponse({ ok: false, error: body.error }, 400);
  const parsed = parse(body.data);
  if ("ok" in parsed && parsed.ok === false) return jsonResponse(parsed, 400);
  const result = await handler(parsed as B);
  return jsonResponse(result, result.ok ? okStatus : (result.status ?? 400));
}
```

- [ ] **Step 2:** Convert each POST route in `ops.ts` to `postJson(c, parseFn, handlerFn)`. Extract `parseParentRunIdFromBody(body)` and `parseItemsFromBody<T>(raw, parseRow)` helpers used by 3+ routes.
- [ ] **Step 3:** Run `npm run typecheck && npm run test`.
- [ ] **Step 4:** Open the dashboard and exercise retry / delete / stop endpoints. Confirm responses unchanged.
- [ ] **Step 5:** Commit: `refactor(tracker): shared postJson envelope + body parsers in ops routes`.

### Task D9: Tracker buildEntryReEnqueueHandler

**File:** `src/tracker/dashboard/ops/retry.ts:397-413`

- [ ] **Step 1:** Replace `buildRetryHandler` and `buildRunWithDataHandler` (which differ only in one option) with a single `buildEntryReEnqueueHandler(dir, { withData })`. Update call sites in `ops.ts`.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `refactor(tracker): collapse retry + run-with-data handlers into one`.

### Task D10: Tracker makeDeltaTopic + ttlMemoize + resolveWorkflow

**File:** `src/tracker/dashboard/hono/topics-emitters.ts:36-345`

- [ ] **Step 1:** Extract `ttlMemoize<T>(ms: number, fn: () => T): () => T` in a new `src/tracker/dashboard/hono/_memo.ts` and use it for the 1s session-state cache. Apply the same primitive to `getCrossWorkflowCounts` if it's hand-rolling its own cache.
- [ ] **Step 2:** Extract `makeDeltaTopic({ fetcher, intervalMs })` that owns the `let sentCount; let firstTick; tick(); setInterval(tick, ms); interval.unref()` pattern shared by the 4 topic emitters (`telegram`, `logs`, `runEvents`, and the embedded `delta` logic in `entries`).
- [ ] **Step 3:** Extract `resolveWorkflow(params, deps): string` used 3× across topics.
- [ ] **Step 4:** Run dashboard and confirm SSE topics still stream correctly (open browser dev tools network tab).
- [ ] **Step 5:** Commit: `refactor(tracker): shared SSE delta-topic + memoize + workflow-resolve primitives`.

### Task D11: Tracker findLatestEntryForRunOnDate single-pass

**File:** `src/tracker/jsonl.ts:642-652`

- [ ] **Step 1:** JSONL files are append-ordered. Replace the `.reduce((a,b) => a.timestamp >= b.timestamp ? a : b)` with `rows[rows.length - 1]` after `rows` is filtered. Verify append-ordering by reading `appendFileSync` callers — there should be no out-of-order writes.
- [ ] **Step 2:** Add a unit test asserting the new behavior.
- [ ] **Step 3:** Run `npm run test -- tests/unit/tracker`.
- [ ] **Step 4:** Commit: `refactor(tracker): findLatestEntryForRunOnDate relies on append order`.

### Task D12: Tracker readRunsForId single-pass

**File:** `src/tracker/jsonl.ts:784-846`

- [ ] **Step 1:** Read `readRunsForId`. Currently it builds 4 separate Maps in 4 separate passes. Fold into one loop that populates all four with conditional updates.
- [ ] **Step 2:** Run `npm run test -- tests/unit/tracker` and confirm behavior unchanged.
- [ ] **Step 3:** Commit: `perf(tracker): readRunsForId single-pass map population`.

### Task D13: Tracker shared roster constant

**Files:** `src/tracker/dashboard/hono/routes/base.ts:147-160`, `src/tracker/dashboard/ops/retry.ts:57-60`

- [ ] **Step 1:** Promote `ROSTER_DIRS = [".tracker/rosters", "src/data"]` into a shared constant in `src/services/matching/roster-loader.ts` (or `src/config.ts`). Repoint both call sites.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(tracker): shared ROSTER_DIRS constant`.

### Task D14: Kernel tryScreenshot helper

**File:** `src/core/kernel/ctx.ts` (new export) and call sites in `workflow.ts`, `run-one-item.ts`

- [ ] **Step 1:** Add to `ctx.ts`:

```ts
export async function tryScreenshot(ctx: Ctx, label: string): Promise<void> {
  try {
    await ctx.screenshot({ kind: "error", label });
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 2:** Replace the 3+ inline `try { await ctx.screenshot(...) } catch { }` idioms with `await tryScreenshot(ctx, "handler-throw")`.
- [ ] **Step 3:** Run `npm run typecheck && npm run test -- tests/unit/core`.
- [ ] **Step 4:** Commit: `refactor(core): shared tryScreenshot helper`.

### Task D15: Kernel swallowSqliteErr helper

**File:** `src/core/kernel/workflow.ts:282-289, 313-318, 339-345` (or a new `src/core/kernel/sqlite-warn.ts`)

- [ ] **Step 1:** Extract:

```ts
export function swallowSqliteErr(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.warn(`SQLite ${label} skipped`, { error: String(err) });
  }
}
```

- [ ] **Step 2:** Replace the 3 inline try/catch blocks in `registerInProcessControl`, `registerInProcessBrowsers`, `markInProcessControlTerminal`.
- [ ] **Step 3:** Run `npm run typecheck && npm run test -- tests/unit/core`.
- [ ] **Step 4:** Commit: `refactor(core): shared swallowSqliteErr helper`.

### Task D16: Kernel deriveItemId loop

**File:** `src/core/kernel/workflow.ts:230-239`

- [ ] **Step 1:** Replace the 4-level ternary chain with a loop:

```ts
function deriveItemId(seed: Record<string, unknown>): string {
  for (const key of ["emplId", "docId", "email", "sessionId"]) {
    const v = seed[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}
```

- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `refactor(core): deriveItemId loop instead of nested ternaries`.

### Task D17: Kernel stringifyMap inline

**File:** `src/core/kernel/workflow.ts:33-39`

- [ ] **Step 1:** `stringifyMap` is called once in `buildInitialTrackerData`. Inline the body at that call site and delete the helper.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `chore(core): inline single-use stringifyMap`.

### Task D18: Kernel isPlainObject + splitPrefilled

**File:** `src/core/kernel/workflow.ts:49-82`

- [ ] **Step 1:** Extract `isPlainObject(v): v is Record<string, unknown>` and use it in both `splitPrefilled` and `toRecord`.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(core): shared isPlainObject typeguard`.

### Task D19: Kernel stepper.ts throwCancelled + parallel via Object.fromEntries

**File:** `src/core/kernel/stepper.ts`

- [ ] **Step 1:** Extract `private throwCancelled(reason: string): never` consuming the three cancel-block duplicates (lines 55-87).
- [ ] **Step 2:** Replace `parallel` / `parallelAll` `forEach` + mutable cast (lines 133-161) with `Object.fromEntries(entries.map(([k], i) => [k, settled[i]]))`.
- [ ] **Step 3:** Extract `private announce(name, emit)` for the `currentStep = name; log.step(...); emitStep(name)` triple repeated in `step`, `markStep`, `skipStep`.
- [ ] **Step 4:** Run `npm run typecheck && npm run test -- tests/unit/core/kernel`.
- [ ] **Step 5:** Commit: `refactor(core): stepper.ts dedupe cancel/parallel/announce blocks`.

### Task D20: Kernel batch-helpers awaitAllSystemsReady parallel

**File:** `src/core/kernel/batch-helpers.ts:76-87`

- [ ] **Step 1:** Replace the sequential `for...of` await with `Promise.all`. Each `session.page(id)` is independent.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `perf(core): awaitAllSystemsReady runs in parallel`.

### Task D21: Kernel batch-helpers validate error message

**File:** `src/core/kernel/batch-helpers.ts:27-33`

- [ ] **Step 1:** Replace `forEach` + try/catch with a `for` loop indexing, so the error message identifies the offending item: `validation error at item ${i}: ${err.message}`.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(core): batch validation error names the offending item`.

### Task D22: Kernel batch-lifecycle ucpath idle hooks shared

**Files:** `src/core/kernel/batch-lifecycle.ts:96-101`, `src/core/kernel/workflow.ts:193-198`

- [ ] **Step 1:** Extract `buildUcpathIdleHooks(instance, trackerDir)` factory used by both observers. The two sites currently have verbatim duplicates of `onUcpathIdleTouch` / `onUcpathIdleRefresh`.
- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/core`.
- [ ] **Step 3:** Commit: `refactor(core): shared UCPath idle hook factory`.

### Task D23: Kernel daemon DaemonState extract

**File:** `src/core/daemon/daemon.ts:108-145`

- [ ] **Step 1:** Bundle the 10+ top-level `let` variables (`wakeResolve`, `shutdownResolve`, `forceShutdown`, `drainOnlyShutdown`, `shuttingDown`, `inFlight`, `queueDepthCache`, `lastActivity`, `phase`, `activeSession`, `workerStore`, `exitError`, `cancelTarget`, `workflowInstanceForCleanup`) into a `DaemonState` object/class. The 30+ closures passed to `startDaemonHttpServer` can then take `state` as a single argument.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Run a real daemon for 60 seconds locally if possible: `npm run eid-lookup "Smith, John"` then `npm run eid-lookup:stop`.
- [ ] **Step 4:** Commit: `refactor(core): bundle daemon state into DaemonState object`.

### Task D24: Kernel daemon openControlDb reuse

**File:** `src/core/kernel/workflow.ts:241-346`

- [ ] **Step 1:** Open `controlDb` / `taskStore` / `workerStore` ONCE in `registerInProcessControl`, return them as part of `InProcessRunControl`. Reuse in `registerInProcessBrowsers` and `markInProcessControlTerminal`. Saves 3× db opens per run.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `perf(core): reuse controlDb across in-process registration helpers`.

### Task D25: Kernel run-one-item.ts trackerStub branch unify

**File:** `src/core/kernel/run-one-item.ts:97-275`

- [ ] **Step 1:** Build a single `runInner` accepting emitters; the `trackerStub` branch becomes `runInner({ emitStep: noop, emitFailed: noop, ... })` while the real branch passes the actual emitters. Only the outer envelope (`withLogContext` + `withTrackedWorkflow` vs nothing) differs.
- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/core`.
- [ ] **Step 3:** Commit: `refactor(core): unify run-one-item real and stub branches`.

### Task D26: Kernel workflow.ts run-closure dedupe

**File:** `src/core/kernel/workflow.ts:373-494`

- [ ] **Step 1:** Identify the 120-line nested `run` closure inside `runWorkflow`. It mirrors `runOneItem` with minor differences. Have `runWorkflow` delegate to a unified path that takes options for the differences. Likely candidates: pre-emitted pending status, single-vs-batch tracker plumbing.
- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/core/kernel`.
- [ ] **Step 3:** Commit: `refactor(core): unify single-run and batch-run inner loops`.

### Task D27: Kernel boundScreenshot Strategy B refactor

**File:** `src/core/kernel/workflow.ts:148-200`

- [ ] **Step 1:** Either pass a `Promise<ScreenshotFn>` resolved by `onReady`, or construct the observer AFTER session ready. The current mutable `boundScreenshot.fn` back-patch (used at line 528) is the only mutation site; the indirection observer can be eliminated.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `refactor(core): drop boundScreenshot Strategy B mutable holder`.

### Task D28: Kernel makePreHandler dedupe + parallel system resets

**File:** `src/core/kernel/workflow.ts:596-615`

- [ ] **Step 1:** Fold `'reset-browsers'` and `'navigate-home'` cases (which call the same `session.reset(s.id)`) into a single `'reset'` hook. Update the workflow definitions that use these strings.
- [ ] **Step 2:** Replace the sequential `for (const s of wf.config.systems)` reset/health-check loops with `Promise.all` per system.
- [ ] **Step 3:** Run `npm run typecheck && npm run test -- tests/unit/core/kernel`.
- [ ] **Step 4:** Commit: `refactor(core): unify pre-handler reset variants and parallelize system fan-out`.

### Task D29: Kernel ctx.ts node:timers/promises retry

**File:** `src/core/kernel/ctx.ts:26-42`

- [ ] **Step 1:** Replace `new Promise((r) => setTimeout(r, ms))` with `await sleep(ms)` from `node:timers/promises` so the retry helper can later accept an AbortSignal.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(core): ctx.retry uses node:timers/promises sleep`.

### Task D30: Kernel ctx.ts remove unimplemented session window methods

**File:** `src/core/kernel/ctx.ts:74-82`

- [ ] **Step 1:** Remove `ctx.session.newWindow` / `closeWindow` which throw "not yet implemented" with zero callers. If reintroduced later, do so deliberately.
- [ ] **Step 2:** Run `npm run typecheck && npm run test`.
- [ ] **Step 3:** Commit: `chore(core): drop unused ctx.session.newWindow/closeWindow stubs`.

### Task D31: Tracker jsonl.ts readJsonlCached streaming option

**File:** `src/tracker/jsonl.ts:82-107`

- [ ] **Step 1:** Add a streaming alternative for one-shot scans (`cleanOldTrackerFiles`, audit sweeps). The cached array stays the hot-path default. Use `readline.createInterface` over a `fs.createReadStream`, then iterator helpers for filter+map. Leave callers of the cached version alone.

```ts
export async function* readJsonlStream<T>(path: string): AsyncIterable<T> {
  const rl = readline.createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line) as T;
  }
}
```

- [ ] **Step 2:** Convert at least one one-shot scan caller to the streaming form (e.g., `cleanOldTrackerFiles`).
- [ ] **Step 3:** Run `npm run clean:tracker -- --dry-run` to confirm.
- [ ] **Step 4:** Commit: `perf(tracker): streaming JSONL reader for one-shot scans`.

### Task D32: Tracker reset-all-test-caches aggregator

**File:** `src/tracker/jsonl.ts:109-117` and friends

- [ ] **Step 1:** Create a single `__resetAllDashboardCachesForTests()` aggregator that calls each individual reset (`__resetParseCacheForTests`, `__resetSessionStateCacheForTests`, `__resetPreflightThrottleForTests`, `__resetCrossWorkflowCountsCacheForTests`). Keep the individual resets exported for surgical tests; have global setup call only the aggregator.
- [ ] **Step 2:** Update `tests/setup.ts` (or equivalent) to use the aggregator.
- [ ] **Step 3:** Run `npm run test`.
- [ ] **Step 4:** Commit: `refactor(tracker): single aggregator for test cache resets`.

### Task D33: Kernel pool.ts log prefix const

**File:** `src/core/kernel/pool.ts:54-95`

- [ ] **Step 1:** Hoist `const logPrefix = \`[Pool W${index}]\`` once at the top of `worker(index)`, replace inline `[Pool W${index}]` interpolations.
- [ ] **Step 2:** Run `npm run typecheck`.
- [ ] **Step 3:** Commit: `refactor(core): batch pool log prefix into const`.

### Task D34: task-store/index.ts table-driven wrappers

**File:** `src/core/task-store/index.ts:90-139`

- [ ] **Step 1:** Audit the 30 single-line `(request) => fn(db, control, request)` wrappers. Options:
  - (a) Direct re-export `import { enqueueTasks } from './enqueue.js'; export { enqueueTasks };` — callers pass `db`/`control` themselves.
  - (b) Table-driven: `Object.fromEntries(Object.entries(impls).map(([name, fn]) => [name, (req) => fn(db, control, req)]))`.

Pick (a) if you're willing to update callers, (b) if not. Whichever you choose, also pull `getTask` and `getAttempt` (lines 107-114) into helper files for consistency with the bottom of the file.

- [ ] **Step 2:** Run `npm run typecheck && npm run test -- tests/unit/core/task-store`.
- [ ] **Step 3:** Commit: `refactor(core): simplify task-store wrapper layer`.

### Task D35: Verification sweep

- [ ] **Step 1:** Run the full guard suite:

```bash
npm run typecheck:all && npm run test && npm run test:architecture && npm run lint
```

- [ ] **Step 2:** Spawn a daemon and exercise one workflow end-to-end (e.g., `npm run eid-lookup "Smith, John"` → wait → `npm run eid-lookup:stop`). Watch the dashboard at `http://localhost:5173`.
- [ ] **Step 3:** If anything fails, fix root cause; do NOT skip hooks.
- [ ] **Step 4:** Commit any cleanup with a message describing what was caught: `chore: post-plan-1 verification cleanups`.

---

## Out of scope for Plan 1

These items belong to Plan 2 or Plan 3 — do not attempt here:
- `safeClick`/`safeFill` adoption in `src/systems/` (Plan 2)
- Dashboard React fixes including `App.tsx:625 || true`, `useEntries` duplicate setters, `FailureBell` deps loop, `LogStream initialTab`, `useNow`/`useQueueDepth` HMR cleanup, `StepPipeline` dead code (Plan 2)
- Dashboard simplification helpers `IconActionButton`, `usePostAction`, `useSseHistoryStream` (Plan 2)
- Workflow `onPreEmitPending`/`runXxxCli` adapter dedup (Plan 3)
- OCR/matching perf hot paths (Plan 3)
- All doc layout fixes in root CLAUDE.md other than the clean:tracker 7→30 days line (Plan 3)
