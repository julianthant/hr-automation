# Old Kronos Reports Workflow

Downloads Time Detail PDF reports from Old Kronos (UKG) for multiple employees in parallel; validates downloaded PDFs; tracks status in an Excel tracker.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflowBatch` (pool mode, `preEmitPending: true`, `poolSize: 4`). The kernel owns browser launch, UKG auth, per-employee tracker entries, SIGINT cleanup, and worker-queue fan-out. The CLI adapter `runParallelKronos` in `parallel.ts` owns the pre-kernel phases: batch YAML load, mutex setup, and a `launchFn` that assigns a unique `ukg_session_workerN` sessionDir per worker (UKG uses Playwright persistent contexts — workers sharing one sessionDir would collide on the lock).

## What this workflow does

Given a `batch.yaml` with employee IDs, the kernel launches N worker Sessions (default 4, overridable via `--workers N` → `RunOpts.poolSize`); each worker authenticates to UKG with its own Duo MFA, then the pool fans out employee IDs across workers, running queue-based Time Detail downloads with mutex-serialized Reports navigation and `ctx.retry`-wrapped flaky iframe loads. Each PDF is validated (size, no-data check, name/ID match) and a row is appended to the Excel tracker.

## Selector intelligence

This workflow touches one system: **old-kronos** (UKG, Genies iframe).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"genies iframe"`, `"time detail report"`, `"date range picker"`).
- Per-system lessons (read before re-mapping): [`src/systems/old-kronos/LESSONS.md`](../../systems/old-kronos/LESSONS.md)
- Per-system catalog (auto-generated): [`src/systems/old-kronos/SELECTORS.md`](../../systems/old-kronos/SELECTORS.md)

## Files

- `schema.ts` — Input schema: `EmployeeIdSchema` (5+ digit numeric string). `KronosItemSchema` wraps it as the kernel's per-item TData.
- `config.ts` — Constants: `REPORTS_DIR` (`PATHS.reportsDir`), `SESSION_DIR` (base for per-worker dirs), default dates, `DEFAULT_WORKERS`, `BATCH_FILE`, `TRACKER_PATH`.
- `validate.ts` — PDF validation: non-zero size, "No Data Returned" substring, name/ID extraction (regex `/^(.+?)\s+ID:\s*(\d+)/`), expected-employee match.
- `tracker.ts` — `kronos-tracker.xlsx` writer (Excel-only; JSONL events handled by the kernel). Preserved per `src/workflows/CLAUDE.md` grandfather clause.
- `workflow.ts` — Kernel definition (`kronosReportsWorkflow`). Handler runs `searching → extracting → downloading` per employee. Module-scoped runtime (`setKronosRuntime` / `clearKronosRuntime`) holds the tracker mutex, report-lock mutex, date range, and reports dir — they can't ride on Zod-validated TData. A `WeakSet<Page>` tracks which worker pages have had the date range set so we only `setDateRange` once per worker. Also exports a `runKronosForEmployee` helper that preserves the pre-migration per-employee control flow for external callers / debugging (not invoked by the kernel handler).
- `parallel.ts` — CLI adapter (`runParallelKronos`). Loads batch YAML, initializes module runtime, builds a per-worker `launchFn` closure that increments a counter and assigns `${SESSION_DIR}_workerN` to each worker's Playwright persistent context, delegates to `runWorkflowBatch(kronosReportsWorkflow, items, { poolSize, launchFn, onPreEmitPending, deriveItemId })`, and cleans up session dirs after. `loadBatchFile` is exported for testing.
- `index.ts` — Barrel exports. **No `defineDashboardMetadata` call** — `defineWorkflow` auto-registers the dashboard metadata from the kernel definition.
- `batch.yaml` — Input list of employee IDs (5+ digit numeric strings, one per line).

## Kernel Config

| Field | Value |
|-------|-------|
| `name` | `"kronos-reports"` — matches the pre-migration dashboard registration + JSONL filename prefix. NOT `"old-kronos-reports"` (the directory name). |
| `label` | `"Kronos Reports"` |
| `systems` | `[{ id: "old-kronos", login: loginToUKG-wrapped }]` — sessionDir NOT set on the SystemConfig; parallel.ts injects it per-worker via `opts.launchFn` |
| `steps` | `["searching", "extracting", "downloading"] as const` |
| `schema` | `KronosItemSchema = z.object({ employeeId })` — each queue entry |
| `tiling` | `"single"` — each worker Session has one browser |
| `authChain` | `"sequential"` — one system per worker, sequential by definition |
| `batch` | `{ mode: "pool", poolSize: 4, preEmitPending: true }` — runtime `poolSize` override from `--workers N` wins |
| `detailFields` | `[{ key: "name", label: "Employee" }, { key: "id", label: "ID" }]` |
| `getName` | `(d) => d.name ?? ""` |
| `getId` | `(d) => d.id ?? ""` |

## Data Flow

```
CLI: npm run kronos [-- --start-date ... --end-date ...]
  → runParallelKronos (CLI adapter)
    → loadBatchFile (Zod validate each ID)
    → else:
      → mkdirSync REPORTS_DIR
      → setKronosRuntime({ trackerMutex, reportMutex, startDate, endDate, reportsDir, writeTracker })
      → runWorkflowBatch(kronosReportsWorkflow, items, {
          poolSize: actualWorkers,
          launchFn: per-worker counter closure → ukg_session_workerN sessionDir,
          deriveItemId: item => item.employeeId,
          onPreEmitPending: (item, runId) => trackEvent(pending, { id: employeeId }),
        })
        → Kernel launches N Sessions in parallel; each worker auths to UKG (Duo ×N).
        → Workers pull items from a shared queue until empty.
        → For each item:
          - Kernel emits `pending` via onPreEmitPending (already written above)
          - withTrackedWorkflow wraps the handler, reuses pre-emitted runId
          - Handler: await ctx.page → ensureDateRangeSet (first item on this worker)
          - Step "searching" → searchEmployee + row-exists check → early return + tracker "Done" on no-match
          - Step "extracting" → clickEmployeeRow → updateData({ name })
          - Step "downloading" → ctx.retry(reportMutex.acquire → clickGoToReports → handleReportsPage → goBackToMain)
            → validateAndRecordTracker on success / "Failed" row on exhausted attempts
      → clearKronosRuntime + rm -rf per-worker session dirs
      → Batch result summary: "N/M succeeded, K failed"
```

