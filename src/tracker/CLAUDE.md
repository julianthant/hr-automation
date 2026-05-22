# Tracker Module

Two-tier tracking: JSONL for live dashboard streaming, Excel for persistent historical records.

> **Kernel-internal.** `withTrackedWorkflow`, `appendLogEntry`, and the SIGINT handler are invoked by `src/core/runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` / daemon `runOneItem` — workflow handlers never call them directly. Use `ctx.step(...)` / `ctx.updateData(...)` inside the handler.

## Files

- `jsonl.ts` — compatibility barrel for the tracker JSONL surface; keep public imports stable here
- `jsonl-io.ts` — JSONL append/read helpers (`trackEvent`, `appendLogEntry`, `readEntries*`, `readLogEntries*`), parse cache, type guards, PII-aware `serializeValue` + `toTypedValue`
- `tracked-workflow.ts` — `withTrackedWorkflow` lifecycle wrapper, `SessionContext`, `WithTrackedWorkflowOpts`, kernel-owned SIGINT/SIGTERM handling
- `jsonl-cleanup.ts` — `cleanOldTrackerFiles`, `cleanOldSessionFiles`, `cleanOldScreenshots`
- `dashboard/server.ts` — creates the HTTP server (port 3838): JSONL-only startup prune (unless `noClean`), projection rebuild, periodic sweeps. Serves `/api/*`, multiplexed `GET /events/hub`, and static prod assets when configured — routing lives under `dashboard/hono/`
- `dashboard.ts` — barrel re-export of `startDashboard` / `createDashboardServer` / `stopDashboard` plus session-state helpers (`filterEventsForRun`, `rebuildSessionState`, …) for tests and imports
- `session-events.ts` — `emitWorkflowStart` / `emitWorkflowEnd` / `emitSessionCreate` / `emitBrowserLaunch` / `emitAuthStart` / `emitAuthComplete` / `emitItemStart` / etc. Append `SessionEvent` lines to rotated `sessions-*.jsonl` (and legacy `sessions.jsonl`). `rebuildSessionState` in `src/tracker/dashboard/session-state.ts` reduces them into a live `SessionState` (re-exported from `dashboard.ts` for tests)
- `sessions/duo-queue.ts` — `requestDuoApproval(page, options)` — wraps `pollDuoApproval` with queue semantics (emit `duo_waiting` browser overlay, register in the global Duo queue, swap to `duo_active` when this request becomes head-of-line). Used by every login flow in `src/infra/auth/login.ts`
- `sessions/auth-observer.ts` — builds a `SessionObserver` that turns kernel auth lifecycle callbacks into tracker step events and failure screenshots.
- `files/files.ts` — SQLite-backed file registry helpers (`registerLocalFile`, `getRegisteredFile`) for PDFs, screenshots, page images, and related dashboard downloads.
- `files/pdf-cache.ts` — renders and registers per-page PNG cache records for uploaded PDFs.
- `files/multipart-helper.ts` — small multipart/form-data parser shared by dashboard upload routes.
- `state/screenshot-sweep.ts` — `sweepStaleRunScreenshots(dir, screenshotsDir, maxAgeDays = 30)` — lifecycle-tied screenshot cleanup driven by `runs.terminal_at`. Wired into `createDashboardServer` (startup + 6h interval). See "Cleaning Old Tracker Files".
- `state/queries.ts` — compatibility barrel for SQLite projection reads. Query-family modules live under `state/queries/`; the shared per-`Database` prepared-statement `WeakMap` lives in `state/queries/statements.ts`.
- `exports/export-excel.ts` — On-demand Excel export from JSONL data
- `exports/spreadsheet.ts` — `appendRow(filePath, columns, data)` and `parseDepartmentNumber(deptText)`
- `alerts/failure-detector.ts` — `detectFailurePattern(entries, opts)` — pure function that groups failed tracker entries by (workflow, error), returns patterns that cross `thresholdN` inside `windowMs`. Caller-owned `cooldownState: Map<string, number>` suppresses re-alerts for `cooldownMs`. Defaults: 3 / 10min / 1h.
- `alerts/notify.ts` — `notify(title, body)` — best-effort macOS desktop notification via `osascript display notification`. No native deps. On non-darwin or osascript failure, logs a warn and returns without throwing.
- `delegation/watch-child-runs.ts` — `watchChildRuns(opts)` — generic watcher: polls a workflow's JSONL until N expected `itemId`s reach terminal status. Used by non-migrated waits such as SharePoint delegation and OCR fallback/force-research paths. Supports custom `isTerminal` predicate, `onProgress` callback, and 200ms polling fallback for filesystems where `fs.watch` is unavailable.
- `queue-surfaces-debug.ts` — debug-only diagnostic. `runQueueSurfaceDebugSweep(dir)` samples `buildTrackerQueueSurfaces` on a 60s dashboard interval and appends a line to `.tracker/debug/queue-surfaces-<date>.jsonl` whenever a batch-parent / delegation anchor's queue **surface** changes (card ↔ flat ↔ collapsed) or is first seen. Pinpoints row-type / delegation classification regressions; never streamed, safe to delete.
- `dashboard/oath-upload/http.ts` — HTTP handlers for `/api/oath-upload/*` endpoints and restart sweep; kept under `dashboard/` because its imports are dashboard route/server-only.
- `locked.ts` — Generic mutex-locked write wrapper for parallel Excel access
- `dashboard/hono/routes/ocr.ts` — HTTP adapter for `/api/ocr/*` endpoints: OCR prepare/approve/force-research/forms/sweep handlers live under `dashboard/ocr/`; OCR discard/cancel glue lives in `src/control/ocr/discard.ts`. Per-sessionId in-memory lock (`_resetSessionLockForTests` for tests).
- `dashboard/hono/routes/entries-payload.ts` — JSONL fallback builder for the `entries` hub topic. It returns the selected workflow's tracker rows plus policy-declared persistent-root descendants (currently Oath Upload OCR/signature child context), then enriches rows for queue rendering.
- `../control/actions/`, `../control/ops/`, and `../control/ocr/` — central workflow action engine, low-level operator handlers, and OCR discard/cancel glue. Hono route wrappers live in `dashboard/hono/routes/ops.ts` and `dashboard/hono/routes/ocr.ts`; implementation lives in `src/control/`.
- `index.ts` — Barrel re-exports

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

