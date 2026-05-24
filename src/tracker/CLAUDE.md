# Tracker Module

Two-tier tracking: JSONL for live dashboard streaming, Excel for persistent historical records.

> **Kernel-internal.** `withTrackedWorkflow`, `appendLogEntry`, and the SIGINT handler are invoked by `src/core/runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` / daemon `runOneItem` — workflow handlers never call them directly. Use `ctx.step(...)` / `ctx.updateData(...)` inside the handler.

## Files

→ Full reference: `docs/engineering/tracker-reference.md`

## Tracker row emission — archetype stamping contract

Every persisted tracker row carries `data.archetype` (a `RowArchetype`).
The canonical write path is **`emitTrackerRow`** in `jsonl-io.ts`, which
requires `data: StampedData` (`Record<string, string> & { archetype:
RowArchetype }`) at the type level. New emit sites MUST go through this
helper — the compiler refuses any row that drops `data.archetype`, and
`tests/unit/architecture/tracker-row-emission.test.ts` blocks new direct
uses of the legacy `trackEvent` / `trackEventForDate` aliases.

For workflow-driven rows, compute the archetype via
`stampArchetypeForRow(data, { workflowArchetype, parentRunId })` (uses
`deriveRowArchetype` under the hood). For rows whose archetype is fixed
by the surface that's emitting them (OCR prep parent → `batch-parent`,
OCR approve fan-out child → `delegate-child`), pass `{ override:
"batch-parent" }` instead.

The kernel auto-stamps via `runOneItem`, `cli-adapter`, `pre-emit-helpers`,
and the OCR orchestrator's `writeTracker` closure. Control-layer
replacement rows (cancel, retry pending, OCR discard) inherit archetype
and display metadata from the prior row via `src/control/ops/emit-inherited.ts`;
if you add a new control-layer write site, use that helper so the row
matches the row type it's replacing.

`trackEvent` / `trackEventForDate` remain as `@deprecated` shims for the
tracker module itself + the `tracked-workflow.ts` SIGINT handler (which
must stay synchronous because `process.exit` follows immediately). Don't
introduce new callers — the architecture guard fails the build.

## Observability conventions

Tracker/log/session rows should preserve readable messages and carry structured fields when available. Operator-facing rows should prefer `data.__subject`; raw run ids/session ids are debug identifiers.

Tracker rows may include:
- `data.__subject` / `data.__subjectKind` from `WorkflowConfig.operatorSubject`.
- Task display fields such as `taskRole`, `originWorkflow`, and `taskGroupId`.
- Structured log fields such as `category`, `occasion`, `subject`, `system`, `step`, `attempt`, `childWorkflow`, or `durationMs`.

## `TrackerEntry.parentRunId`

Optional field added 2026-05-01. When set, the entry is a child run delegated by the parent. Used purely for dashboard visualization (parent→child pills in `EntryItem`, "Delegated runs" section in `LogPanel`). Watching logic is itemId-based (`delegation/watch-child-runs.ts`), not parentRunId-based. Thread through `withTrackedWorkflow` via `opts.parentRunId` (also available in `RunOpts`).

## SQLite Task Dependencies And Control State

- `src/tracker/tasks/store.ts` owns durable task/dependency rows for the Phase 2 OCR → EID lookup cutover.
- `src/tracker/tasks/scheduler.ts` is idempotent. It may run repeatedly; terminal dependencies are not re-applied.
- Phase 3 moved live queue/control authority into SQLite via `src/core/task-store/index.ts` and `src/core/daemon/worker-store.ts`: task attempts, claims, worker heartbeats, `worker_commands`, and scoped `browser_processes` are coordination state.
- JSONL remains audit/history output and dashboard visibility during transition. Do not remove `watchChildRuns`; it remains the fallback for legacy rows with no SQLite task/dependency records.
- Queue authority is SQLite. The `.queue.jsonl` file in `.tracker/daemons/` is an append-only audit trail only — readers must not consume it as state.
- New dependency kinds should not be added until a second real workflow needs them.
- **2026-05-20 retry rule:** retrying an OCR dependency child by failed `runId` must reopen the matching `task_dependencies` row (`status='pending'`, clear `terminal_at` / `result_json`) because the child task id is reused with a new attempt/run id. Without that reset, the scheduler will not patch the OCR preview after the retry and the operator could approve stale data.

## Failure-Pattern Alerts

