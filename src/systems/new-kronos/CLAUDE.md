# New Kronos (WFD) Module

Employee search automation for New Kronos (Workforce Dayforce). Much simpler than Old Kronos.

## Files

- `navigate.ts` — `searchEmployee(page, employeeId)`: opens Employee Search sidebar, finds dynamic iframe (`portal-frame-*`), searches by ID, returns `true` if found. `closeEmployeeSearch(page)`: closes sidebar if open. `clickGoToTimecard`, `switchToPreviousPayPeriod`, `setDateRange`, `getTimecardLastDate`, `checkTimecardDates`
- `selectors.ts` — **Selector registry** (Subsystem A). Grouped: `navbar`, `search`, `goToMenu`, `timecard`. Also exports `searchFrame(page)` helper for the dynamic `portal-frame-*` iframe lookup.
- `index.ts` — Barrel exports (includes `newKronosSelectors` registry barrel and `NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home"`)

## Gotchas

- Uses modern `getByRole()` API (more maintainable than CSS selectors)
- Dynamic iframe name: `iframe[name^="portal-frame-"]` (suffix changes per session)
- Checks for "There are no items to display." message to detect no results
- Less defensive than Old Kronos — fewer fallback strategies, lets errors propagate
- No screenshot/debug logging

## Verified Selectors

All Playwright selectors for this system live in [`selectors.ts`](./selectors.ts).
The `goToMenu.timecardItem(page)` entry uses a 6-deep `.or()` fallback chain
(covers both frame-scoped and page-scoped renderings plus "Timecards" plural
/ "Timecard" singular variants) — preserved verbatim from the prior inline
implementation.

**Do not add inline selectors outside `selectors.ts`.** The
[`tests/unit/systems/inline-selectors.test.ts`](../../../tests/unit/systems/inline-selectors.test.ts)
guard will reject PRs that do.

## Lessons Learned

*(Add entries here when New Kronos bugs are fixed — document root cause and fix so the same error never recurs)*
