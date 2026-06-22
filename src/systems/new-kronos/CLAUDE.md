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
- `setDateRange` enters the custom-range dates via `typeMaskedDate` (digits only + readback verify, NOT `fill()` and NOT the literal `MM/DD/YYYY` string). The WFD inputs reject `fill()` AND auto-insert their own `/`, so typing the slashes races the mask and scrambles the value (e.g. `05/10/2026` → `6/05/1020` → `WFP-00889`). See LESSONS.md (OBS-006 / ISS-B05).
- `navigate.ts` calls `debugScreenshot` during timecard checks (`new-kronos-timecard-01-current` / `02-previous`) — not a blanket debug logger across the whole module

## Lessons Learned

- **2026-06-22: An employee-search timeout is a best-effort NOT-FOUND, not a thrown error (ISS-B04).** `searchEmployee` races the first-result checkbox (→ found) against the "no items to display" sentinel (→ not found) on a 15s timeout. When NEITHER surfaced (slow grid, or the no-results sentinel drifted), it `throw`ew `[New Kronos] Timed out waiting for search results` — a fatal-looking `✗` in the separations parallel block, even though New Kronos is a **best-effort** source (the separations handler falls back to the Kuali Last Day Worked when New Kronos returns no punch). Surfaced on ~6/9 docs of the live 8-worker separations run; non-fatal (docs completed) but noisy + slow. Fix: the race resolution moved into the exported `resolveSearchResult(checkboxVisible, noResultsVisible, employeeId)` helper, which on a both-waiters-rejected timeout returns `false` with a `log.warn` instead of throwing. The helper takes the two `waitFor` promises directly so it's unit-pinnable without a live page (`tests/unit/systems/new-kronos/navigate.test.ts`). **NOT fully fixed:** a genuinely-absent employee still waits the full 15s before `resolveSearchResult` returns false — the no-results sentinel (`noResultsText`) isn't matching fast (else the race would settle on it). Cutting that wait needs the live no-results message re-mapped into `noResultsText` — requires a live New Kronos page for a no-record employee.
