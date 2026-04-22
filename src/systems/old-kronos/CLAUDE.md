# Old Kronos (UKG) Module

Core automation for Old UKG Kronos: employee search, navigation, modal handling, date range setting, and Time Detail report download.

## Files

- `navigate.ts` — Employee grid interaction: `getGeniesIframe` (multi-strategy frame finder), `dismissModal` (clicks OK/Close inside iframe modals — distinct from UCPath's CSS-mask hide helper), `searchEmployee`, `clickEmployeeRow`, `getEmployeeName`, `setDateRange` (digit-by-digit date typing), `clickGoToReports`, `goBackToMain`
- `reports.ts` — Report generation and download: `handleReportsPage` (runs report in nested frames), `waitForReportAndDownload` (status polling + dual-track download), helpers: `clickInFrames`, `jsClickText`, `clickRunReport`
- `selectors.ts` — **Selector registry** (Subsystem A). Grouped: `ssoProbe`, `employeeGrid`, `modalDismiss`, `dateRange`, `goToMenu`, `timecard`, `workspace`, `reportsPage`. Includes string selector arrays (`runReportSelectors`, `viewReportSelectors`, `checkStatusSelectors`, `refreshStatusSelectors`) passed to multi-anchor click helpers.
- `types.ts` — `UKGError` custom error class with optional `step` property
- `index.ts` — Barrel exports (includes `oldKronosSelectors` registry barrel)

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review the top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. If [`LESSONS.md`](./LESSONS.md) has a relevant entry, read it first to avoid repeating a known failure.
4. Otherwise, map a new selector following the conventions in [`selectors.ts`](./selectors.ts):
   a. Add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`).
   b. Run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).
   c. If you discovered a non-obvious failure mode along the way, append a lesson to [`LESSONS.md`](./LESSONS.md) following its template.
   d. Verify the inline-selector test still passes: `tsx --test tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the auto-generated catalog of every selector this module exports.

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

## Verified Selectors

All Playwright selectors for this system live in [`selectors.ts`](./selectors.ts),
grouped by area. Selectors that target UKG's multiple alternate UI variants
(Calendar button, Apply button in the date range dialog) use 2-deep `.or()`
fallback chains. The `reportsPage.*Selectors` arrays are CSS-string arrays
passed to the multi-frame click helpers in `reports.ts` — they carry their
verification date on the `as const` declaration.

**Do not add inline selectors outside `selectors.ts`.** The
[`tests/unit/systems/inline-selectors.test.ts`](../../../tests/unit/systems/inline-selectors.test.ts)
guard will reject PRs that do. The `reports.ts` "enumerate unlabeled
`<select>` dropdowns and filter by surrounding row text" pattern is
whitelisted via end-of-line `// allow-inline-selector` comments — no clean
factory captures it.

## Lessons Learned

*(Add entries here when Old Kronos/UKG bugs are fixed — document root cause and fix so the same error never recurs)*
