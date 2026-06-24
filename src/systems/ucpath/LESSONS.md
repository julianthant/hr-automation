# ucpath — Selector Lessons

Structured record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. Before adding an entry, search for related guidance and update/merge stale or contradictory lessons; add a new bottom entry only for a genuinely new failure mode.

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

## 2026-04-16 — `pt_modalMask` overlay intercepts every click between tabs (extended 2026-06-17)

**Tried:** Clicking iframe tabs (Personal Data, Job Data, Earns Dist, Employee Experience) directly with `.click()`. Also clicking the reason-code Continue button and the Comments textarea fill after the reason-code dropdown round-trip.
**Failed because:** PeopleSoft leaves a transparent `#pt_modalMask` (or `.ptModalMask`) overlay visible after dropdown round-trips and tab switches. The overlay intercepts clicks even though it is invisible. Specifically: `selectReasonCode` raises a mask after the `selectOption` call that blocks the Continue button (`id=HR_TBH_WRK_TBH_NEXT`) for the full 5s timeout before the JS `submitAction_win0` fallback fires. `fillComments` has the same exposure — the mask from a prior tab round-trip can still be present when the textarea fill is attempted.
**Fix:** Call `dismissPeopleSoftModalMask(page)` from `src/systems/common/modal.ts` before each tab click AND before the Continue button click in `selectReasonCode` AND before the first `safeFill` in `fillComments`. The helper hides every `#pt_modalMask` / `.ptModalMask` element via inline `style.display = "none"`. `fillComments` now takes a `page: Page` first parameter (same signature shape as `fillJobData` / `clickJobDataTab`) to make this dismiss possible.
**Selector:** `smartHR.continueButton`, `commentsSelectors.commentsTextarea`, `commentsSelectors.initiatorCommentsTextarea` in `selectors.ts`
**Tags:** modal, mask, overlay, peoplesoft, tab, click, intercept, comments, continue, reason-code

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

## 2026-05-07 — Person Org Summary detail-page Person ID id is `PERSON_NPC_VW_EMPLID`, not `PER_INST_EMP_VW_*`

**Tried:** Detecting the single-result detail page in `extractSingleResultDetail` by counting `personOrgSummary.personIdValue`, whose registry definition was `#PER_INST_EMP_VW_OPRID$0` `.or` `#PER_INST_EMP_VW_EMPLID$0`.
**Failed because:** Live UCPath renders the header Person ID as `<span id="PERSON_NPC_VW_EMPLID">10874572</span>` — no `$0` suffix and a different DOM-prefix entirely. Both fallback ids miss; `count()` returns 0; `extractSingleResultDetail` returns null; `searchByEid` warns "no detail page rendered" and the lookup reports `not-found` for an Active employee. The `PER_INST_EMP_VW_LAST_HIRE_DT$0` and `PER_INST_EMP_VW_TERMINATION_DT$0` ids in the same selector group are correct (verified live), so the bug is isolated to the Person ID gate.
**Fix:** Lead the `personIdValue` chain with `#PERSON_NPC_VW_EMPLID`, keep the legacy ids as fallbacks for cross-flow safety. Bumped `// verified` to 2026-05-07. Discovered by running playwright-cli against `PERSON_ORG_SUMM.GBL` for EID 10874572 (Leo Langley, SDCMP HDH, Active) during the 2026-05-05 E2E session.
**Selector:** `personOrgSummary.personIdValue` in `selectors.ts`
**Tags:** person-id, emplid, detail, person-org-summary, single-result, person-lookup

## 2026-04-23 — Workforce Job Summary multi-row grid blocks detail-page tabs

**Tried:** Clicking the "Work Location" tab immediately after `searchJobSummary` returns `true`.
**Failed because:** When the search matches 2+ Job Summary rows (rehires or employees with multiple concurrent jobs), PeopleSoft stays on the search-results grid instead of auto-redirecting to the detail page. The Work Location tab doesn't exist on the grid, so the click times out at 15s even with the one-retry flake handler. Doc 3930 failed this way: search found a terminated + an active row for EID 10767007; old behavior blindly assumed the detail page was up.
**Fix:** After `searchJobSummary` passes the "No matching values were found" check, `handleMultiRowGrid(page, root, emplId)` probes `jobSummary.searchResultsGrid(root).count()`. Zero → single-row auto-redirect, proceed. Non-zero → enumerate rows via `jobSummary.searchResultRows(root)`, read each `rowHrStatusCell` text, skip rows where `/terminat/i` matches, drill in via `rowDrillInLink` on the first non-terminated row. Throws with a "verify EID in Kuali Build" message if every row is terminated — that's a data problem, not a retry case.
**Selector:** see `jobSummary.searchResultsGrid`, `jobSummary.searchResultRows`, `jobSummary.rowHrStatusCell`, `jobSummary.rowDrillInLink` in selectors.ts (added 2026-04-23).
**Tags:** multi-row, grid, terminated, job-summary, drill-in, work-location

