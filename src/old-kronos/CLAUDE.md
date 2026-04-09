# Old Kronos (UKG) Module

Core automation for Old UKG Kronos: employee search, navigation, modal handling, date range setting, and Time Detail report download.

## Files

- `navigate.ts` — Employee grid interaction: `getGeniesIframe` (multi-strategy frame finder), `dismissModal`, `searchEmployee`, `clickEmployeeRow`, `getEmployeeName`, `setDateRange` (digit-by-digit date typing), `clickGoToReports`, `goBackToMain`
- `reports.ts` — Report generation and download: `handleReportsPage` (runs report in nested frames), `waitForReportAndDownload` (status polling + dual-track download), helpers: `clickInFrames`, `jsClickText`, `clickRunReport`
- `types.ts` — `UKGError` custom error class with optional `step` property
- `index.ts` — Barrel exports

## Frame Hierarchy

UKG uses deeply nested iframes:
- Main content: `widgetFrame804` (or any `widgetFrame*`) — found via `getGeniesIframe(page)`
- Reports page: three frames:
  - `khtmlReportList` — nav tree (Timecard → Time Detail)
  - `khtmlReportWorkspace` — report options (date range, output format)
  - `khtmlReportingContentIframe` — report content and Run Report button

## `getGeniesIframe` Strategy

1. **SSO re-auth check**: Detects `#ssousername` or `input[name="j_username"]` on page — if found, calls `loginToUKG(page)` to re-authenticate (handles session expiry after page refresh)
2. Try `widgetFrame804` by exact name
3. Check for "network change detected" error in iframe — reloads page if found
4. Fallback: any frame with "genies" in URL
5. Fallback: any frame starting with `widgetFrame`
6. Retry: 15 attempts with 2s waits
7. Last resort: full page reload and retry

## Download Strategy (Dual-Track)

1. **Primary**: Playwright download event listener on page and context
2. **Fallback**: Filesystem diff — snapshots `C:\Users\juzaw\Downloads` and `reportsDir` before/after clicking View Report, finds new `.pdf` files

## Gotchas

- `dismissModal()` must be called before most interactions (UKG modals pop up unexpectedly)
- Date inputs require digit-by-digit typing: triple-click to select, Delete, Home, then type each digit with 100ms delays
- Report status polling: Phase 1 finds Running/Waiting row, Phase 2 polls that row by TR ID until Complete
- First poll attempt may show stale "Complete" row from previous run — must skip and keep refreshing
- `reportLock` mutex serializes report navigation across parallel workers
- Frame names may vary — multiple fallback strategies everywhere
- JS evaluation (`clickInFrames`, `jsClickText`) used extensively because Playwright selectors are unreliable in nested frames
- Hardcoded download path: `C:\Users\juzaw\Downloads` for filesystem fallback
- `mkdirSync(".auth/")` called at module level for screenshot directory
- **Session expiry on refresh**: If a page refresh causes redirect to SSO login, `getGeniesIframe` detects this and calls `loginToUKG()` to re-authenticate automatically (requires Duo MFA approval)
