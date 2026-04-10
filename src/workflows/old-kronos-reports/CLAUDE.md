# Old Kronos Reports Workflow

Downloads Time Detail PDF reports from Old Kronos (UKG) for multiple employees in parallel, validates downloaded PDFs, and tracks status.

## Files

- `schema.ts` — Input schema: array of 5+ digit employee IDs, date range (default 1/01/2017–1/31/2026), worker count
- `config.ts` — Constants: `REPORTS_DIR` (`C:\Users\juzaw\Downloads\reports`), session dirs, default dates, screen dimensions for tiling
- `validate.ts` — PDF validation: checks file size > 0, searches for "No Data Returned" text, extracts name/ID from first page (regex: `/^(.+?)\s+ID:\s*(\d+)/`), verifies match against expected employee
- `tracker.ts` — Writes to `kronos-tracker.xlsx` (Excel-only, no `trackEvent` — JSONL events handled by `withTrackedWorkflow` in parallel.ts)
- `workflow.ts` — Worker execution: accepts `onStep`/`onData` callbacks from `withTrackedWorkflow` for dashboard progress. Launches N tiled browsers, fills credentials sequentially (5s gap), submits login with Duo one at a time, sets date range, processes employee queue. Steps: searching → extracting → downloading
- `parallel.ts` — Orchestration: loads `batch.yaml`, phases 1a–1b for launch/auth, phase 2 distributes employees across workers with queue-based work stealing, 3-strike error recovery, mutex-locked tracker/report navigation. Each employee wrapped in `withTrackedWorkflow` for dashboard tracking
- `index.ts` — Barrel exports

## Data Flow

```
batch.yaml (employee IDs)
  → Launch N tiled browsers (grid layout)
  → Phase 1a: Navigate to UKG, fill credentials (5s gap between browsers)
  → Phase 1b: Submit login + Duo MFA (one at a time, sequential)
  → Set date range on each authenticated browser
  → Phase 2: Queue-based distribution across N workers
    → Search employee by ID → click row → extract name
    → Go To Reports (mutex-locked to avoid UKG server conflicts)
    → Run Time Detail report → download PDF
    → Validate PDF (size, no-data check, name/ID match)
    → Update tracker
  → Cleanup session directories
```

## Parallel Execution Model

- **Tiling**: Dynamic grid — columns = `ceil(sqrt(N))`, rows = `ceil(N/cols)`, 20px margin + 80px offset
- **Work stealing**: Workers pull from shared queue; fast workers pick up slack
- **3-strike rule**: After 3 consecutive errors, worker stops (indicates dead browser)
- **Browser health check**: `page.evaluate()` before each task to detect dead sessions
- **Mutex locks**: Tracker writes AND report navigation are both mutex-locked

## Gotchas

- Session dirs: `C:\Users\juzaw\ukg_session_workerN` — cleaned up after all workers finish
- `reportLock` mutex: "Go To → Reports → run → download → back" must not interleave across workers (UKG server-side session conflicts)
- Credential filling via `ukgNavigateAndFill` returns `true | false | "already_logged_in"` (string, not boolean)
- PDF validation checks for substring `"No Data Returned"` (case-sensitive)
- PDF name extraction regex: `/^(.+?)\s+ID:\s*(\d+)/` expects "LastName, FirstName ID: 12345" format
- Empty downloads (0 KB) fail validation and are deleted
- `mkdirSync(REPORTS_DIR, { recursive: true })` — reports dir created if missing
- Phase 1 report status polling: first attempt may show stale "Complete" row from previous run — must skip it

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

*(Add entries here when Kronos report bugs are fixed — document root cause and fix so the same error never recurs)*
