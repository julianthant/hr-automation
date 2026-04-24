# Tracker Module

Two-tier tracking: JSONL for live dashboard streaming, Excel for persistent historical records.

> **Kernel-internal.** `withTrackedWorkflow`, `appendLogEntry`, and the SIGINT handler are wrapped by `src/core/runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` — kernel workflows never call them directly. Legacy workflows (`separations`, `old-kronos-reports`) still call `withTrackedWorkflow` manually because they predate the kernel. If you're writing a new workflow, use `ctx.step(...)` / `ctx.updateData(...)` in `src/core/` instead.

## Files

- `jsonl.ts` — JSONL append-only tracker + `withTrackedWorkflow` lifecycle wrapper, `cleanOldTrackerFiles`/`cleanOldScreenshots`, PII-aware `serializeValue` + `toTypedValue`
- `dashboard.ts` — SSE API server (port 3838) — serves `/api/*` and `/events/*` endpoints only (no HTML). Owns session-state rebuild, screenshots endpoint, search endpoint, selector-warnings endpoint
- `session-events.ts` — `emitWorkflowStart` / `emitWorkflowEnd` / `emitSessionCreate` / `emitBrowserLaunch` / `emitAuthStart` / `emitAuthComplete` / `emitItemStart` / etc. Append `SessionEvent` lines to `.tracker/sessions.jsonl`. `rebuildSessionState` (in `dashboard.ts`) reduces them into a live `SessionState`
- `duo-queue.ts` — `requestDuoApproval(page, options)` — wraps `pollDuoApproval` with queue semantics (emit `duo_waiting` browser overlay, register in the global Duo queue, swap to `duo_active` when this request becomes head-of-line). Used by every login flow in `src/auth/login.ts`
- `export-excel.ts` — On-demand Excel export from JSONL data
- `locked.ts` — Generic mutex-locked write wrapper for parallel Excel access
- `spreadsheet.ts` — `appendRow(filePath, columns, data)` and `parseDepartmentNumber(deptText)`
- `failure-detector.ts` — `detectFailurePattern(entries, opts)` — pure function that groups failed tracker entries by (workflow, error), returns patterns that cross `thresholdN` inside `windowMs`. Caller-owned `cooldownState: Map<string, number>` suppresses re-alerts for `cooldownMs`. Defaults: 3 / 10min / 1h.
- `notify.ts` — `notify(title, body)` — best-effort macOS desktop notification via `osascript display notification`. No native deps. On non-darwin or osascript failure, logs a warn and returns without throwing.
- `index.ts` — Barrel re-exports

## Failure-Pattern Alerts

After each `/events` SSE poll cycle, `scanFailurePatterns()` runs today's tracker entries across all workflows through `detectFailurePattern`. Any pattern that crosses threshold (and isn't in cooldown) fires a macOS desktop notification + `log.warn`. The cooldown map is module-level so it persists for the lifetime of the dashboard process. Tests can call `__resetFailureAlertCooldown()` to clear it. Scan errors are swallowed — a notification glitch must never derail the SSE loop.

## Cleaning Old Tracker Files

- `cleanOldTrackerFiles(maxAgeDays, dir)` — deletes JSONL files whose filename date (YYYY-MM-DD) is older than `maxAgeDays`. Returns count deleted.
- `cleanOldScreenshots(maxAgeDays, dir)` — deletes PNGs in `.screenshots/` whose filename-embedded ms timestamp (trailing segment before `.png`) is older than `maxAgeDays`. Returns count deleted. Malformed names (no numeric trailing segment) are skipped — never accidentally deleted.
- `npm run clean:tracker` — CLI wrapper in `src/scripts/clean-tracker.ts`. By default cleans tracker JSONL + screenshots. Accepts `--days N` (default 7), `--dir PATH`, `--screenshots-dir PATH`, `--no-screenshots`, `--screenshots-only`.
- `startDashboard()` runs a one-time startup prune at 30 days for tracker JSONL + screenshots (per-request `/api/preflight` still handles the 7-day ongoing prune for tracker files). Pass `{ noClean: true }` or `--no-clean` CLI flag to skip.

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
- All 5 workflows use this wrapper nested inside `withLogContext`
- Tracker functions (`updateOnboardingTracker`, etc.) are Excel-only — they no longer call `trackEvent()`
- `opts.onCleanup` — callback for resource teardown (e.g. closing browsers) on both success and failure
- `opts.preAssignedRunId` — pre-assigned runId for batch mode (caller pre-emits pending for all items, then processes sequentially)
- `opts.preAssignedInstance` — pre-assigned workflow instance name (e.g. `"EID Lookup 1"`) for batch runners. When present, `withTrackedWorkflow` **skips its own `workflow_start` / `workflow_end` emits and skips calling `generateInstanceName`** — the caller (`withBatchLifecycle` in `src/core/batch-lifecycle.ts`) owns the batch-level lifecycle. The value is also stamped into each tracker row's `data.instance` so SessionPanel can join per-item rows back to the batch instance.
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
- `GET /api/preflight` — startup checks + cleanedFiles count
- `SSE /events?workflow=X&date=Y` — stream entries (enriched with `firstLogTs`, `lastLogTs`, `lastLogMessage`, `stepDurations`) + `wfCounts` every 1s.
- `SSE /events/logs?workflow=X&id=Y&date=Z[&runId=R]` — stream log entries every 500ms
- `SSE /events/sessions` — stream `SessionState` (workflow instances + browsers + duo queue) for `SessionPanel`
- `SSE /events/run-events?workflow=X&id=Y&runId=Z[&date=D]` — stream kernel session events for a specific run (workflow_start, browser_launch, duo_*, auth_*, item_*, etc.) every 500ms. Same delta semantics as `/events/logs`. Events lacking `runId` (emitted by `Session.launch` at batch scope, outside per-item `withLogContext`) are attributed to a run via `workflowInstance`: the handler resolves `runId -> tracker entry -> data.instance`, then pulls in no-`runId` events that share that instance. Implemented by the pure `filterEventsForRun(events, trackers, runId)` function, exported for unit-test access.