`createDashboardServer` schedules `scanFailurePatterns()` on a **~15s** `setInterval` (see `dashboard/server.ts`) — not tied to SSE polling. Each run walks today's tracker entries across workflows through `detectFailurePattern`. Any pattern that crosses threshold (and isn't in cooldown) fires a macOS desktop notification + `log.warn`. The cooldown map is module-level so it persists for the lifetime of the dashboard process. Tests can call `__resetFailureAlertCooldown()` to clear it. Scan errors are swallowed — a notification glitch must never stall the dashboard process.

## Cleaning Old Tracker Files

→ Full reference: `docs/engineering/tracker-reference.md`

## `withTrackedWorkflow(workflow, id, data, fn)`

→ Full reference: `docs/engineering/tracker-reference.md`

## Dashboard SSE Server

→ Full reference: `docs/engineering/tracker-reference.md`

## JSONL File Format

→ Full reference: `docs/engineering/tracker-reference.md`

## `appendRow(filePath, columns, data)`

→ Full reference: `docs/engineering/tracker-reference.md`

## Gotchas

- **Critical ExcelJS quirk**: After `readFile()`, ExcelJS loses column key mappings. Code re-applies keys in a loop — without this, `addRow(data)` won't map object keys correctly.
- **Excel daily worksheet name** — `exports/spreadsheet.ts` uses `dateLocal()` from `jsonl.ts` for the tab name (`YYYY-MM-DD`), matching tracker JSONL filename dates (local calendar day, not UTC `toISOString()` slice).
- Tracker `.xlsx` files belong inside their workflow folder, never in project root
- Dashboard port 3838 conflict: logs and skips if port in use (another instance running)
- `withTrackedWorkflow` does NOT call `withLogContext` — use both: `withLogContext` wraps `withTrackedWorkflow` to get both log streaming and entry tracking
- **Do NOT use `markStaleRunningEntries`** — was removed because it falsely marked running entries as "failed" with fake "Process interrupted — no heartbeat" messages. Use SIGINT handler in `withTrackedWorkflow` instead for proper cleanup on Ctrl+C.
- **SIGINT writes must be synchronous** — `process.on("SIGINT")` handler cannot await async functions (process exits before they complete). Use `fs.appendFileSync` directly when writing final tracker/log entries.
- **`trackEvent` / `appendLogEntry` are synchronous** — do NOT wrap `appendFileSync` in a mutex. POSIX `write(2)` with `O_APPEND` is atomic at the OS level, and Node is single-threaded within a process. An `async-mutex` wrapper makes the call fire-and-forget (returns a `Promise` but signature is `void`), causing reads-after-write to miss data.
- **Queue/control state has two outputs** — when changing queue/control behavior, update SQLite state and JSONL audit together. SQLite is live truth; JSONL is audit/history. Never add a dashboard control that only mutates process-local state.

## Adding Tracking for a New Workflow

Kernel workflows get tracking for free — `defineWorkflow({ ... })` registers dashboard metadata and `runWorkflow` (or batch/pool/daemon runners) wraps each run in `withLogContext` + `withTrackedWorkflow`. Do NOT call `withTrackedWorkflow`, `trackEvent`, or `setStep` from a handler; use `ctx.step(...)` / `ctx.markStep(...)` / `ctx.updateData(...)` instead.

If you ever add a **non-kernel** one-off workflow, it would need an explicit `register(metadata)` call (from `src/core/kernel/registry.ts`) and a custom outer wrapper — no such workflows ship under `src/workflows/*` today; use `defineWorkflow` for all new work.

## Lessons Learned

