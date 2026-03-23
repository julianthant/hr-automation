# Kronos UKG Report Download Integration

## Summary
Port the Python kronos `ukg_reports.py` script into the existing TypeScript HR automation codebase. Downloads "Time Detail" PDF reports from UKG (ucsd.kronos.net) for batches of employee IDs.

## Decisions
- **Batch file**: YAML (like onboarding's `batch.yaml`)
- **Tracking**: Excel with daily tabs via shared `src/tracker/` module
- **Execution pattern**: Simple sequential pipeline (no ActionPlan — this is a download pipeline, not a form transaction)
- **Auth**: `loginToUKG()` added to `src/auth/login.ts` (same SSO pattern)
- **Browser**: Persistent sessions via optional `sessionDir` in `src/browser/launch.ts`
- **UKG module**: New `src/ukg/` module (mirrors `src/ucpath/`)

## Architecture

```
src/
  auth/login.ts           # + loginToUKG()
  browser/launch.ts       # + optional sessionDir for persistent sessions
  config.ts               # + UKG_URL
  ukg/                    # NEW — UKG system navigation
    navigate.ts           # iframe access, employee search, date range, Go To
    reports.ts            # report selection, run, poll, download
    types.ts              # UKG-specific types/errors
    index.ts              # barrel
  workflows/
    kronos/               # NEW — report download workflow
      config.ts           # REPORTS_DIR, date defaults, worker count
      schema.ts           # Zod schema (employeeIds, dateRange)
      tracker.ts          # tracker row + update
      validate.ts         # PDF validation
      parallel.ts         # worker pool
      workflow.ts         # runKronos() orchestration
      batch.yaml          # employee ID list
      kronos-tracker.xlsx # tracker file
      index.ts            # barrel
```

## Data Flow

```
batch.yaml (employee IDs)
  → Launch browser (persistent session)
  → Login to UKG SSO (src/auth/loginToUKG)
  → Set date range on dashboard
  → Per employee (parallel workers):
    → Search employee by ID → get name
    → Click row → Go To → Reports
    → Expand Timecard → Time Detail
    → Set Actual/Adjusted, PDF format
    → Run Report → poll completion
    → Download PDF → validate
    → Navigate back to dashboard
    → Update kronos-tracker.xlsx
```

## Shared Module Changes

### `src/browser/launch.ts`
- Add `sessionDir?: string` to launch options
- When provided, use `launchPersistentContext()` instead of fresh context

### `src/auth/login.ts`
- Add `loginToUKG(page)` — same SSO flow, UKG URL, wait for "Manage My Department"

### `src/config.ts`
- Add `UKG_URL` constant

## UKG Module

### `navigate.ts`
- `getGeniesIframe(page)` — locate `widgetFrame804`
- `setDateRange(page, iframe, startDate, endDate)` — calendar dialog
- `searchEmployee(iframe, employeeId)` — `#searchQuery` + `#quickfindsearch_btn`
- `getEmployeeName(iframe)` — extract from grid row
- `clickEmployeeRow(iframe)` — `#row0genieGrid` with fallbacks
- `clickGoToReports(iframe)` — dropdown navigation
- `dismissModal(page)` — close overlays

### `reports.ts`
- `findFrameByName(page, name)` — search nested frames
- `selectTimeDetailReport(frame)` — expand Timecard, click Time Detail
- `configureReport(frame)` — set Actual/Adjusted, PDF format
- `clickRunReport(frame)` — multiple selector strategies
- `waitForReportAndDownload(page, employeeId, employeeName, reportsDir)` — two-phase polling + download
- `goBackToMain(page)` — navigate to dashboard

## Key Selectors (from original script)
- Main iframe: `widgetFrame804`
- Grid row: `#row0genieGrid`
- Search: `#searchQuery`, `#quickfindsearch_btn`
- Calendar: `button:has(i.icon-k-calendar)`
- Date inputs: `div.timeframeSelection input.jqx-input-content`
- Apply: `div.timeframeSelection button[title='Apply']`
- Report frames: `khtmlReportList`, `khtmlReportWorkspace`, `khtmlReportingContentIframe`
- Status: `span[id^="statusValue"]`

## CLI
- `npm run kronos` — single run with all employees from batch.yaml
- `npm run kronos -- --workers 4` — parallel with N workers
- `npm run kronos -- --dry-run` — preview employee list, no downloads
