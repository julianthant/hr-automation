# new-kronos — Selector Lessons

Append-only record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. New entries go at the bottom.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-04-06 — Iframe name suffix changes per session

**Tried:** Hardcoding the Employee Search iframe name as `iframe[name="portal-frame-12345"]` after one playwright-cli snapshot.
**Failed because:** Dayforce regenerates the suffix every session (and sometimes within a session). The hardcoded name no longer matched on the next run.
**Fix:** Use a prefix selector via `page.frameLocator('iframe[name^="portal-frame-"]')`. Encapsulated in `searchFrame(page)` so callers don't repeat the lookup.
**Selector:** `searchFrame` in `selectors.ts`
**Tags:** iframe, frame, portal, dayforce, dynamic, prefix

## 2026-04-06 — `Go To` and Timecard items render in two places at once

**Tried:** A single `getByRole("menuitem", { name: /timecard/i })` against the page.
**Failed because:** Depending on session state, Dayforce surfaces the Go To menu and the Timecard item either inside the search frame, on the page, as plural ("Timecards"), or singular ("Timecard"). One locator missed half the cases.
**Fix:** Build a 6-deep `.or()` fallback chain spanning both frame- and page-scoped renderings plus plural/singular variants. Encoded in `goToMenu.timecardItem(page)`.
**Selector:** `goToMenu.goToButtonOnPage`, `goToMenu.goToButtonInFrame`, `goToMenu.timecardItem` in `selectors.ts`
**Tags:** go-to, timecard, menu, frame, page, fallback, plural

## 2026-04-06 — "There are no items to display." is the no-results probe

**Tried:** Polling the result rows count to detect an empty employee search.
**Failed because:** The grid renders header rows even when there are no data rows, and Dayforce sometimes shows a placeholder row briefly before clearing it. Counting rows races the placeholder.
**Fix:** Look for the literal text `"There are no items to display."` via `f.getByText(...)`. The string is stable across session states and only appears when the search yields zero employees.
**Selector:** `search.noResultsText` in `selectors.ts`
**Tags:** no-results, empty, search, employee, text, probe
