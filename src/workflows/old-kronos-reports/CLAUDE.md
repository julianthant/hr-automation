# Old Kronos Reports Workflow

Downloads Time Detail PDF reports from Old Kronos (UKG) for multiple employees in parallel; validates downloaded PDFs; tracks status in an Excel tracker.

> **Legacy — NOT kernel-migrated.** `parallel.ts` launches N tiled browsers, manages a queue-based work-stealing pool, and wraps each employee in `withTrackedWorkflow` directly. `index.ts` registers dashboard metadata via `defineDashboardMetadata`. The kernel's `pool` mode launches one Session per worker with one Duo each — UKG already does session persistence, so the tradeoff is acceptable, but the parallel.ts shape predates the kernel and hasn't been migrated.

## What this workflow does

Given a `batch.yaml` with employee IDs, launches N worker browsers (default 4), auths each sequentially with Duo, runs queue-based Time Detail downloads with 3-strike error recovery and validates each PDF.

## Files

- `schema.ts` — Input schema: array of 5+ digit employee IDs, date range (default 1/01/2017–1/31/2026), worker count
- `config.ts` — Constants: `REPORTS_DIR` (`C:\Users\juzaw\Downloads\reports`), session dirs, default dates, tiling dimensions
- `validate.ts` — PDF validation: non-zero size, "No Data Returned" substring, name/ID extraction (regex `/^(.+?)\s+ID:\s*(\d+)/`), expected-employee match
- `tracker.ts` — `kronos-tracker.xlsx` writer (Excel-only; JSONL events handled by `withTrackedWorkflow` in `parallel.ts`)
- `workflow.ts` — Per-worker execution body. Accepts `onStep`/`onData` callbacks from `withTrackedWorkflow` for dashboard progress. Steps: `searching → extracting → downloading`
- `parallel.ts` — Orchestration: loads `batch.yaml`, phases 1a–1b for launch/auth, phase 2 distributes employees across N workers with queue-based work stealing, 3-strike error recovery, mutex-locked tracker writes, mutex-locked report navigation. Each employee wrapped in `withTrackedWorkflow` for dashboard tracking
- `index.ts` — Barrel exports + `defineDashboardMetadata` call

## Data Flow

```
batch.yaml (employee IDs)
  → Launch N tiled browsers (grid layout, ceil(sqrt(N)) cols)
  → Phase 1a: Navigate to UKG, fill credentials (5s gap between browsers)
  → Phase 1b: Submit login + Duo MFA (one at a time, sequential)
  → Set date range on each authenticated browser
  → Phase 2: Queue-based distribution across N workers
    → Search employee by ID → click row → extract name
    → Go To Reports (mutex-locked to avoid UKG server-side session conflicts)
    → Run Time Detail report → download PDF
    → Validate PDF (size, no-data check, name/ID match)
    → Update tracker
  → Cleanup session directories
```

## Parallel execution model

- **Tiling**: Dynamic grid — `cols = ceil(sqrt(N))`, `rows = ceil(N/cols)`, 20px margin + 80px offset
- **Work stealing**: Workers pull from shared queue; fast workers pick up slack
- **3-strike rule**: After 3 consecutive errors, worker stops (indicates dead browser)
- **Browser health check**: `page.evaluate()` before each task to detect dead sessions
- **Mutex locks**: tracker writes AND report navigation are mutex-locked

## Gotchas

- **Session dirs**: `C:\Users\juzaw\ukg_session_workerN` — cleaned up after all workers finish
- **`reportLock` mutex**: "Go To → Reports → run → download → back" must not interleave across workers (UKG server-side session conflicts)
- **`ukgNavigateAndFill` return type**: `true | false | "already_logged_in"` (string for persistent-session detection)
- PDF validation checks for substring `"No Data Returned"` (case-sensitive)
- PDF name extraction regex: `/^(.+?)\s+ID:\s*(\d+)/` expects `"LastName, FirstName ID: 12345"` format
- Empty downloads (0 KB) fail validation and are deleted
- `mkdirSync(REPORTS_DIR, { recursive: true })` — reports dir created if missing
- **Phase 1 report status polling**: first attempt may show stale "Complete" row from previous run — must skip it

## Verified Selectors

UKG selectors live in `src/systems/old-kronos/selectors.ts`. This workflow uses them through `handleReportsPage`, `waitForReportAndDownload`, and the search helpers in that system module.

## Lessons Learned

*(Add entries here when Kronos report bugs are fixed — document root cause and fix so the same error never recurs)*
