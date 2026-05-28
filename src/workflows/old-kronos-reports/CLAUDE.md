# Old Kronos Reports Workflow

Downloads Time Detail PDF reports from Old Kronos (UKG) for multiple employees in parallel; validates downloaded PDFs; tracks status in an Excel tracker.

**Kernel-based but not currently operator-launched.** Declared via `defineWorkflow` in `workflow.ts` for kernel metadata/tests. A future dashboard-owned runner must initialize the pre-kernel runtime state (tracker mutex, report mutex, dates, reports dir, and per-worker `launchFn`) before calling `src/core/runWorkflowBatch`. The old `batch.yaml` adapter was removed; this workflow is not a public package script or dashboard run surface.

## What this workflow does

Given an explicit list of employee IDs from a future dashboard-owned runner, the kernel launches N worker Sessions (default 4 via `DEFAULT_WORKERS` in `config.ts`); each worker authenticates to UKG with its own Duo MFA, then the pool fans out employee IDs across workers, running queue-based Time Detail downloads with mutex-serialized Reports navigation and `ctx.retry`-wrapped flaky iframe loads. Each PDF is validated (size, no-data check, name/ID match) and a row is appended to the Excel tracker.

## Selector intelligence

This workflow touches one system: **old-kronos** (UKG, Genies iframe).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"genies iframe"`, `"time detail report"`, `"date range picker"`).
- Per-system lessons (read before re-mapping): [`src/systems/old-kronos/LESSONS.md`](../../systems/old-kronos/LESSONS.md)
- Per-system catalog (auto-generated): [`src/systems/old-kronos/SELECTORS.md`](../../systems/old-kronos/SELECTORS.md)

## Parallel execution model

- **Pool mode via kernel**: `runWorkflowPool` launches N Sessions (one Duo each), each with its own `Page` and `BrowserContext` via our `launchFn`. All Sessions pull from a single shared queue. `poolSize` is read from `RunOpts.poolSize ?? wf.config.batch.poolSize ?? 4`.
- **Per-worker sessionDir**: a future dashboard-owned runner must assign `${SESSION_DIR}_workerN` to each `launchFn` invocation so each persistent Playwright context keeps its own dir (UKG session state survives across runs, and the dir's lockfile prevents cross-worker races).
- **`reportMutex` (cross-worker)**: `ctx.retry` wraps `reportMutex.acquire() → clickGoToReports → handleReportsPage → goBackToMain`. UKG serializes report generation server-side; the mutex avoids two workers' downloads racing.
- **`trackerMutex` (cross-worker Excel write)**: `updateKronosTracker` is wrapped with `createLockedTracker` so concurrent Excel writes don't corrupt the xlsx file.
- **`ctx.retry` (per-worker)**: 2 attempts × 3s linear backoff around the Reports flow. Replaces the old inline 2-attempt loop.
- **Dead-worker handling**: the kernel's worker catches per-item errors, records `failed`, and moves to the next queue item. Consecutive-error shutoff is dropped (the kernel's per-item `withTrackedWorkflow` handles classification and isolation).

## Worker count

Default pool size: `4` (from `wf.config.batch.poolSize`). Programmatic callers can pass `poolSize` on `runWorkflowBatch`. To change the default, edit `DEFAULT_WORKERS` in `config.ts`.

## Gotchas

- **Session dirs**: `${PATHS.ukgSessionBase}_workerN` — cleaned up after all workers finish. If the process is SIGKILLed mid-run the dirs leak; the next run reassigns them.
- **`reportMutex` is cross-worker**: "Go To → Reports → run → download → back" must not interleave across workers (UKG server-side session conflicts).
- **Module-scoped runtime**: `setKronosRuntime` must be called before `runWorkflowBatch`; `clearKronosRuntime` belongs in finally. If the kernel is invoked directly without the runtime setup, the handler throws `Kronos runtime not initialized`.
- **`loginToUKG` in SystemConfig**: returns `boolean` — true ⇒ auth or already-logged-in; false ⇒ failure. Wrapped to throw on false so the kernel's retry loop in `Session.launch` can catch and retry.
- **`WeakSet<Page>` date-range guard**: the kernel's per-worker Session keeps the same `Page` object across items — we use a WeakSet to skip `setDateRange` after the first item per worker.
- **PDF validation** checks substring `"No Data Returned"` (case-sensitive).
- **PDF name extraction regex** `/^(.+?)\s+ID:\s*(\d+)/` expects `"LastName, FirstName ID: 12345"` format.
- **Empty downloads (0 KB)** fail validation and are deleted.
- **`mkdirSync(REPORTS_DIR, { recursive: true })`** — reports dir created if missing.
- **Phase 1 report status polling**: first attempt may show stale "Complete" row from previous run — must skip it (handled in `src/systems/old-kronos/reports.ts`).

## Retry safety

**Dashboard retry is not currently supported for this workflow.** kronos-reports is intentionally NOT in `WORKFLOW_LOADERS` — see the table in `src/workflows/CLAUDE.md`. A future dashboard-owned runner must set module-scoped runtime (`setKronosRuntime` with `trackerMutex`, `reportMutex`, date range, reports dir, tracker writer) BEFORE the kernel handler executes. The dashboard retry path goes through `enqueueFromHttp` → daemon claim → kernel `runOneItem`, which has no opportunity to call `setKronosRuntime`. A dashboard-issued retry would throw `Kronos runtime not initialized` from the handler's first action.

Contract 2 (Uniform Retry) does not gate this — there's no per-workflow opt-out. The fix lives in this workflow: decouple the per-run state from a module-scoped singleton (e.g. carry the mutexes/dates/tracker through `ctx.runtime` or via a workflow-local registry keyed by `instance`) so the handler can be invoked from a real dashboard run surface.

## Lessons Learned

- **2026-05-16: Deleted `runKronosForEmployee` + removed `DEFAULT_START_DATE`/`DEFAULT_END_DATE` re-exports from `workflow.ts`.** `runKronosForEmployee` was a pre-migration helper preserved for "external callers" — grep confirmed zero callers outside the module. `validateAndRecordTracker` (the shared post-download validation helper) was NOT deleted — it is still used by the kernel handler's `downloading` step. The date constant re-exports through `workflow.ts` were dead.
- **2026-05-25: `npm run kronos` and the batch-file adapter were removed.** Old Kronos `batch.yaml` is no longer a valid operator launch path. Keep any future start path dashboard-owned; do not reintroduce `runParallelKronos`, `BATCH_FILE`, or checked-in batch input files.
- **2026-04-17: Migrated to kernel (pool mode).** `runParallelKronos` became an adapter over `runWorkflowBatch(kronosReportsWorkflow, items, { poolSize, launchFn, onPreEmitPending })`. Per-worker sessionDir is handled via `opts.launchFn` injection — the kernel's public surface is unchanged. Module-scoped `kronosRuntime` carries the mutexes + date range + reports dir because Zod can't validate `Mutex` instances. Dashboard metadata auto-registers from `defineWorkflow` (the obsolete standalone registration call was removed from `index.ts`). `ctx.retry` replaces the old inline 2-attempt Reports-nav retry. Workflow name stays `"kronos-reports"` (the directory is `old-kronos-reports` but the workflow name matches existing JSONL filenames). **Live-run pending user verification** — 4 parallel Duo approvals can't be exercised this session; only dry-runs + tests validate the migration. Don't reintroduce raw `launchBrowser`, `withTrackedWorkflow`, or `withLogContext` in the workflow — those live in the kernel now.
- **2026-04-17 / 2026-05-16: Worker count configuration.** `RunOpts.poolSize` lets callers override the workflow's `batch.poolSize` default. `runWorkflowPool` reads `opts.poolSize ?? wf.config.batch?.poolSize ?? 4`. Covered by tests in `tests/unit/core/pool.test.ts` + `tests/unit/workflows/old-kronos-reports/workflow.test.ts`.