- **Lesson maintenance rule:** Before adding tracker lessons, search this section for the same subsystem (`state`, `dashboard/hono`, JSONL readers, queue/action routes, cleanup). Update or merge stale entries instead of appending a second dated version of the same rule.
- **SQLite is live truth; JSONL is audit/history.** Queue/control behavior must update SQLite state (`tasks`, `task_attempts`, `worker_commands`, `browser_processes`, projection tables) and write JSONL audit rows where expected. `.queue.jsonl` is tail/debug output only; readers must not consume it as state.
- **Projection writes must fail loud and recover async.** `trackEvent` writes JSONL first, then applies to SQLite. Apply failures should log at error level, count consecutive failures per `(dir,date)`, and schedule a guarded `rebuildProjectionForDate` after the threshold instead of blocking workflow hot paths. SIGINT paths write synchronously and then call `applySigintTerminalToProjection` when the projection is ready.
- **State DB readiness is file-sensitive.** `isStateDbReady` caches readiness by DB file fingerprint (`inode`, size, `mtimeMs`), not forever. If the DB is deleted, replaced, corrupted, or version-regressed, invalidate and re-probe before applying live projection writes.
- **JSONL readers validate at the boundary.** `readJsonlCached` stores parsed line metadata and accepts validators; tracker/log readers should skip malformed or wrong-shape rows with diagnostics. Recent newest-first scans belong in `findLatestEntryForPredicate`, preserving each caller's public no-match value at the boundary.
- **JSONL and query modules stay split by concern.** `jsonl.ts` and `state/queries.ts` are compatibility barrels. Low-level state code should import focused modules (`jsonl-io.ts`, `tracked-workflow.ts`, `jsonl-cleanup.ts`, `state/queries/*`, `state/queries/statements.ts`) to avoid circular imports and unnecessary barrel evaluation during projection rebuilds.
- **Run ids use the shared fallback helper.** Use `getRunIdOr` for legacy tracker rows (`id`) and log rows (`itemId`); do not hand-roll `runId || `${id}#1`` in dashboard/projection readers.
- **Hono events route is hub-only.** The old `events.ts` shim is gone. Register only the multiplexed `/events/hub` route, keep subscriber-count test helpers in `dashboard/hono/sse.ts`, and reset entries payload caches by importing `routes/entries-payload.ts` directly.
- **Workflow actions are centralized in `src/control/`.** `/api/cancel-queued`, `/api/cancel-active-bulk`, `/api/retry`, `/api/retry-bulk`, and `/api/delete-bulk` are thin wrappers over `performWorkflowAction`. Scope discipline matters: `row`, `group`, and `visible-view` use explicit targets; only `tree` walks descendants. `daemon` stop remains operational, not a workflow action. (`/api/task/force-stop` was removed in Contract 5 — the per-run AbortController makes force-stop redundant.)
- **Bulk route overrides are narrow.** Bulk retry/delete default legacy callers to queue-panel/group, but may forward explicit `source:"batch-view"` + `scope:"visible-view"` for batch footer actions. Unsupported source/scope strings intentionally fall back to the legacy defaults.
- **OCR discard is a cancel variant.** A cancel request carrying `ocrSessionId` bypasses normal task target resolution and routes to `src/control/ocr/discard.ts`, preserving parent mirror writes and delegated child cleanup. Do not reintroduce `/api/ocr/discard-prepare` as a component transport.
- **Row lifecycle debug is observational only.** `row-lifecycle-debug.ts` replays the append-only tracker JSONL and reconstructs per-row lifecycles (surface recomputed via `buildTrackerQueueSurfaces`, plus cancel/retry/discard cause attribution); it must never mutate classification inputs or become a streamed data source. It is a stateless pure replay — both `.tracker/debug/` artifacts are regenerated each sweep, with no in-memory transition state to drift on dashboard restart.
- **Performance-sensitive caches are bounded and resettable.** Parse caches, session-event caches, TTL memoizers, and cross-workflow count caches use keyed LRU/TTL patterns and must be registered in `__resetAllDashboardCachesForTests()` when test-visible. Long-running dashboard intervals should be `.unref()`'d.
- **Failure scans should prefer SQLite.** `scanFailurePatterns` needs today's failed rows plus errors; query indexed `run_events` when projection state is ready and keep JSONL full-file scans only as fallback.
- **Screenshot cleanup is lifecycle-tied.** `sweepStaleRunScreenshots` joins terminal `runs.terminal_at` with registered screenshot files and has an orphan file-age backstop. Dashboard startup/preflight prune JSONL only; manual `npm run clean:tracker` can still clean screenshots.
- **Date math is local-calendar unless explicitly documented.** Tracker filenames, log paths, Excel tabs, dashboard date selection, and historical JSONL tests should use local `YYYY-MM-DD` semantics. Historical-date tests must pass real `today` separately from the selected date so live/today code paths do not accidentally read the wrong file.
- **Node 26 / SQLite test quirks:** `node:sqlite` returns null-prototype rows, so spread rows before `deepStrictEqual`; the test runner uses `--test-force-exit` because a few watcher/polling tests leave handles behind.
- **Legacy but still relevant:** `markStaleRunningEntries` remains removed because long Duo/Kronos waits look stale but are valid. Ctrl+C cleanup belongs in the SIGINT handler. Async mutexes must not wrap synchronous append calls; `appendFileSync` with `O_APPEND` gives the read-after-write semantics tests rely on.