API-only: does not serve HTML. The React dashboard is served by Vite dev server (port 5173) which proxies API calls to 3838.

## JSONL File Format

Two file types per workflow per day in `.tracker/`:

- **Entries**: `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` — one JSON line per `trackEvent()` call
- **Logs**: `.tracker/{workflow}-{YYYY-MM-DD}-logs.jsonl` — one JSON line per `log.step/success/error/waiting` call (via `withLogContext`)

## `appendRow(filePath, columns, data)`

Appends a single row to an `.xlsx` file. Creates the file and/or worksheet if missing. Worksheet name is today's date as `YYYY-MM-DD`.

## Gotchas

- **Critical ExcelJS quirk**: After `readFile()`, ExcelJS loses column key mappings. Code re-applies keys in a loop — without this, `addRow(data)` won't map object keys correctly.
- Date uses `new Date().toISOString().slice(0, 10)` — system clock, no timezone awareness
- Tracker `.xlsx` files belong inside their workflow folder, never in project root
- Dashboard port 3838 conflict: logs and skips if port in use (another instance running)
- `withTrackedWorkflow` does NOT call `withLogContext` — use both: `withLogContext` wraps `withTrackedWorkflow` to get both log streaming and entry tracking
- **Do NOT use `markStaleRunningEntries`** — was removed because it falsely marked running entries as "failed" with fake "Process interrupted — no heartbeat" messages. Use SIGINT handler in `withTrackedWorkflow` instead for proper cleanup on Ctrl+C.
- **SIGINT writes must be synchronous** — `process.on("SIGINT")` handler cannot await async functions (process exits before they complete). Use `fs.appendFileSync` directly when writing final tracker/log entries.
- **`trackEvent` / `appendLogEntry` are synchronous** — do NOT wrap `appendFileSync` in a mutex. POSIX `write(2)` with `O_APPEND` is atomic at the OS level, and Node is single-threaded within a process. An `async-mutex` wrapper makes the call fire-and-forget (returns a `Promise` but signature is `void`), causing reads-after-write to miss data.

## Adding Tracking for a New Workflow

Kernel workflows get tracking for free — `defineWorkflow({ ... })` registers dashboard metadata and `runWorkflow` wraps each run in `withTrackedWorkflow`. Do NOT call `withTrackedWorkflow`, `trackEvent`, or `setStep` from a handler; use `ctx.step(...)` / `ctx.markStep(...)` / `ctx.updateData(...)` instead.

Legacy workflows (only `separations`, `old-kronos-reports` as of 2026-04-17) wrap execution manually:

1. In the workflow's `workflow.ts`, wrap execution in `withTrackedWorkflow(workflowName, id, data, fn)`
2. Use `setStep(step)` at each major phase transition
3. Use `updateData(d)` to add discovered data (e.g., employee name)
4. Create a `tracker.ts` in the workflow folder for Excel tracking if the workflow needs persistent historical records (Excel-only — no `trackEvent` calls)
5. Call `defineDashboardMetadata({ name, label, steps, systems, detailFields })` at module load in the workflow's `index.ts` so the dashboard registry has its UI metadata

## Lessons Learned