- `cleanOldTrackerFiles(maxAgeDays, dir)` — deletes JSONL files whose filename date (YYYY-MM-DD) is older than `maxAgeDays`. Returns count deleted.
- `cleanOldScreenshots(maxAgeDays, dir)` — still available for **manual**/`npm run clean:tracker` use — deletes PNGs in `.screenshots/` whose filename-embedded ms timestamp is older than `maxAgeDays`. Not invoked on dashboard startup or `GET /api/preflight` (the dashboard uses `sweepStaleRunScreenshots` instead — see below).
- `sweepStaleRunScreenshots(dir, screenshotsDir, maxAgeDays = 30)` (`src/tracker/state/screenshot-sweep.ts`) — **lifecycle-tied** screenshot cleanup. Two passes: (1) joins `runs` (where `terminal_at` is older than `maxAgeDays`) with `files` (`kind='screenshot'`) and deletes both the PNGs and the rows in one transaction, zeroing `runs.screenshot_count`; (2) file-age backstop that deletes orphan PNGs older than `maxAgeDays` (parsed from the ms-embedded filename, mtime fallback) whose path is not registered in `files`. Per-file delete failures are logged via `log.warn` and the sweep continues. No-op when the projection isn't ready. `runs.terminal_at` is stamped by `applyTrackerEntry` the first time a run reaches a terminal status (`done` / `failed` / `skipped`).
- `npm run clean:tracker` — CLI wrapper in `src/scripts/ops/clean-tracker.ts`. By default cleans tracker JSONL + screenshots. Accepts `--days N` (default 7), `--dir PATH`, `--screenshots-dir PATH`, `--no-screenshots`, `--screenshots-only`.
- **Dashboard cadence:** `createDashboardServer` runs three startup operations: a one-time `cleanOldTrackerFiles` prune at **30 days** (JSONL only), a single `sweepStaleRunScreenshots` pass, then a low-frequency `setInterval` (**6 hours**, `.unref()`) that re-runs the screenshot sweep so long-lived dashboards keep up. `GET /api/preflight` re-runs the JSONL prune at most once per **60s** (throttled in `hono/routes/base.ts`); it does NOT re-trigger the screenshot sweep. Pass `{ noClean: true }` or `--no-clean` to skip startup operations.

## `withTrackedWorkflow(workflow, id, data, fn)`

Lifecycle wrapper for all workflows. Auto-emits JSONL events:
- **pending** — immediately on start
- **running** — via `setStep(step)` callback at phase transitions
- **done** — automatically on successful return
- **failed** — automatically on thrown error (with error message)

```ts
await withTrackedWorkflow("separations", docId, {}, async (setStep, updateData) => {
  setStep("authenticating");
  // ... auth ...
  updateData({ name: employeeName });
  setStep("extraction");
  // ... extract ...
}); // auto-emits done or failed
```

