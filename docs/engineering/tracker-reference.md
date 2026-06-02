# Tracker Module Reference

Full reference for `src/tracker/`. For invariants, critical gotchas, and lessons see `src/tracker/CLAUDE.md`.

## Files

- `jsonl.ts` — compatibility barrel for the tracker JSONL surface; keep public imports stable here
- `jsonl-io.ts` — JSONL append/read helpers (`trackEvent`, `appendLogEntry`, `readEntries*`, `readLogEntries*`), parse cache, type guards, PII-aware `serializeValue` + `toTypedValue`
- `tracked-workflow.ts` — `withTrackedWorkflow` lifecycle wrapper, `SessionContext`, `WithTrackedWorkflowOpts`, kernel-owned SIGINT/SIGTERM handling
- `jsonl-cleanup.ts` — `cleanOldTrackerFiles`, `cleanOldSessionFiles`, `cleanOldScreenshots`
- `dashboard/server.ts` — creates the HTTP server (port 3838): JSONL-only startup prune (unless `noClean`), projection rebuild, periodic sweeps. Serves `/api/*`, multiplexed `GET /events/hub`, and static prod assets when configured — routing lives under `dashboard/hono/`
- `dashboard.ts` — barrel re-export of `startDashboard` / `createDashboardServer` / `stopDashboard` plus session-state helpers (`filterEventsForRun`, `rebuildSessionState`, …) for tests and imports
- `session-events.ts` — `emitWorkflowStart` / `emitWorkflowEnd` / `emitSessionCreate` / `emitBrowserLaunch` / `emitAuthStart` / `emitAuthComplete` / `emitItemStart` / etc. Append `SessionEvent` lines to `.tracker/sessions/{YYYY-MM-DD}.jsonl`. `rebuildSessionState` in `src/tracker/dashboard/session-state.ts` reduces them into a live `SessionState` (re-exported from `dashboard.ts` for tests)
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
- `row-lifecycle-debug.ts` — debug-only diagnostic. `runRowLifecycleDebugSweep(dir)` **replays** today's tracker JSONL on a 60s dashboard interval and reconstructs each row's full lifecycle: every status/step/data change, with the queue **surface** recomputed at that point (`resolveRowSurfaces`) and operator-action cause attribution (`cancel` / `retry` / `discard` / `ocr-approval`). Retries stitch into the same row (new runId under the same item id); surface flips after a row goes terminal are flagged as `post-terminal-surface-change`. Writes two artifacts under `.tracker/debug/`: `row-lifecycle-<date>.jsonl` (chronological transition trail) and `row-lifecycle-<date>.json` (per-row consolidated history). Pure replay over the append-only source — fully regenerated each sweep, never streamed, safe to delete. Replaced the surface-only `queue-surfaces-debug.ts`.
- `dashboard/oath-upload/http.ts` — HTTP handlers for `/api/oath-upload/*` endpoints and restart sweep; kept under `dashboard/` because its imports are dashboard route/server-only.
- `locked.ts` — Generic mutex-locked write wrapper for parallel Excel access
- `dashboard/hono/routes/ocr.ts` — HTTP adapter for `/api/ocr/*` endpoints: OCR prepare/approve/force-research/forms/sweep handlers live under `dashboard/ocr/`; OCR discard/cancel glue lives in `src/control/ocr/discard.ts`. Per-sessionId in-memory lock (`_resetSessionLockForTests` for tests).
- `dashboard/hono/routes/entries-payload.ts` — JSONL fallback builder for the `entries` hub topic. It returns the selected workflow's tracker rows plus policy-declared persistent-root descendants (currently Oath Upload OCR/signature child context), then enriches rows for queue rendering.
- `../control/actions/`, `../control/ops/`, and `../control/ocr/` — central workflow action engine, low-level operator handlers, and OCR discard/cancel glue. Hono route wrappers live in `dashboard/hono/routes/ops.ts` and `dashboard/hono/routes/ocr.ts`; implementation lives in `src/control/`.
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
- `GET /api/screenshots?workflow=X&itemId=Y` — list `.tracker/screenshots/<workflow>-<itemId>-...png` for a failed entry
- `GET /screenshots/<filename>` — stream a PNG with path-traversal guard (`resolveScreenshotPath`)
- `GET /api/search?q=Q[&days=N]` — cross-workflow tracker entry search (`buildSearchHandler`)
- `GET /api/selector-warnings?days=N` — aggregated selector-fallback warns across N days (default 7)
- `GET /api/failures` — `FailureRow[]` for failed entries on a given date across all workflows (`buildFailuresHandler`). Same latest-run-per-`(workflow,id)` dedup pattern; takes optional `?date=YYYY-MM-DD` (default today).
- `GET /api/preflight` — startup checks + cleanedFiles count
- `GET /api/rosters` — list xlsx rosters in `.tracker/rosters/` + `.tracker/sharepoint/`, newest first (consumer: `RunModal`)
- `POST /api/ocr/prepare` — multipart/form-data; fire-and-forgets `runWorkflow(ocrWorkflow)` and returns `{ok, sessionId, pdfPath}`. Body cap: 50MB.
- `POST /api/ocr/approve-batch` — JSON `{sessionId, records[]}`; expands to N kernel queue items via `enqueueFromHttp` for the downstream form-type daemon.
- `POST /api/ocr/discard` — JSON `{sessionId, reason?}`; emits `failed` step `discarded`.
- `POST /api/ocr/reocr-whole-pdf` — JSON `{sessionId}`; re-runs OCR for every page.
- `POST /api/ocr/retry-page` — JSON `{sessionId, pageNumber}`; retries one OCR page.
- `POST /api/ocr/force-research` — JSON `{sessionId, records[]}`; re-dispatches Person Lookup for a subset of records flagged for forced research.

