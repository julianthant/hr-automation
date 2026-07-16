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
**Fix:** `goToMenu.timecardItem(page)` is a frame- AND page-scoped `.or()` chain over the option/menuitem ROLES with an ANCHORED name (`/^\s*timecards?\s*$/i`), covering plural/singular. The old bare `text=Timecard`/`text=Timecards` substring branches were REMOVED 2026-06-24 — they matched "Employee timecards" chrome once a timecard was loaded (see the 2026-06-24 timing entry below).
**Selector:** `goToMenu.goToButtonOnPage`, `goToMenu.goToButtonInFrame`, `goToMenu.timecardItem` in `selectors.ts`
**Tags:** go-to, timecard, menu, frame, page, fallback, plural, anchored-name

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

## 2026-06-22 — Date-range fields are NATIVE `<input type=date>` (ISO value) — `fill()` the ISO string, NOT MM/DD/YYYY; calendar grid is the fallback (OBS-006 / ISS-B05)

**Tried:** Treating the WFD "Select range" Start/End fields as JS-masked text inputs and feeding them `MM/DD/YYYY`: (1) `safeFill(startDateInput, "05/10/2026")`; (2) `pressSequentially("05/10/2026")`; (3) digits-only condition-based per-keystroke entry (`typeMaskedDate`/`maskedDigitPrefixes`/`waitForMaskedDigits`) with readback verify on `dateDigits`.
**Failed because:** A live DOM dump of the OPEN picker (via a `DEBUG_SCREENSHOTS=1` inventory written to `.tracker/screenshots/wfd-date-picker-*.json`) proved the fields are **native `<input type=date>`** — `#startDateTimeInput` / `#endDateTimeInput`, whose `.value` is ISO `YYYY-MM-DD` (the visible `MM/DD/YYYY` is just the browser's locale rendering). A native date input ONLY accepts an ISO `yyyy-mm-dd` via `fill()`/value; feeding it `MM/DD/YYYY` is silently rejected → it keeps today's value (OBS-006's "fill reverts to today"), and per-key typing fought the browser's own segment mask → scrambles/`<empty>`/`WFP-00889` (ISS-B05). Tracker evidence: `wanted 05112026, got 1120260605` (pressSequentially era) and `got <empty>` on all 4 attempts (per-keystroke era). The whole "masked React input" model was wrong — it's a plain native control.
**Fix:** Speak the input's language. `setRangeDate(page, input, dateStr, label)` in `navigate.ts`: (1) FAST PATH — `input.fill(toIsoDate(dateStr))` (e.g. `"5/11/2026"` → `"2026-05-11"`); Playwright sets a native date input's value directly with no segment race, and `inputValue()` reads back ISO so the verify is exact. (2) FALLBACK — `pickRangeDateViaCalendar`: click the field to bind the shared `js-moment-picker` calendar, `navigateCalendarToMonth` (read `th.js-moment-picker-parent-view` header "Jun 2026" → `parseCalendarHeaderOrdinal`, click `#tfsCalendarPreviousMonth`/`#tfsCalendarNextMonth` to converge), then click the day `td[role=gridcell]` by its full-date aria-label ("Monday, June 11, 2026") via `calendarDayCell` (`:not(.out-of-month)` so an adjacent-month trailing day can't be hit). (3) Re-read `inputValue()` and FAIL LOUD (`WFP-00889`) if it still ≠ the wanted ISO. `toIsoDate`/`parseMmddyyyy`/`calendarDayLabelPattern`/`parseCalendarHeaderOrdinal` are pure + pinned by `tests/unit/systems/new-kronos/navigate.test.ts` (incl. "June 1" not matching "June 11"). The old `typeMaskedDate`/`maskedDigitPrefixes`/`dateDigits` machinery is REMOVED — do not bring back keystroke-typing into these fields. **NEEDS LIVE RE-VERIFY** that the native ISO `fill()` propagates to the Angular model (else the calendar fallback engages) under the parallel batch.
**Selector:** `timecard.startDateInput`/`endDateInput` (now `#startDateTimeInput`/`#endDateTimeInput`), `calendarMonthHeader`, `calendarPrevMonth`, `calendarNextMonth`, `calendarDayCell` in `selectors.ts`
**Tags:** date-range, native-input, input-type-date, iso, fill, calendar, moment-picker, gridcell, month-nav, out-of-month, readback, verify, WFP-00889, OBS-006, ISS-B05, setDateRange, timecard

## 2026-06-18 — Go To → Timecard is an `option` role, not `menuitem`

**Tried:** `getByRole("menuitem", { name: /timecard/i })` as the primary in `goToMenu.timecardItem`.
**Failed because:** The live Dayforce Go To dropdown renders the Timecard entry as `role="option"` (not `role="menuitem"`). The `menuitem` primary missed every time, triggering the next fallback and emitting a spurious fallback warning on every run.
**Fix:** Add `getByRole("option", { name: /timecard/i })` (frame-scoped then page-scoped) as the first two choices in the `.or()` chain, before the `menuitem` fallbacks. Verified live 2026-06-18.
**Selector:** `goToMenu.timecardItem` in `selectors.ts`
**Tags:** go-to, timecard, option, menuitem, role, fallback, navigation

## 2026-06-18 — Timecard sick/holiday parsing: column indices and pay-code strings

**Tried:** Guessing cell indices and pay-code strings without live verification (e.g. assuming Pay code might be cell[3] or cell[5], or that holiday rows would all carry the day-of text like "Juneteenth Observed").
**Failed because:** The WFD timecard grid has 10 cells per row (`[0]=Schedule, [1]=In, [2]=Out, [3]=Transfer, [4]=Pay code, [5]=Amount, [6]=Shift, [7]=Daily, [8]=Period, [9]=Absence`). Without live verification the wrong cell index returns an empty string, silently missing every pay-code match. Additionally, a "Juneteenth Observed" annotation row appears alongside the real "Holiday - Hourly" row for 6/19 — naively matching `/holiday/i` on ALL text rather than specifically on cell[4] would have counted it; the annotation row's cell[4] is empty/non-matching, so the regex is safe.
**Fix:** In `getSeparationTimecardData` (navigate.ts), walk the aligned `.ui-grid-viewport` grid. Punch = In(cell[1]) or Out(cell[2]) matches `/\d+:\d+\s*(AM|PM)/`. **Sick** = cell[4] matches `/sick/i` (live string: `"Sick - Hourly"`). **Holiday** = cell[4] matches `/holiday/i` (live string: `"Holiday - Hourly"`). Multiple data rows can share one date — carry last-seen date forward. Verified live 2026-06-18 against EIDs 10776990 (holiday) and 10776013 (sick).
**Tags:** sick, holiday, timecard, parsing, pay-code, column-index, separations, getSeparationTimecardData

## 2026-06-18 — Search input renders in `portal-frame-*` iframe OR top-level — resolve both

**Tried:** Always targeting the search input/results/close via `searchFrame(page)` (the `iframe[name^="portal-frame-"]` locator) regardless of context.
**Failed because:** The WFD Employee Search sidebar renders its input/results EITHER inside the portal-frame iframe (some loads) OR top-level on the page (others). The iframe-only locator timed out on the top-level variant — a real daemon separations run failed with `locator.fill: Timeout 5000ms exceeded` on `iframe[...].contentFrame().getByRole('textbox', { name: 'Search by Employee Name or ID' })` (EID 10602099), so New Kronos found nothing and the run fell back to the Kuali date. (An earlier assumption that the daemon's fresh-login path always uses the iframe was WRONG — the daemon hit the top-level variant.)
**Fix:** Every `search.*` selector now accepts a `SearchRoot` (`FrameLocator | Page`); `resolveSearchRoot(page)` in `navigate.ts` probes the iframe's search input first (4s) and falls back to the top-level page, and `searchEmployee` / `selectEmployeeResult` / `closeEmployeeSearch` all use the resolved root (close tries both contexts). Verified-date bumped on all `search.*` selectors to 2026-06-18.
**Selector:** `search.*` (now `SearchRoot`-typed) + `resolveSearchRoot` in `navigate.ts`
**Tags:** iframe, portal-frame, search-input, top-level, resolveSearchRoot, frame-context, fill-timeout

## 2026-06-22 — `goToButton*` page-wide `/go to/i` matched the timecard TOOLBAR "Go to" (masked), not the panel Go To

**Tried:** `goToButtonOnPage` / `goToButtonInFrame` as a page-/frame-wide `getByRole("button", { name: /go to/i }).or(...)` and letting `clickGoToTimecard` poll the candidates for the first visible+enabled one.
**Failed because:** The timecard renders TWO buttons matching `/go to/i`: the Employee Search panel's "Go To" dropdown (`#goToDropdownButton`, inside the Quick Find slide-out) AND the main timecard **toolbar** "Go to" button (`aria-label="Go to"`, `class="btn widget-button-icon"`). The toolbar button is DOM-first, so `.first()` resolved IT; it is for date navigation and is **always enabled**, so the `isVisible() && isEnabled()` poll passed on the wrong button instantly (the 2026-06-18 enabled-poll can't tell them apart). The toolbar button sits in the page region **behind the open slide-out's `slideout__mask`**, so the click was intercepted: live log (doc 10599388, 2026-06-22) shows `Employee checkbox checked` → `Clicking Go To → Timecard...` → 5s `timeout-intercepted: Another element intercepted the click (modal/overlay)`, locator `resolved to <button aria-label="Go to" class="btn widget-button-icon">`, intercepted by `<div class="slideout__mask visible"> from <krn-slide-out-container class="quick-find-content">`. Result: `clickGoToTimecard` returned false → empty timecard → silent fall-back to the Kuali LDW; the New Kronos browser visibly stalled on the search panel without navigating. NOT a regression of the 2026-06-18 selection fix — selection registered fine; the Go To button RESOLUTION was wrong.
**Fix:** Scope the Go To button to the Quick Find slide-out so it can never resolve the toolbar button. Primary = the panel's stable `#goToDropdownButton` (`ng-disabled="!quickFind.slatOptions.selectedslats.length"`, from the 2026-06-18 entry); fallback = the `/go to/i` role match SCOPED to `page.locator(".quick-find-content")` / `f.locator(".quick-find-content")` (the slide-out container `krn-slide-out-container.quick-find-content`, verified present in the live error log). The toolbar "Go to" is outside `.quick-find-content` and has no `#goToDropdownButton`, so it is excluded. The correct panel button is inside the slide-out content (above its own mask), so the click is no longer intercepted. // NEEDS LIVE RE-VERIFY 2026-06-22 — derived from the live error log + the documented id, not a fresh playwright-cli snapshot.
**Selector:** `goToMenu.goToButtonOnPage`, `goToMenu.goToButtonInFrame` in `selectors.ts`
**Tags:** go-to, button, toolbar, quick-find, slideout, slideout__mask, intercept, modal-overlay, goToDropdownButton, ng-disabled, first, resolution, navigation, timecard

## 2026-07-06 — Found beats no-results during the search grid load overlap

**Tried:** Racing `Promise.any([checkbox attached, slat visible])` (→ found) against `noResultsText.waitFor({ visible })` (→ not found) in `resolveSearchResult`.
**Failed because:** While WFD loads search results it can briefly show BOTH `"There are no items to display."` AND the result checkbox/slat at the same time (live probe 2026-07-06, EID 10714794: at t+100ms `noResults=true` while `checkbox count=1`). Whichever waiter settled first won the race — when no-results won, a clearly-found employee was mis-resolved NOT FOUND in ~1s (`Employee 10714794 NOT found in Kronos` in kronos-pay-rule).
**Fix:** Replace the race with `waitForEmployeeSearchOutcome`: poll BOTH contexts (iframe + top-level) every 200ms; on each tick `resolveSearchPresence(hasResult, noResults)` — **found always beats no-results** when both are true; not-found only when the sentinel is visible AND no result signal exists in either context. Added `search.resultEmployeeId` as a third found signal. Pure `resolveSearchPresence` pinned in `navigate.test.ts`.
**Selector:** `search.resultEmployeeId`, `searchResultPresentInRoot`, `waitForEmployeeSearchOutcome`, `resolveSearchPresence` in `navigate.ts`
**Tags:** found, not-found, race, overlap, no-results, checkbox, search, kronos-pay-rule, ISS-B04

## 2026-06-22 — Found-detection must wait for the "Select Item" checkbox ATTACHED, not VISIBLE (it's a hidden native input)

**Tried:** `searchEmployee` resolved found vs not-found by racing `firstResultCheckbox.waitFor({ state: "visible" })` (→ found) against `noResultsText.waitFor({ state: "visible" })` (→ not found), with a both-rejected timeout → NOT FOUND (ISS-B04).
**Failed because:** The WFD "Select Item" result checkbox is a CUSTOM-STYLED control — its backing native `<input type=checkbox>` is zero-size / visually hidden (a styled element renders the visible box). `getByRole("checkbox", { name: "Select Item" })` matches the native input, but `waitFor({ state: "visible" })` NEVER resolves for it even when a result is present. So a CLEARLY found employee (EID 10629763 — "Total [1]", "Argumedo, Zaira N") raced two never-resolving waiters (checkbox never "visible", no-results text never appears), hit the 15s timeout, and was mis-resolved as NOT FOUND. Two correlated symptoms from one cause: the timecard step was **skipped entirely** (`searchEmployee` returned false → `runNewKronosTimecard` early-returns before `clickGoToTimecard`) AND the best-effort "No search results surfaced … treating as NOT FOUND" `log.warn` fired. Note `selectEmployeeResult` never had this bug — it keys presence off `checkbox.count() > 0` / `.check()`, not visibility.
**Fix:** Detect a present result ROBUSTLY: found when EITHER the checkbox is **ATTACHED** (present in the DOM = a result exists, regardless of CSS visibility) OR the new `firstResultSlat` (`getByRole("menuitemradio").first()`, the result employee slat — TIGHT, no `[role=row]` fallback) is visible — `Promise.any([...])` fed as the found waiter into `resolveSearchResult`. Genuine no-results still settles on the "no items to display" sentinel (or the ISS-B04 timeout → NOT FOUND). Net rule: **always go to the timecard for any employee who shows up; the only skips are a genuine no-results search and the upstream identity-check EID correction.** `resolveSearchResult`'s contract is unchanged (it still takes two waiter promises); only the found waiter the caller builds got broader. **NEEDS LIVE RE-VERIFY** that the checkbox is in fact attached-but-hidden and that `menuitemradio` is the live slat role.
**Selector:** `search.firstResultCheckbox`, `search.firstResultSlat` (added 2026-06-22) in `selectors.ts`; `searchEmployee`, `resolveSearchResult` in `navigate.ts`
**Tags:** found, not-found, checkbox, select-item, attached, visible, hidden-input, menuitemradio, slat, timecard, skip, search, ISS-B04

## 2026-06-18 — Go To button stays `ng-disabled` until the "Select Item" checkbox registers a selection

**Tried:** `selectEmployeeResult` checked `input[type="checkbox"].first()`, then `clickGoToTimecard` clicked the Go To button.
**Failed because:** The Go To button (`#goToDropdownButton`) is `ng-disabled="!quickFind.slatOptions.selectedslats.length"` — enabled ONLY when an employee (slat) is selected. The result checkbox is a `role=checkbox name="Select Item"` control; a native `<input type=checkbox>` backs it but checking THAT input does not fire Angular's selection handler, so `selectedslats` stayed empty and Go To stayed disabled. `clickGoToTimecard` then clicked a disabled button → `locator.click: Timeout ... element is not enabled`. (Surfaced once New Kronos became the ONLY timecard source after Old Kronos was removed from separations 2026-06-18.)
**Fix:** `firstResultCheckbox` now targets `getByRole("checkbox", { name: "Select Item" })` (fallback `input[type=checkbox]`); `firstResultRow` fallback targets the result `menuitemradio`; `selectEmployeeResult` try/checks the checkbox then falls back to clicking the row. `clickGoToTimecard` POLLS for the Go To button to be visible AND `isEnabled()` (up to 15s) before clicking — clicking it while disabled just times out, and a never-enabled button now fails loud with a clear "selection did not register" error instead of an opaque click timeout.
**Selector:** `search.firstResultCheckbox`, `search.firstResultRow`, `goToMenu.goToButtonInFrame`/`goToButtonOnPage` in `selectors.ts`; `selectEmployeeResult`, `clickGoToTimecard` in `navigate.ts`
**Tags:** go-to, disabled, ng-disabled, checkbox, select-item, selectedslats, employee-select, timecard, enabled

## 2026-06-24 — Go To → Timecard: a FIXED `waitForTimeout(2000)` + one-shot check raced the dropdown render — worked once per session, failed for every employee after

**Tried:** `clickGoToTimecard` clicked the Go To button, then `await page.waitForTimeout(2_000)` and a SINGLE `clickIfPresent(goToMenu.timecardItem(page))`. The `timecardItem` selector also carried bare `text=Timecard`/`text=Timecards` `.or()` fallbacks.
**Failed because:** The Angular Go To dropdown renders its options asynchronously, and on a WARM session (a timecard already loaded behind the slide-out) it renders SLOWER than 2s. The FIRST found employee in a batch rendered within the fixed 2s window (worked); every SUBSEQUENT employee did not — at the 2s checkpoint `timecardItem.count() === 0`, so `clickIfPresent` returned false in ~0.1s and logged "Timecard option not found in Go To menu". Live evidence (separations-2026-06-24, EIDs 10832819 ✓ then 10779506/10687564/10834043/10839053 ✗ all in one daemon session): the success/failure split was perfectly first-works-rest-fail, and each failure's `clickGoToTimecard` returned ~0.1s after the 2s sleep (count===0, the option had not rendered). `runNewKronosTimecard` then silently returned an empty timecard → the separations handler fell back to the Kuali Last Day Worked for FOUND HDH employees, while the browser sat with the dropdown open over the PREVIOUS employee's timecard (the symptom the operator screenshotted). The bare `text=Timecard` fallbacks compounded the risk: "Employee timecards" (page title) and other chrome CONTAIN "timecard", so once a timecard loaded those branches could resolve `count()` to stale, non-actionable elements.
**Fix:** Two changes. (1) `clickGoToTimecard` (navigate.ts) replaced the fixed sleep + one-shot with CONDITION-BASED WAITING: open the dropdown, then `timecardItem.first().waitFor({ state: "visible" })` polled to a 15s deadline, and if the first window elapses with no visible option RE-OPEN the dropdown once (the open click can be swallowed mid-render) before waiting again, then `safeClick` the option. (2) `goToMenu.timecardItem` (selectors.ts) dropped the bare `text=Timecard`/`text=Timecards` substring branches and anchored the role-name to `/^\s*timecards?\s*$/i` so it can only match the dropdown option, never "Employee timecards" chrome. Paired fail-loud: `runNewKronosTimecard` (separations `steps/kronos-search.ts`) now THROWS when a FOUND employee's Go To → Timecard fails, instead of returning an empty timecard that masquerades as "no punches" and silently uses the Kuali dates (the throw is logged + non-fatal inside the settled `ctx.parallel` block — visible, not swallowed). **NEEDS LIVE RE-VERIFY** under a real multi-doc daemon batch that the second+ employee now navigates.
**Selector:** `goToMenu.timecardItem` in `selectors.ts`; `clickGoToTimecard` in `navigate.ts`; `runNewKronosTimecard` in `src/workflows/separations/steps/kronos-search.ts`
**Tags:** go-to, timecard, dropdown, render-race, waitForTimeout, condition-based-waiting, count-zero, batch, first-works-rest-fail, fail-loud, stale-element, anchored-name, navigation

## 2026-06-24 — A loaded timecard can belong to the PREVIOUS employee (stale selection) — verify the EID before reading punches

**Tried:** After `clickGoToTimecard` returned true, `runNewKronosTimecard` went straight to `setDateRange` + `getSeparationTimecardData`, trusting that the open timecard was the searched employee's.
**Failed because:** Go To → Timecard does not always switch employees — the PREVIOUS employee's timecard can stay on screen even though the search selected a new person. Live (operator screenshot): a search for 10603110 (Lua-Sandoval) left Yang, Elaine C / 10832819 displayed; the parse then attributed Yang's punches/sick/holiday to Lua-Sandoval's separation. The Go To render-race fix (same date) reduces this but doesn't eliminate the stale-timecard window.
**Fix:** `verifyTimecardEmployee(page, eid)` runs after `clickGoToTimecard` and throws before reading punches when the open employee cannot be positively verified. The original page-wide scan was superseded 2026-07-16: both the navigation wait and final gate now read only the authoritative `.emp-nav-id` header and require an exact EID, because retained search/body text can contain the requested EID while another employee remains open. The throw is logged + non-fatal in the settled `ctx.parallel` block (the run completes on the Kuali fallback), but visible rather than silently reading the wrong person.
**Selector:** `verifyTimecardEmployee` in `navigate.ts`; `runNewKronosTimecard` in `src/workflows/separations/steps/kronos-search.ts`
**Tags:** timecard, stale, wrong-person, employee-id, verify, go-to, fail-loud, emp-nav-id, separation
**References:** `src/workflows/separations/CLAUDE.md` "Found-but-can't-open / wrong-person fails loud"

## 2026-07-02 — People editor (Timekeeper / Pay Rule) renders in a `managePeople` frame, not the top-level page

**Tried:** `people.*` selectors scoped to `page` with guessed `[data-automation-id='PayRule']` and `page.getByText("Pay Rule")` for expand checks.
**Failed because:** Go To → People opens a child frame (`managePeople#/managePeople`). The jqx pay-rule grid (`#payRuleGrid`, `#row1payRuleGrid`) and Save toolbar live only inside that frame — top-level probes returned `count=0` even after navigation succeeded.
**Fix:** Go To → People navigates to the `managePeople#/managePeople` route (usually a full-page navigation; sometimes a child frame). Use `resolvePeopleRoot(page)` / `peopleFrame(page)` — never top-level `page` alone. The Timekeeper accordion header is `.panel-heading[data-target="#TimekeeperPanelPlugin"]` (not a reliable `getByRole('link')`); `#TimekeeperPanelPlugin` itself is present-but-**hidden** when collapsed — do not `.or()` it into `timekeeperSection`. Pay-rule inline dropdown: click empty `#row1payRuleGrid` cell → DOM-click `.pe-search-button` Search affordance (jqx popup is `display:none` to Playwright) → one `getByRole('textbox')` appears in `modal-window-pe` → type code → click matching `.jqx-grid` row → DOM-click **OK** (not a Search button). Effective date: click `#row1payRuleGrid` date cell → `#datetimeeditorpayRuleGrideffectiveDate .jqx-icon-calendar` → pick day in `.jqx-calendar` (do **not** type into the input). Probe: `scripts/verify-kronos-add-pay-rule.ts`.
**Selector:** `peopleFrame`, `people.*` in `selectors.ts`; `clickGoToPeople`, `expandTimekeeperSection`, `addPayRule` in `navigate.ts`
**Tags:** people, managePeople, frame, pay-rule, timekeeper, jqx, go-to, kronos-pay-rule
**References:** `src/workflows/kronos-pay-rule/CLAUDE.md`

## 2026-07-02 — Batch pay-rule runs: a stale People editor can't switch in place — reset to home per item + verify identity via `.empName` (NOT whole-page text)

**Tried:** After the first employee, `clickGoToPeople` for the next EID relied on (a) the slat selection "refreshing" the open editor and (b) `waitForPeopleEmployee` matching the searched EID anywhere in `document.body.innerText`.
**Failed because:** BOTH assumptions were wrong (live 2026-07-02, 10604376 → 10416352). (a) Selecting the next employee in the global Employee Search does NOT refresh the open People editor — `.empName`/`#empNav` stayed on the previous person. (b) The searched EID lingers in the global search box/results, so the whole-`document.body` check FALSE-POSITIVED: `clickGoToPeople` reported the next EID "already open" while the editor still displayed KentHodge (10604376), so the pay rule was re-added to the PREVIOUS person ("does not go to the next person, keeps redoing the old one"). And once a People editor is open, Go To → People no longer renders a "People" option, so the stale editor genuinely cannot be switched in place.
**Fix:** (1) `resetNewKronosToHome(page)` (gotoWithRetry to `/wfd/home`) at the START of each item so every employee runs the proven fresh flow (search → select → Go To → People). (2) `waitForPeopleEmployee` + `verifyPeopleEmployee` now read the editor's OWN `.empName` header (title "<Name> <EID>", inside `#peEmpList`) via the pure `peopleHeaderShowsEid` — NOT whole-page text. (3) The workflow calls `verifyPeopleEmployee` before add/save as a fail-loud identity gate (throws naming the wrong EID). Live-verified 2026-07-02: 10604376 → 10416352 both confirmed. Probe: `scripts/verify-kronos-people-batch.ts` (now asserts the loaded identity, not just clickGoToPeople's boolean).
**Selector:** `people.loadedEmployeeName` (`.empName`); `resetNewKronosToHome`, `waitForPeopleEmployee`, `verifyPeopleEmployee`, `peopleHeaderShowsEid` in `navigate.ts`
**Tags:** people, batch, go-to, managePeople, empName, identity, reset, kronos-pay-rule, fail-loud
**References:** `src/workflows/kronos-pay-rule/CLAUDE.md`, `tests/unit/systems/new-kronos/navigate.test.ts`

## 2026-07-02 — Pay-rule effective date: calendar day click must be committed with Enter

**Tried:** `setPayRuleEffectiveDateViaCalendar` clicked the jqx calendar day and returned immediately.
**Failed because:** jqx leaves the picked date in `#inputdatetimeeditorpayRuleGrideffectiveDate` only — the `#row1payRuleGrid` Effective Date **grid cell stays blank** until **Enter** commits the inline editor (live 2026-07-02 on EID 10416352). Save then persists a pay rule with no effective date.
**Fix:** After the calendar day click, `effectiveDateInput(root).press("Enter")`, then poll `effectiveDateCell` until it matches the target MM/DD/YYYY (leading zeros optional) — throw if still blank after 5s.
**Selector:** `people.effectiveDateInput`, `people.effectiveDateCell`; `setPayRuleEffectiveDateViaCalendar` in `navigate.ts`
**Tags:** pay-rule, effective-date, calendar, jqx, enter, commit, kronos-pay-rule, fail-loud

## 2026-07-02 — Pay-rule lookup: the OK click intermittently no-ops; gate on the code committing to the grid, not on the modal closing

**Tried:** `addPayRule` clicked the result row once, DOM-clicked OK (`evaluate(el.click())`), then `payRuleSearchModal.waitFor({ state:"hidden", timeout:10_000 })` — no retry, no readback.
**Failed because:** The raw `el.click()` on the jqx OK button intermittently fails to register (or the single result-row click never selected), so the lookup modal never closes → a hard `locator.waitFor: Timeout 10000ms exceeded` with the pay rule never committed (live 2026-07-02, EID 10416352; the same window showed general flakiness — a sibling EID needed 3 manual retries). Latent worse case: had OK ever closed the modal WITHOUT committing, Save would persist an empty/wrong pay rule into a real payroll record.
**Fix:** `confirmPayRuleSelection(root, code)` retries row-select + OK up to 3× and gates success on the CODE landing in the row1 grid cell (`payRuleCodeCell` readback via the pure `payRuleCodeCommittedInCell`), polled to a short 5s deadline so a missed click retries fast instead of stalling 10s; after 3 misses it throws naming the code + cell text, aborting BEFORE Save. `clickToReveal` gives the two effective-date jqx opens (cell→editor, icon→picker) the same retry-once-then-fail-loud treatment. Re-verified live 2026-07-02, EID 10416352 (no Save) → "Pay rule SX-8Hol-8-OT-30 committed to grid".
**Selector:** `people.payRuleCodeCell` (readback); `confirmPayRuleSelection`, `clickToReveal`, `payRuleCodeCommittedInCell` in `navigate.ts`
**Tags:** pay-rule, lookup, ok, modal, jqx, retry, readback, commit, kronos-pay-rule, fail-loud
**References:** `src/workflows/kronos-pay-rule/CLAUDE.md`, `tests/unit/systems/new-kronos/navigate.test.ts`

## 2026-07-04 — People Save: overlay waits alone can false-report success; gate on the Save button returning to native-disabled

**Tried:** `savePersonRecord` clicked Save, best-effort waited for the loading overlay to appear then disappear (both waits swallowed in `catch {}`), slept 1s, and logged "Person record saved".
**Failed because:** Neither overlay wait proves the save COMMITTED — a jqx validation-error dialog, a rejected save, or a hang with no overlay all sail through the two best-effort waits, so the workflow stamped the row "Updated" for a pay rule that was never persisted (the one mutation in the pay-rule flow with no readback while OK/effective-date both had commit gates).
**Fix:** Read-only live probe (`scripts/verify-kronos-save-state.ts`, EID 10403587, 2026-07-04) confirmed the state contract: the People editor's Save button carries a native `disabled` attribute whenever there are NO pending edits and enables once the editor holds unsaved changes — so a committed save returns it to `disabled`. `savePersonRecord` now polls `saveButton.isEnabled()` for up to 20s after the overlay waits and THROWS if it stays enabled ("edits still pending — the pay rule was NOT persisted") instead of logging success.
**Selector:** `people.saveButton` (state contract documented in its JSDoc); `savePersonRecord` in `navigate.ts`
**Tags:** people, save, readback, disabled, jqx, commit, kronos-pay-rule, fail-loud
**References:** `src/workflows/kronos-pay-rule/CLAUDE.md`, `scripts/verify-kronos-save-state.ts`

## 2026-07-16 — Timecard identity must use the authoritative header, not page-wide EID text

**Tried:** `waitForTimecardEmployee` and `verifyTimecardEmployee` searched `document.body.innerText` for the requested EID after Go To → Timecard.
**Failed because:** New Kronos retains the requested EID in search chrome while the open timecard can still belong to the previous employee, so the target appeared somewhere on the page and falsely passed. Live mapping found the authoritative desktop header at `<div class="emp-nav-id">10403587</div>`.
**Fix:** Added `timecard.loadedEmployeeId` and routed both gates through `scanTimecardEmployeeHeader`, which reads only `.emp-nav-id` and requires an exact EID. The legacy probe export now has header-only exact semantics; unit coverage proves body-like text containing the target cannot pass.
**Tags:** timecard, employee, identity, eid, emp-nav-id, wrong-person, fail-loud, live-verified