## 2026-05-15 — Person Org Summary name detection must use the header selector

**Tried:** Picking the employee name from generic two-word leaf text and excluding a growing list of UI labels.
**Failed because:** The heuristic could only be made to pass by adding a personal-name exclusion, which is brittle and risks rejecting a real employee if the name later appears as data.
**Fix:** Read `personOrgSummary.personNameValue` first, then use the old leaf-text heuristic only as a fallback for legacy renderings. The fallback label list now contains UI copy only.
**Selector:** `personOrgSummary.personNameValue` in `selectors.ts`
**Tags:** person-org-summary, name, detail, header, heuristic, selector

## 2026-05-27 — Smart HR Transactions text selector also matches SS Smart HR Transactions

**Tried:** Clicking the Smart HR Templates child with `getByText("Smart HR Transactions")`.
**Failed because:** Live UCPath renders both "Smart HR Transactions" and "SS Smart HR Transactions" in the expanded Smart HR Templates group; the loose text selector matches four text nodes and Playwright strict mode aborts before the transaction form loads.
**Fix:** Use `getByRole("link", { name: "Smart HR Transactions", exact: true })` for `hrTasks.smartHRTransactionsLink`.
**Selector:** `hrTasks.smartHRTransactionsLink` in `selectors.ts`
**References:** separations docs 3917 and 4025 failed on 2026-05-27 with `ucpath-transaction-failed` after this strict-mode collision.
**Tags:** smart-hr, transactions, sidebar, strict-mode, exact, role, ss-smart-hr

## 2026-05-27 — Submitted transaction ID is below the visible viewport

**Tried:** Reopening the submitted Smart HR transaction and taking the normal workflow screenshot from the top of the Enter Transaction Information page.
**Failed because:** The `Transaction ID: T...` field and the approval strip (`Transaction: T..., ID: ...`) are below the comments/save area. A top-positioned screenshot hides the usable T-number, and a failed parse returned before any submitted-page evidence screenshot was captured.
**Fix:** Scroll the Smart HR iframe to transaction readback markers before parsing and before workflow screenshots. Parse both lower-page shapes via `extractSmartHrTransactionNumber`, and capture `ucpath-transaction-submitted-missing-number` when UCPath accepted the submit but parsing still returns empty.
**Tags:** transaction, readback, screenshot, scroll, smart-hr, separations

## 2026-06-02 — Person Org Last Hire is start date, not assignment EFFDT

**Tried:** Treating Person Org Summary assignment-table `EFFDT` as the person-lookup dashboard start date.

**Failed because:** The assignment grid `EFFDT` is the selected employment-instance effective date, while the first day of service/start date is exposed separately as `PER_INST_EMP_VW_LAST_HIRE_DT$0` (`personOrgSummary.lastHireDate`). Showing EFFDT in the log panel makes the workflow look like it found the hire start date even when the two dates differ.

**Fix:** Keep both values separate: populate `EidResult.startDate` from Last Hire/first day of service, keep `EidResult.effectiveDate` for assignment EFFDT, and have person-lookup stamp/display `startDate` while retaining `effdt` only as backend context.

**Tags:** person-org-summary, last-hire, start-date, effdt, person-lookup, dashboard

## 2026-06-22 — Job Summary campus-discovery select drops the deep link; must re-navigate (ISS-B04)

**Tried:** `navigateToWorkforceJobSummary` (`job-summary.ts`) did `goto(JOB_SUMMARY_URL)` → on a `ucpathdiscovery` redirect, clicked the "University of California, San Diego" campus link, waited for networkidle, then logged "Page loaded" and proceeded straight to `searchJobSummary` (the Empl ID fill).
**Failed because:** selecting the campus on the discovery picker redirects to the campus UCPath **portal home**, NOT back to the deep-linked `WF_JOB_SUMMARY` component — so the Empl ID search box was absent and `searchJobSummary`'s `safeFill(emplIdInput, …)` timed out (`locator.fill: Timeout 10000ms ... textbox "Empl ID"`), failing the run at `kronos-search`/`ucpath-job-summary`. EVERY doc that hit campus discovery in the 2026-06-22 live separations batch failed this way (9/9). This is distinct from ISS-B02 (which re-navigates on a *detail-view* WF_JOB_SUMMARY URL with the search box absent); here we never reached the component at all because the campus redirect bounced us to the portal home. Why discovery kept reappearing mid-batch is unconfirmed — likely `session.reset` between docs clears the campus cookie — but the fix is robust either way.
**Fix:** after the campus link click + networkidle, if the URL is not on `WF_JOB_SUMMARY`, re-`goto(JOB_SUMMARY_URL)` — the campus cookie is now set, so the second goto resolves the component (the search box is present) without bouncing to discovery again. Pinned by `tests/unit/systems/ucpath/job-summary.test.ts` (stateful fake page: 1st goto → discovery, campus click → portal home, asserts a 2nd goto to the deep link and ends on WF_JOB_SUMMARY). **NEEDS LIVE UCPATH RE-VERIFY** of the multi-doc batch path — confirm the post-campus re-navigation lands on the search form and that discovery isn't re-triggered a third time.
**Selector:** `jobSummary.campusDiscoveryUcsdLink`, `jobSummary.emplIdInput` in `selectors.ts` (consumed by `navigateToWorkforceJobSummary`/`searchJobSummary` in `job-summary.ts`)
**Tags:** job-summary, campus, discovery, ucpathdiscovery, navigate, deep-link, empl-id, separations

