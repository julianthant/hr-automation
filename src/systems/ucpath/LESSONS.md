# ucpath — Selector Lessons

Append-only record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. New entries go at the bottom.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-04-10 — Transaction number not extractable from confirmation modal

**Tried:** Reading the transaction number from the OK confirmation dialog text after Save & Submit.
**Failed because:** Clicking OK navigates the page away from the transaction; the dialog text is gone before Playwright can read it.
**Fix:** After clicking OK, renavigate via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number from there.
**Selector:** `smartHR.confirmationOkButton`, `hrTasks.smartHRTransactionsLink` in `selectors.ts`
**Tags:** transaction, confirmation, ok, navigate, save

## 2026-04-10 — `framenavigated` listener registered during auth fires forever

**Tried:** Registering a `framenavigated` listener inside `loginToUCPath` to detect SSO completion, then leaving it attached.
**Failed because:** The listener fires on every subsequent PeopleSoft page navigation, polluting the log stream and risking interference with later navigation detection logic.
**Fix:** Always remove the listener after auth completes (via the listener's removal handle returned by `page.on(...)`).
**Tags:** auth, listener, framenavigated, log, cleanup

## 2026-04-16 — `pt_modalMask` overlay intercepts every click between tabs

**Tried:** Clicking iframe tabs (Personal Data, Job Data, Earns Dist, Employee Experience) directly with `.click()`.
**Failed because:** PeopleSoft leaves a transparent `#pt_modalMask` (or `.ptModalMask`) overlay visible after dropdown round-trips and tab switches. The overlay intercepts clicks even though it is invisible.
**Fix:** Call `dismissPeopleSoftModalMask(page)` from `src/systems/common/modal.ts` before each tab click. The helper hides every `#pt_modalMask` / `.ptModalMask` element via inline `style.display = "none"`.
**Tags:** modal, mask, overlay, peoplesoft, tab, click, intercept

## 2026-04-16 — Comp Rate Code is a textbox, not a `<select>` dropdown

**Tried:** `page.locator('select#comp-rate')` and `getByLabel("Comp Rate Code")` with a `selectOption` call.
**Failed because:** PeopleSoft renders the field as an accessible-name textbox with a magnifying-glass lookup, not a `<select>`. Calls to `selectOption` throw on a non-`<select>` element.
**Fix:** Use `getByRole("textbox", { name: "Comp Rate Code" })` with the 5-deep `.or()` fallback chain to capture the post-position-fill grid-id mutation, then press Tab to blur and trigger validation. Compensation Rate follows the same pattern. Compensation Frequency must explicitly fill `"H"` (Hourly) when empty.
**Selector:** `jobData.compRateCodeInput`, `jobData.compensationRateInput`, `jobData.compensationFrequencyInput` in `selectors.ts`
**Tags:** comp, rate, code, compensation, paypath, dropdown, textbox, validation

## 2026-04-16 — PeopleSoft grid IDs mutate from `$11` to `$0` after position-number refresh

**Tried:** Using a fixed grid-id selector like `input[id="HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$11"]` for Comp Rate Code.
**Failed because:** Filling the Position Number triggers a page refresh that re-orders grid rows; the field's `$N` suffix changes (commonly `$11` → `$0`). The fixed-id selector then targets the wrong field or no field.
**Fix:** Always lead with the accessible-name selector and chain known grid-id variants via `.or()` to cover both pre- and post-refresh states. Use `input[id="..."]` (not just `[id="..."]`) so the selector excludes wrapper `<div>`s with the same id prefix.
**Selector:** `jobData.compRateCodeInput`, `jobData.compensationRateInput` in `selectors.ts`
**Tags:** grid, mutation, position, paypath, fallback, selector

## 2026-04-16 — Save & Submit stays disabled until all 4 transaction tabs visited

**Tried:** Clicking Save & Submit immediately after filling the data.
**Failed because:** PeopleSoft requires the user to have visited Personal Data, Job Data, Earns Dist, and Employee Experience before enabling the Save button. Saving without visiting all four leaves the button disabled.
**Fix:** Walk all 4 tabs in order before Save & Submit. After filling Initiator Comments on the last tab (Employee Experience), re-click Personal Data once more before clicking Save. If the Save button reads disabled anyway, force-click via `{ force: true }`.
**Selector:** `smartHR.tab.personalData`, `smartHR.tab.jobData`, `smartHR.tab.earnsDist`, `smartHR.tab.employeeExperience`, `smartHR.saveAndSubmitButton` in `selectors.ts`
**Tags:** save, submit, tab, transaction, disabled, smart-hr

## 2026-04-16 — Person Org Summary single-result redirect skips the grid

**Tried:** Always reading the search results grid after submitting Person Org Summary.
**Failed because:** When the search returns exactly 1 match, PeopleSoft skips the results grid and jumps straight to the detail page. The grid selector then times out.
**Fix:** Detect both code paths. After clicking Search, check whether the URL changed to a detail page (single match) or remained on the results grid; branch accordingly. A simple `Promise.race` between "detail page loaded" and "results grid visible" works.
**Tags:** person, search, results, grid, redirect, single, detail

## 2026-04-24 — `personSearch` and `personOrgSummary` are different forms, not aliases

**Tried:** Treating `personSearch.*` as the canonical "person lookup" group when implementing a name-keyed lookup.
**Failed because:** They are two different PeopleSoft Find-an-Existing-Value forms with disjoint field shapes. `personSearch.*` targets the Search/Match component (`/c/...HCR_SM_SEARCH.GBL`) AFTER selecting `Search Type=Person, Search Parameter=PERSON_SEARCH` and clicking Search once — at which point SSN, First Name, Last Name, and DOB inputs appear (`CHAR_INPUT$0..2`, `DATE_INPUT$3`). `personOrgSummary.*` targets `/c/...PERSON_ORG_SUMM.GBL` directly, which exposes Empl ID, Last Name, and Name (first/middle) only — no SSN, no DOB. The HR Tasks sidebar surfaces both: "Search Person" → Search/Match, "Person Organizational Summary" → its own page.
**Fix:** Choose by use case. Onboarding's Smart-HR-side rehire detection uses `personSearch.*` (SSN + name + DOB). EID lookup and any future name-only lookup use `personOrgSummary.*`. They share `#PTS_CFG_CL_WRK_PTS_SRCH_BTN` for the Search submit only because that's a generic Find-an-Existing-Value control.
**Selector:** `personSearch.*`, `personOrgSummary.*` in `selectors.ts`
**Tags:** person, search, org-summary, find-existing-value, lookup, hr-tasks

## 2026-04-23 — Workforce Job Summary multi-row grid blocks detail-page tabs

**Tried:** Clicking the "Work Location" tab immediately after `searchJobSummary` returns `true`.
**Failed because:** When the search matches 2+ Job Summary rows (rehires or employees with multiple concurrent jobs), PeopleSoft stays on the search-results grid instead of auto-redirecting to the detail page. The Work Location tab doesn't exist on the grid, so the click times out at 15s even with the one-retry flake handler. Doc 3930 failed this way: search found a terminated + an active row for EID 10767007; old behavior blindly assumed the detail page was up.
**Fix:** After `searchJobSummary` passes the "No matching values were found" check, `handleMultiRowGrid(page, root, emplId)` probes `jobSummary.searchResultsGrid(root).count()`. Zero → single-row auto-redirect, proceed. Non-zero → enumerate rows via `jobSummary.searchResultRows(root)`, read each `rowHrStatusCell` text, skip rows where `/terminat/i` matches, drill in via `rowDrillInLink` on the first non-terminated row. Throws with a "verify EID in Kuali Build" message if every row is terminated — that's a data problem, not a retry case.
**Selector:** see `jobSummary.searchResultsGrid`, `jobSummary.searchResultRows`, `jobSummary.rowHrStatusCell`, `jobSummary.rowDrillInLink` in selectors.ts (added 2026-04-23).
**Tags:** multi-row, grid, terminated, job-summary, drill-in, work-location
