# New Kronos (WFD) Module

Employee search automation for New Kronos (Workforce Dayforce). Much simpler than Old Kronos.

## Files

- `navigate.ts` — `searchEmployee(page, employeeId)`: opens Employee Search sidebar, finds dynamic iframe (`portal-frame-*`), searches by ID, returns `true` if found. `closeEmployeeSearch(page)`: closes sidebar if open. `clickGoToTimecard`, `switchToPreviousPayPeriod`, `setDateRange`, `getTimecardLastDate`, `checkTimecardDates`
- `selectors.ts` — **Selector registry** (Subsystem A). Grouped: `navbar`, `search`, `goToMenu`, `timecard`. Also exports `searchFrame(page)` helper for the dynamic `portal-frame-*` iframe lookup.
- `index.ts` — Barrel exports (includes `newKronosSelectors` registry barrel and `NEW_KRONOS_URL = "https://ucsd-sso.prd.mykronos.com/wfd/home"`)

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
