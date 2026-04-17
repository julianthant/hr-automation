# Tracker Module

Two-tier tracking: JSONL for live dashboard streaming, Excel for persistent historical records.

> **Kernel-internal.** `withTrackedWorkflow`, `appendLogEntry`, and the SIGINT handler are wrapped by `src/core/runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` — kernel workflows never call them directly. Legacy workflows (`separations`, `old-kronos-reports`) still call `withTrackedWorkflow` manually because they predate the kernel. If you're writing a new workflow, use `ctx.step(...)` / `ctx.updateData(...)` in `src/core/` instead.

## Files

- `jsonl.ts` — JSONL append-only tracker + `withTrackedWorkflow` lifecycle wrapper
- `dashboard.ts` — SSE API server (port 3838) — serves `/api/*` and `/events/*` endpoints only (no HTML)
- `export-excel.ts` — On-demand Excel export from JSONL data
- `locked.ts` — Generic mutex-locked write wrapper for parallel Excel access
- `spreadsheet.ts` — `appendRow(filePath, columns, data)` and `parseDepartmentNumber(deptText)`
- `index.ts` — Barrel re-exports

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
- Calls `setLogRunId(runId)` to inject `runId` into the `AsyncLocalStorage` log context so log entries include it
- **SIGINT handler**: Registers a `process.on("SIGINT")` handler that writes a `failed` tracker entry and log entry synchronously via `fs.appendFileSync` before calling `process.exit`. Also kills Playwright Chrome via `wmic` on Windows.

## Dashboard SSE Server

`startDashboard(workflow, port)` starts an HTTP server with:
- `GET /api/workflows` — list all workflows with JSONL data
- `GET /api/dates?workflow=X` — list available dates for a workflow
- `GET /api/entries?workflow=X` — return all tracker entries (JSON)
- `GET /api/logs?workflow=X&id=Y` — return log entries (JSON)
- `SSE /events?workflow=X&date=Y` — stream entries (enriched with `firstLogTs`, `lastLogTs`, `lastLogMessage`) + `wfCounts` every 1s
- `SSE /events/logs?workflow=X&id=Y&date=Z` — stream log entries every 500ms

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
