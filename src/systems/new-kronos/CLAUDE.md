# New Kronos (WFD) Module

Employee search automation for New Kronos (Workforce Dayforce). Much simpler than Old Kronos.

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review the top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. If [`LESSONS.md`](./LESSONS.md) has a relevant entry, read it first to avoid repeating a known failure.
4. Otherwise, map a new selector following the conventions in [`selectors.ts`](./selectors.ts):
   a. Add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`).
   b. Run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).
   c. If you discovered a non-obvious failure mode along the way, append a lesson to [`LESSONS.md`](./LESSONS.md) following its template.
   d. Verify the inline-selector test still passes: `npx vitest run tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the auto-generated catalog of every selector this module exports.

Example intents for `npm run selector:search`: [`common-intents.txt`](./common-intents.txt).

## Separation timecard parsing

`getSeparationTimecardData(page)` (in `navigate.ts`, re-exported from `index.ts` with its `SeparationTimecardData` type) reads the open timecard grid and returns:

- `lastPunchDate: string | null` — MM/DD/YYYY, the latest day carrying an In/Out punch (the separations workflow uses this as the **Last Day Worked**, overriding Kuali).
- `sickDates: string[]` — MM/DD/YYYY, chronological, the `Sick - Hourly` days.
- `holidayDates: string[]` — MM/DD/YYYY, chronological, the `Holiday - Hourly` days.

Call it AFTER `clickGoToTimecard` + `setDateRange` so the grid shows the right window. Separations consumes `lastPunchDate` for the LDW and `sickDates` / `holidayDates` for the termination-comment clause only (they never change a date). See `src/workflows/separations/CLAUDE.md` "Date model".

## Gotchas

- Uses modern `getByRole()` API (more maintainable than CSS selectors)
- Dynamic iframe name: `iframe[name^="portal-frame-"]` (suffix changes per session)
- Checks for "There are no items to display." message to detect no results
- Less defensive than Old Kronos — fewer fallback strategies, lets errors propagate
- `navigate.ts` calls `debugScreenshot` during timecard checks (`new-kronos-timecard-01-current` / `02-previous`) — not a blanket debug logger across the whole module

## Lessons Learned

*(Add entries here when New Kronos bugs are fixed — document root cause and fix so the same error never recurs)*