- `setStep(step)` — emits a `running` event with the step name
- `updateData(d)` — merges data into the entry (e.g. employee name discovered mid-workflow)
- The kernel nests this wrapper inside `withLogContext` for every production run path
- Tracker functions (`updateOnboardingTracker`, etc.) are Excel-only — they no longer call `trackEvent()`
- `opts.onCleanup` — callback for resource teardown (e.g. closing browsers) on both success and failure
- `opts.preAssignedRunId` — pre-assigned runId for batch mode (caller pre-emits pending for all items, then processes sequentially)
- `opts.preAssignedInstance` — pre-assigned workflow instance name (e.g. `"EID Lookup 1"`) for batch runners. When present, `withTrackedWorkflow` **skips its own `workflow_start` / `workflow_end` emits and skips calling `generateInstanceName`** — the caller (`withBatchLifecycle` in `src/core/batch-lifecycle.ts`) owns the batch-level lifecycle. The value is also stamped into each tracker row's `data.instance` so the dashboard session drawer can join per-item rows back to the batch instance.
- Calls `setLogRunId(runId)` to inject `runId` into the `AsyncLocalStorage` log context so log entries include it
- **SIGINT handler**: Registers a `process.on("SIGINT")` handler that writes a `failed` tracker entry and log entry synchronously via `fs.appendFileSync` before calling `process.exit`. Also kills Playwright Chrome via `wmic` on Windows.

## Dashboard SSE Server

`startDashboard(opts?)` starts an HTTP server (default port 3838 — see `StartDashboardOptions`). Endpoints:

- `GET /api/workflows` — list all workflows with JSONL data
- `GET /api/workflow-definitions` — kernel registry payload (label, steps, detailFields, getName/getId)
- `GET /api/dates?workflow=X` — list available dates for a workflow
- `GET /api/entries?workflow=X` — return all tracker entries (JSON)
- `GET /api/logs?workflow=X&id=Y[&runId=Z]` — return log entries (JSON)
- `GET /api/runs?workflow=X&id=Y[&date=D]` — past runs for an itemId
- `GET /api/screenshots?workflow=X&itemId=Y` — list `.screenshots/<workflow>-<itemId>-...png` for a failed entry
- `GET /screenshots/<filename>` — stream a PNG with path-traversal guard (`resolveScreenshotPath`)
- `GET /api/search?q=Q[&days=N]` — cross-workflow tracker entry search (`buildSearchHandler`)
- `GET /api/selector-warnings?days=N` — aggregated selector-fallback warns across N days (default 7)
- `GET /api/failures` — `FailureRow[]` for failed entries on a given date across all workflows (`buildFailuresHandler`). Same latest-run-per-`(workflow,id)` dedup pattern; takes optional `?date=YYYY-MM-DD` (default today).
- `GET /api/preflight` — startup checks + cleanedFiles count
- `GET /api/rosters` — list xlsx rosters in `.tracker/rosters/` + `src/data/`, newest first (consumer: `RunModal`)
- `POST /api/ocr/prepare` — multipart/form-data; fire-and-forgets `runWorkflow(ocrWorkflow)` and returns `{ok, sessionId, pdfPath}`. Body cap: 50MB.
- `POST /api/ocr/approve-batch` — JSON `{sessionId, records[]}`; expands to N kernel queue items via `enqueueFromHttp` for the downstream form-type daemon.
- `POST /api/ocr/discard` — JSON `{sessionId, reason?}`; emits `failed` step `discarded`.
- `POST /api/ocr/reocr-whole-pdf` — JSON `{sessionId}`; re-runs OCR for every page.
- `POST /api/ocr/retry-page` — JSON `{sessionId, pageNumber}`; retries one OCR page.
- `POST /api/ocr/force-research` — JSON `{sessionId, records[]}`; re-dispatches eid-lookup for a subset of records flagged for forced research.