## 2026-06-24 — Workforce Job Summary sub-tabs are anchor LINKS, not `role="tab"`

**Tried:** Clicking the Work Location / Job Information sub-tabs with `getByRole("tab", { name: "Work Location" })` only.
**Failed because:** PeopleSoft renders these Job-Information sub-tabs as anchor links styled as tabs — they are not true `role="tab"` widgets — so on some loads the role-only selector matched nothing and `safeClick` timed out the full 15s (live separations run: `click failed after 15073ms … getByRole('tab', { name: 'Work Location' })`, retried, failed again). It worked on other docs only when PeopleSoft happened to expose the tab role.
**Fix:** `workLocationTab` / `jobInformationTab` fall through `role=tab` → `role=link` → `a:has-text(...)` (`.first()`). Additive — never worse than the role-only selector, and resolves the link rendering.
**Selector:** `jobSummary.workLocationTab`, `jobSummary.jobInformationTab` in `selectors.ts`
**Tags:** job-summary, work-location, job-information, tab, link, anchor, role, timeout

## 2026-06-24 — Work Location department must be the row in effect AS OF the separation date

**Tried:** `extractWorkLocation` returned the FIRST Position-Number row's Dept ID/Description (cells[+3]/[+4]), ignoring Effective Date.
**Failed because:** Workforce Job Summary's Work Location grid lists one row PER effective-dated job state (hire, transfers, …). The first/most-recent row is the wrong department for a transferred employee, and it skews the separations HDH/non-HDH kronos-skip gate (an employee who left an HDH job months ago but whose latest row is non-HDH, or vice-versa).
**Fix:** Scan ALL Position-Number rows with their Effective Date (read in-row; a count-exact zip recovers dates from a frozen left-column table when they aren't in-row), then pick the row with the LATEST Effective Date at-or-before the separation date via the pure `pickWorkLocationRow` (unit-pinned). Separation date is threaded `getJobSummaryIdentity(page, eid, { separationDate })` → `extractWorkLocation`. No separation date → latest row (current dept). No readable dates → first row (legacy fallback, no regression).
**Selector:** `jobSummary.workLocationTab` + `extractWorkLocation`/`pickWorkLocationRow` in `job-summary.ts`
**Tags:** job-summary, work-location, department, effective-date, separation, transfer, kronos-gate
**References:** `src/workflows/separations/CLAUDE.md` "Department gate"; `tests/unit/systems/ucpath/job-summary.test.ts`

## 2026-06-24 — SS Smart HR results grid: header-only scan misses the row under PeopleSoft nesting

**Tried:** `scanSsSmartHrResults` located the data table by a header row carrying "Transaction ID" + "Action" + "Approval Status", then mapped data columns by that header's positions.
**Failed because:** PeopleSoft can split the header and data into separate tables / nest cells, so the single-table header+data assumption found no rows. Live: an APPROVED TER for EID 10759273 ("Ava Tolles") was present (5 results visible) but returned empty, so separations' transaction-check fell through to "none", created a duplicate termination, and UCPath rejected the Empl ID ("UCPath did not recognize Empl ID").
**Fix:** The DOM step now only collects a cell-text matrix (each `<tr>`'s direct `:scope > td/th`); the parse is the pure `parseSsSmartHrRows` (unit-pinned) running TWO passes deduped by T-id — (A) header-keyed when a clean header exists, then (B) a header-INDEPENDENT pattern pass: any row with a T-id cell (`^T\d{4,}$`) + a status keyword, plus a 3-letter action code when present (so 5-letter BU "SDCMP" is never mistaken for the action). A debug log lists every scanned `T#=action/status` for live verification.
**Selector:** `ssSmartHRTransactions.*` + `parseSsSmartHrRows`/`scanSsSmartHrResults` in `ss-smart-hr.ts`
**Tags:** ss-smart-hr, transaction, termination, ter, grid, scan, header, nested-table, approval-status
**References:** `src/workflows/separations/CLAUDE.md` "Transaction check"; `tests/unit/systems/ucpath/ss-smart-hr.test.ts`