## Parallel execution model

- **Pool mode via kernel**: `runWorkflowPool` launches N Sessions (one Duo each), each with its own `Page` and `BrowserContext` via our `launchFn`. All Sessions pull from a single shared queue. `poolSize` is read from `RunOpts.poolSize ?? wf.config.batch.poolSize ?? 4`.
- **Per-worker sessionDir**: a counter closure in `runParallelKronos` assigns `${SESSION_DIR}_workerN` to each `launchFn` invocation so each persistent Playwright context keeps its own dir (UKG session state survives across runs, and the dir's lockfile prevents cross-worker races).
- **`reportMutex` (cross-worker)**: `ctx.retry` wraps `reportMutex.acquire() → clickGoToReports → handleReportsPage → goBackToMain`. UKG serializes report generation server-side; the mutex avoids two workers' downloads racing.
- **`trackerMutex` (cross-worker Excel write)**: `updateKronosTracker` is wrapped with `createLockedTracker` so concurrent Excel writes don't corrupt the xlsx file.
- **`ctx.retry` (per-worker)**: 2 attempts × 3s linear backoff around the Reports flow. Replaces the old inline 2-attempt loop.
- **Dead-worker handling**: the kernel's worker catches per-item errors, records `failed`, and moves to the next queue item. Consecutive-error shutoff is dropped (the kernel's per-item `withTrackedWorkflow` handles classification and isolation).

## Worker count

Default pool size: `4` (from `wf.config.batch.poolSize`). `RunOpts.poolSize` can override it if `runWorkflowBatch` is called programmatically. The `--workers N` CLI flag was removed 2026-04-28; to change the default, edit `DEFAULT_WORKERS` in `config.ts`.

## Gotchas

- **Session dirs**: `${PATHS.ukgSessionBase}_workerN` — cleaned up after all workers finish. If the process is SIGKILLed mid-run the dirs leak; the next run reassigns them.
- **`reportMutex` is cross-worker**: "Go To → Reports → run → download → back" must not interleave across workers (UKG server-side session conflicts).
- **Module-scoped runtime**: `setKronosRuntime` is called by the CLI adapter before `runWorkflowBatch`; `clearKronosRuntime` in finally. If the kernel were invoked directly (tests, future sub-runner) without the adapter, the handler would throw `Kronos runtime not initialized`.
- **`loginToUKG` in SystemConfig**: returns `boolean` — true ⇒ auth or already-logged-in; false ⇒ failure. Wrapped to throw on false so the kernel's retry loop in `Session.launch` can catch and retry.
- **`WeakSet<Page>` date-range guard**: the kernel's per-worker Session keeps the same `Page` object across items — we use a WeakSet to skip `setDateRange` after the first item per worker.
- **PDF validation** checks substring `"No Data Returned"` (case-sensitive).
- **PDF name extraction regex** `/^(.+?)\s+ID:\s*(\d+)/` expects `"LastName, FirstName ID: 12345"` format.
- **Empty downloads (0 KB)** fail validation and are deleted.
- **`mkdirSync(REPORTS_DIR, { recursive: true })`** — reports dir created if missing.
- **Phase 1 report status polling**: first attempt may show stale "Complete" row from previous run — must skip it (handled in `src/systems/old-kronos/reports.ts`).

## Verified Selectors

UKG selectors live in `src/systems/old-kronos/selectors.ts`. This workflow uses them through `handleReportsPage`, `waitForReportAndDownload`, and the search helpers in that system module.

## Lessons Learned

- **2026-04-17: Migrated to kernel (pool mode).** `runParallelKronos` is now a CLI adapter over `runWorkflowBatch(kronosReportsWorkflow, items, { poolSize, launchFn, onPreEmitPending })`. Per-worker sessionDir is handled via `opts.launchFn` injection — the kernel's public surface is unchanged. Module-scoped `kronosRuntime` carries the mutexes + date range + reports dir because Zod can't validate `Mutex` instances. Dashboard metadata auto-registers from `defineWorkflow` (dropped the `defineDashboardMetadata` call from index.ts). `ctx.retry` replaces the old inline 2-attempt Reports-nav retry. Workflow name stays `"kronos-reports"` (the directory is `old-kronos-reports` but the workflow name matches existing JSONL filenames). **Live-run pending user verification** — 4 parallel Duo approvals can't be exercised this session; only dry-runs + tests validate the migration. Don't reintroduce raw `launchBrowser` / `withTrackedWorkflow` / `withLogContext` in the workflow or CLI adapter — those live in the kernel now.
- **2026-04-17: `RunOpts.poolSize` runtime override** — added a kernel-level `poolSize?: number` on `RunOpts` so `npm run kronos -- --workers N` can override the workflow's `batch.poolSize` default without redefining the workflow. `runWorkflowPool` reads `opts.poolSize ?? wf.config.batch?.poolSize ?? 4`. Covered by two tests in `tests/unit/core/pool.test.ts` + two workflow-level tests in `tests/unit/workflows/old-kronos-reports/workflow.test.ts`.