Implementation: `src/tracker/dashboard/hono/routes/ocr.ts`.
- **`GET /events/hub?subs=<urlencoded JSON array>`** — single multiplexed SSE connection. Each element is `{ id, topic, params }`; every `data:` line is a `HubEnvelope` `{ sub, data, event? }` for the matching subscription id (`src/tracker/dashboard/hono/routes/hub.ts`). **Legacy per-topic URLs** (`/events`, `/events/logs`, …) were removed (2026-05-08); no `registerEventRoutes` shim remains.
- **Topic registry** — `src/tracker/dashboard/hono/topics.ts` (`topicRegistry`, `parseSubsQuery`). **Emitters** register in `topics-emitters.ts`. Registered topics include: `entries` (payload includes enriched rows + backend-authoritative `wfCounts` + `failureCounts` from `computeFailureCounts`; rail badges consume `wfCounts` directly, and `failureCounts` drives `FailureBell` without an extra HTTP fetch for counts), `logs`, `sessions`, `runEvents`, `captureSessions`, `telegram`.
- **Rail / sidebar counts** — `wfCounts` are the contract for WorkflowRail badges. Both SQLite and JSONL fallback paths should convert rows to `TrackerEntry[]` and call `countSidebarRowsFromTrackerHistory(asTracker)` so counting dedupes latest rows, carries resolved EIDs, merges rows by employee, and collapses top-level queue surfaces/delegated batches. Do not prefilter latest rows with `resolved_prep = 0`; the shared helper/exclusion callback owns count exclusions. Resolved OCR prep rows that still render in the queue must stay counted.
- **Run events filtering** — events lacking `runId` (batch-scope `Session.launch`) are attributed via `workflowInstance` + per-run time window inside `filterEventsForRun` (`src/tracker/dashboard/session-state.ts`), **re-exported** from `src/tracker/dashboard.ts` for unit tests and hub code.

In dev, the React dashboard is served by Vite (port 5173) and proxies API calls to 3838. In prod, `dashboard --prod` serves `dist/dashboard/index.html` from the Hono dashboard server.

## JSONL File Format

Two file types per workflow per day under typed `.tracker/` subdirectories:

- **Entries**: `.tracker/rows/{workflow}-{YYYY-MM-DD}.jsonl` — one JSON line per tracker row emit
- **Logs**: `.tracker/logs/{workflow}-{YYYY-MM-DD}.jsonl` — one JSON line per `log.step/success/error/waiting` call (via `withLogContext`)
- **Sessions**: `.tracker/sessions/{YYYY-MM-DD}.jsonl` — session, daemon, browser, auth, and run-event lines

Debug-only side files live in the `.tracker/debug/` **subdirectory** (kept out of `.tracker/` top-level so they are not picked up as workflows):

- **Row lifecycle**: `.tracker/debug/row-lifecycle-{YYYY-MM-DD}.jsonl` (chronological transition trail, one line per state change) and `.tracker/debug/row-lifecycle-{YYYY-MM-DD}.json` (per-row consolidated lifecycle history). Both fully regenerated each sweep from the immutable JSONL source (see `row-lifecycle-debug.ts`). Not streamed, not consumed programmatically.

## `appendRow(filePath, columns, data)`

Appends a single row to an `.xlsx` file. Creates the file and/or worksheet if missing. Worksheet name is today's date as `YYYY-MM-DD`.

## Cleaning Old Tracker Files

- `cleanOldTrackerFiles(maxAgeDays, dir)` — deletes JSONL files whose filename date (YYYY-MM-DD) is older than `maxAgeDays`. Returns count deleted.
- `cleanOldScreenshots(maxAgeDays, dir)` — still available for **manual**/`npm run clean:tracker` use — deletes PNGs in `.tracker/screenshots/` whose filename-embedded ms timestamp is older than `maxAgeDays`. Not invoked by `GET /api/preflight` (the dashboard uses `sweepStaleRunScreenshots` on startup and interval instead — see below).
- `sweepStaleRunScreenshots(dir, screenshotsDir, maxAgeDays = 30)` (`src/tracker/state/screenshot-sweep.ts`) — **lifecycle-tied** screenshot cleanup. Two passes: (1) joins `runs` (where `terminal_at` is older than `maxAgeDays`) with `files` (`kind='screenshot'`) and deletes both the PNGs and the rows in one transaction, zeroing `runs.screenshot_count`; (2) file-age backstop that deletes orphan PNGs older than `maxAgeDays` (parsed from the ms-embedded filename, mtime fallback) whose path is not registered in `files`. Per-file delete failures are logged via `log.warn` and the sweep continues. No-op when the projection isn't ready. `runs.terminal_at` is stamped by `applyTrackerEntry` the first time a run reaches a terminal status (`done` / `failed` / `skipped`).
- `npm run clean:tracker` — CLI wrapper in `src/scripts/ops/clean-tracker.ts`. By default cleans tracker JSONL + screenshots. Accepts `--days N` (default 7), `--dir PATH`, `--screenshots-dir PATH`, `--no-screenshots`, `--screenshots-only`.
- **Dashboard cadence:** `createDashboardServer` runs three startup operations: a one-time `cleanOldTrackerFiles` prune at **30 days** (JSONL only), a single `sweepStaleRunScreenshots` pass, then a low-frequency `setInterval` (**6 hours**, `.unref()`) that re-runs the screenshot sweep so long-lived dashboards keep up. `GET /api/preflight` re-runs the JSONL prune at most once per **60s** (throttled in `hono/routes/base.ts`); it does NOT re-trigger the screenshot sweep. Pass `{ noClean: true }` or `--no-clean` to skip startup operations.
