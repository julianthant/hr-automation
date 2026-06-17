# new-kronos — Selector Lessons

Structured record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. Before adding an entry, search for related guidance and update/merge stale or contradictory lessons; add a new bottom entry only for a genuinely new failure mode.

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

## 2026-06-17 — WFD loading overlay intercepts Employee Search button click

**Tried:** Clicking `navbar.employeeSearchButton(page)` immediately after `closeEmployeeSearch` + 1s wait.
**Failed because:** Dayforce (WFD) renders a full-page loading overlay after certain navigation and post-action states. When the overlay is visible it intercepts pointer events and the click fails with "Another element intercepted the click (modal/overlay)" (`classifyPlaywrightError` kind: `timeout-intercepted`). The overlay is NOT a PeopleSoft `#pt_modalMask` — do NOT use `dismissPeopleSoftModalMask` here (that targets `#pt_modalMask` / `.ptModalMask`, which are PeopleSoft-only and absent in Dayforce).
**Fix:** Before the employee search button click, call `loadingOverlay.overlay(page).waitFor({ state: "hidden", timeout: 5_000 })` wrapped in a try/catch so a missing or non-matching selector degrades gracefully (the wait resolves immediately). The overlay selector (`loadingOverlay.overlay` in `selectors.ts`) uses `.wfd-loading-overlay, [data-wfd-loading], .wfd-modal-overlay, .wfd-busy-indicator` — needs live verification to confirm which class the live Dayforce build uses. // NEEDS LIVE RE-VERIFY 2026-06-17
**Selector:** `loadingOverlay.overlay` in `selectors.ts` (added 2026-06-17)
**Tags:** loading, overlay, intercept, click, employee-search, wfd, dayforce, pointer-events

## 2026-04-06 — "There are no items to display." is the no-results probe

**Tried:** Polling the result rows count to detect an empty employee search.
**Failed because:** The grid renders header rows even when there are no data rows, and Dayforce sometimes shows a placeholder row briefly before clearing it. Counting rows races the placeholder.
**Fix:** Look for the literal text `"There are no items to display."` via `f.getByText(...)`. The string is stable across session states and only appears when the search yields zero employees.
**Selector:** `search.noResultsText` in `selectors.ts`
**Tags:** no-results, empty, search, employee, text, probe

## 2026-06-17 — Timecard audit screenshot must be a CENTERED VIEWPORT shot, not fullPage

**Tried:** Relying on `scrollTimecardToDate` (which scrolled the target row to `block:"start"`) but taking NO screenshot after it — and elsewhere using the generic all-systems `ctx.screenshot` (`fullPage`) to record the latest worked date for the separations audit.
**Failed because:** The New Kronos timecard is a VIRTUAL-SCROLL grid (`.ui-grid-viewport`) — `fullPage` only captures the rows currently rendered in the DOM, missing off-screen dates. And `block:"start"` put the target row at the top edge with no later-date context below visible in a clamped viewport. No screenshot was emitted at all after the scroll, so the positioning was wasted.
**Fix:** Changed `scrollTimecardToDate` to `scrollIntoView({ block: "center" })` so the chosen day sits mid-viewport with neighbours above and below, then take a VIEWPORT-only shot right after it in the workflow: `ctx.screenshot({ systems:['new-kronos'], centerSelector:'.ui-grid-viewport', label:'new-kronos-last-worked-date' })`. `centerSelector` (kernel `Session.captureViewportCenteredOnElement`) captures the viewport, NOT fullPage; centering the full-viewport grid container is a near no-op whose real job is selecting the viewport-only path while the row stays centered from the scroll helper. Best-effort: fires even if the scroll missed.
**Tags:** screenshot, timecard, virtual-scroll, fullpage, viewport, scroll-to-date, center, ui-grid, audit