- **2026-04-10: Dashboard logs empty despite JSONL having data** — `withTrackedWorkflow` generates `runId` but the log context (set by `withLogContext`) didn't include it. Log entries were written without `runId`. The dashboard's `runId` filter (`l.runId === runId`) rejected all logs (`undefined === "3885#1"` → false). Fix: `withTrackedWorkflow` now calls `setLogRunId(runId)` to inject the `runId` into the `AsyncLocalStorage` log context, so future log entries include `runId`. Server-side filter also uses `!l.runId || l.runId === runId` fallback for backwards compat with old entries.
- **2026-04-10: markStaleRunningEntries caused false failures** — `markStaleRunningEntries` was marking running entries as "failed" with a fake "Process interrupted — no heartbeat" message after 30s with no update. This was wrong: entries can legitimately be running for minutes while waiting for Duo MFA or long Kronos searches. Removed entirely. Replaced with SIGINT handler in `withTrackedWorkflow` that writes a proper `failed` entry synchronously on Ctrl+C.
- **2026-04-10: SSE entry enrichment** — Backend now enriches tracker entries with `firstLogTs`, `lastLogTs`, and `lastLogMessage` per (itemId, runId) pair. This lets the frontend show accurate start times, elapsed durations, and the latest log line without fetching full log streams.
- **2026-04-10: Workflow counts from backend** — Moved workflow dropdown counts to backend (`wfCounts` field in SSE payload) so they accurately reflect all workflows, not just the currently selected one.
- **2026-04-14: `readRunsForId` missed past-date runs** — was calling `readEntries(workflow)` which only reads today's JSONL. When viewing a past date in the dashboard, `/api/runs` returned an empty list and the RunSelector showed only the latest run. Fix: added optional `date` param; backend (`/api/runs`) and frontend (`LogPanel`) now forward the selected date so runs from that day's JSONL are returned.
- **2026-04-14: Preflight deleted fresh `sessions.jsonl` on every refresh** — `/api/preflight` checked if any `workflow_start` PID was alive and deleted the entire file if none were, wiping fake/mock demo data on refresh. Replaced with age-gated deletion (only if file untouched >24h) + dead-PID enrichment in `rebuildSessionState` (crashed workflows are marked `active: false` at read time — no file mutation). Preserves recent activity AND provides immediate crash-recovery UX.
- **2026-04-14: Async mutex broke sync reads-after-writes** — `trackEvent` and `appendLogEntry` wrapped their `appendFileSync` calls in `writeMutex.runExclusive(() => …)` and returned `void` without awaiting. The write became fire-and-forget, so tests (and any caller reading back immediately) saw no data. Removed the mutex entirely — `appendFileSync` is already atomic. Restored true synchronous semantics.
- **2026-04-18: Removed runner endpoints + child-process registry** — `src/tracker/runner.ts` and the `/api/workflows/:name/run`, `/api/workflows/:name/schema`, `/api/runs/:runId/cancel`, `/api/runs/active` route registrations + `buildSpawnHandler` / `buildCancelHandler` / `buildActiveRunsHandler` / `buildWorkflowSchemaHandler` factories were deleted from `dashboard.ts`. The dashboard is observation-only — workflows launch via `npm run …` scripts (or whatever replacement launcher lands later). The unrelated `/api/runs?workflow=X&id=Y` endpoint (used by `RunSelector` to list past runs for an itemId) is preserved — that's a separate read-only endpoint backed by `readRunsForId`.
- **2026-04-19: Session events now carry runId.** `emitSessionEvent` reads from `AsyncLocalStorage` (via `getLogRunId()`) so events emitted during a tracked workflow item are attributable to that run. Events emitted outside a per-item `withLogContext` (batch-scope `Session.launch`) still carry `workflowInstance`, which is used for fallback attribution — see the 2026-04-23 lesson below.
- **2026-04-19: `step_change` dedupe.** When `markStep` fires both a `step` log entry and a `step_change` session event for the same `(workflow, runId, step)` within 50ms, the session event is suppressed. Prevents duplicate "advanced to step X" lines in the dashboard's Events tab.
- **2026-04-19: `createDashboardServer(opts)` factory.** Extracted from `startDashboard` so tests can spin up isolated servers on random ports with per-test tracker directories. `startDashboard` is now a thin wrapper that preserves the CLI singleton behavior.
- **2026-04-21: `computeStepDurations` anchors step 1 at the workflow start (pending ts).** Previously step 1's duration was measured from its own `running` event, which meant the pre-first-step gap (browser launch, session create, pending→first-running latency) was silently dropped — `sum(stepDurations)` didn't equal the global `useElapsed` counter on the dashboard. Now the earliest valid timestamp in the run (normally the `pending` event) anchors step 1's start, so subsequent steps tile the rest of the elapsed time exactly. The global timer value at the moment step N completes equals `sum(step1..stepN)`. Backfilled as 2 new unit tests in `tests/unit/tracker/dashboard.test.ts` ("absorbs the pending→first-running gap into step 1", "tiles elapsed time when no pending event is present"). Knock-on: `computeCacheStepAvgs` — which builds per-step historical averages — includes the absorbed gap in step 1's average for runs that emitted a pending event. That's more honest ("how long does step 1 typically take from workflow start") and matches what the step-pipeline chips already display.
- **2026-04-21: Batch-level instance + authTimings injection (all three batch modes).** `runWorkflowBatch` (sequential), `runWorkflowPool`, and `runWorkflowSharedContextPool` now all wrap their body in `withBatchLifecycle` (`src/core/batch-lifecycle.ts`). Every batch invocation emits exactly ONE `workflow_start` + one `workflow_end` instead of N. Each item's `withTrackedWorkflow` call receives `preAssignedInstance` (skipping its own `workflow_start/end`) and `authTimings` — an array of `{ systemId, startTs, endTs }` recorded by a `SessionObserver` during `Session.launch`. `runOneItem` injects a synthetic `running` tracker entry at `startTs` for each auth step BEFORE the handler runs, so per-item dashboard rows tile elapsed exactly with real per-system auth durations (ucpath 10–20s, crm 15–30s, etc.) rather than collapsing auth into the first handler step. `pool` mode uses one observer **per worker** (worker-scoped `authTimings[]` injected only into items that worker processes); `sequential` + `shared-context-pool` share one observer for the whole batch. SIGINT mid-batch fans out `failed` tracker rows for every un-terminated item + emits one `workflow_end(failed)`. Auth-failure on `Session.launch` fans out `failed` rows attributed to `auth:<firstSystem>` so the dashboard shows the right step.
- **2026-04-21: `generateInstanceName` self-heals dead-pid stale starts.** Workflow instance numbering used to lock forever if a process crashed between `workflow_start` and `workflow_end`. Now any `workflow_start` whose pid is dead AND is older than 60s is treated as "ended" for numbering purposes — the instance number gets recycled. 60s threshold lets legitimately-still-starting-up workflows (pre-first-`workflow_end`) keep their slot. `generateInstanceName` also takes an optional `dir` arg now, threaded through from `withTrackedWorkflow`, so test suites and tools can point it at isolated directories.
- **2026-04-21: runId format coexists.** Two runId formats live side-by-side in `.tracker/*.jsonl` and `sessions.jsonl`:
  - **UUID format (`randomUUID()`):** emitted by the kernel's batch/pool paths — `runWorkflowBatch` (`src/core/workflow.ts:445`) and `runWorkflowPool` (`src/core/pool.ts:36`) generate a UUID per item and thread it into `withTrackedWorkflow` via `preAssignedRunId` (`src/core/workflow.ts:164`).
  - **Legacy `{id}#N` format:** emitted by `withTrackedWorkflow` itself (`src/tracker/jsonl.ts:276`) whenever `preAssignedRunId` is absent — i.e. direct/test callers AND the kernel's single-run `runWorkflow` path. Note the subtlety: `runWorkflow` computes a local UUID at `src/core/workflow.ts:315` for its Stepper / screenshot emitter, but when it delegates to `withTrackedWorkflow` at `src/core/workflow.ts:408` it forwards `opts.preAssignedRunId` (the outer caller's value — usually `undefined`), not the local UUID. The Stepper / makeCtx / makeScreenshotFn use the local UUID; tracker JSONL entries and session events (which resolve `runId` from `getLogRunId()` / ALS — see `src/tracker/session-events.ts:73`) get the `{id}#N` value. So for single-run kernel workflows both tracker entries AND session events use `{id}#N`; only in-process Stepper-scoped artifacts see the local UUID.
  - **Dashboard read-time fallback:** a second, independent fallback lives in `src/tracker/dashboard.ts` (first use at line 801; also 922/1255/1267/1311/1395/1408): `e.runId || \`${e.id}#1\`` synthesizes a runId at read time for entries/logs that have none.
  - **Fallback (2026-04-23, current):** events lacking `runId` are attributed via `workflowInstance`, not pid. `filterEventsForRun` (exported from `dashboard.ts`) resolves the requested runId to a tracker entry's `data.instance`, then pulls in no-`runId` events whose `workflowInstance` matches. This replaced the earlier pid+time-window fallback — which had a latent bug for long-lived daemons (a daemon processing items back-to-back shared one pid across batches, leaking batch-scope events between items). Instance-scoping isolates each batch cleanly. Pre-2026-04-21 tracker entries without `data.instance` degrade to primary-only filtering.