Implementation: `src/tracker/dashboard/hono/routes/ocr.ts`.
- **`GET /events/hub?subs=<urlencoded JSON array>`** — single multiplexed SSE connection. Each element is `{ id, topic, params }`; every `data:` line is a `HubEnvelope` `{ sub, data, event? }` for the matching subscription id (`src/tracker/dashboard/hono/routes/hub.ts`). **Legacy per-topic URLs** (`/events`, `/events/logs`, …) were removed (2026-05-08); no `registerEventRoutes` shim remains.
- **Topic registry** — `src/tracker/dashboard/hono/topics.ts` (`topicRegistry`, `parseSubsQuery`). **Emitters** register in `topics-emitters.ts`. Registered topics include: `entries` (payload includes enriched rows + `wfCounts` + `failureCounts` from `computeFailureCounts` — drives `FailureBell` without an extra HTTP fetch for counts), `logs`, `sessions`, `runEvents`, `captureSessions`, `telegram`.
- **Run events filtering** — events lacking `runId` (batch-scope `Session.launch`) are attributed via `workflowInstance` + per-run time window inside `filterEventsForRun` (`src/tracker/dashboard/session-state.ts`), **re-exported** from `src/tracker/dashboard.ts` for unit tests and hub code.

In dev, the React dashboard is served by Vite (port 5173) and proxies API calls to 3838. In prod, `dashboard --prod` serves `dist/dashboard/index.html` from the Hono dashboard server.

## JSONL File Format

Two file types per workflow per day in `.tracker/`:

- **Entries**: `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` — one JSON line per `trackEvent()` call
- **Logs**: `.tracker/{workflow}-{YYYY-MM-DD}-logs.jsonl` — one JSON line per `log.step/success/error/waiting` call (via `withLogContext`)

Debug-only side files live in the `.tracker/debug/` **subdirectory** (kept out of `.tracker/` top-level so they are not picked up as workflows):

- **Queue surfaces**: `.tracker/debug/queue-surfaces-{YYYY-MM-DD}.jsonl` — one JSON line per queue-surface transition (see `queue-surfaces-debug.ts`). Not streamed, not consumed programmatically.

## `appendRow(filePath, columns, data)`

Appends a single row to an `.xlsx` file. Creates the file and/or worksheet if missing. Worksheet name is today's date as `YYYY-MM-DD`.

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
- **Workflow actions are centralized in `src/control/`.** `/api/cancel-queued`, `/api/task/force-stop`, `/api/cancel-active-bulk`, `/api/retry`, `/api/retry-bulk`, and `/api/delete-bulk` are thin wrappers over `performWorkflowAction`. Scope discipline matters: `row`, `group`, and `visible-view` use explicit targets; only `tree` walks descendants. `daemon` stop remains operational, not a workflow action.
- **Bulk route overrides are narrow.** Bulk retry/delete default legacy callers to queue-panel/group, but may forward explicit `source:"batch-view"` + `scope:"visible-view"` for batch footer actions. Unsupported source/scope strings intentionally fall back to the legacy defaults.
- **OCR discard is a cancel variant.** A cancel request carrying `ocrSessionId` bypasses normal task target resolution and routes to `src/control/ocr/discard.ts`, preserving parent mirror writes and delegated child cleanup. Do not reintroduce `/api/ocr/discard-prepare` as a component transport.
- **Queue-surface debug is observational only.** `queue-surfaces-debug.ts` samples `buildTrackerQueueSurfaces` output and appends transition-only records under `.tracker/debug/`; it must never mutate classification inputs or become a streamed data source.
- **Performance-sensitive caches are bounded and resettable.** Parse caches, session-event caches, TTL memoizers, and cross-workflow count caches use keyed LRU/TTL patterns and must be registered in `__resetAllDashboardCachesForTests()` when test-visible. Long-running dashboard intervals should be `.unref()`'d.
- **Failure scans should prefer SQLite.** `scanFailurePatterns` needs today's failed rows plus errors; query indexed `run_events` when projection state is ready and keep JSONL full-file scans only as fallback.
- **Screenshot cleanup is lifecycle-tied.** `sweepStaleRunScreenshots` joins terminal `runs.terminal_at` with registered screenshot files and has an orphan file-age backstop. Dashboard startup/preflight prune JSONL only; manual `npm run clean:tracker` can still clean screenshots.
- **Date math is local-calendar unless explicitly documented.** Tracker filenames, log paths, Excel tabs, dashboard date selection, and historical JSONL tests should use local `YYYY-MM-DD` semantics. Historical-date tests must pass real `today` separately from the selected date so live/today code paths do not accidentally read the wrong file.
- **Node 26 / SQLite test quirks:** `node:sqlite` returns null-prototype rows, so spread rows before `deepStrictEqual`; the test runner uses `--test-force-exit` because a few watcher/polling tests leave handles behind.
- **Legacy but still relevant:** `markStaleRunningEntries` remains removed because long Duo/Kronos waits look stale but are valid. Ctrl+C cleanup belongs in the SIGINT handler. Async mutexes must not wrap synchronous append calls; `appendFileSync` with `O_APPEND` gives the read-after-write semantics tests rely on.
