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
**Selector:** `smartHR.continueButton`, `comments.commentsTextarea`, `comments.initiatorCommentsTextarea` in `selectors.ts` (imported into `transaction.ts` aliased as `commentsSelectors`)
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
**Fix:** Walk all 4 tabs in order before Save & Submit. After filling Initiator Comments on the last tab (Employee Experience), re-click Personal Data once more before clicking Save. Do NOT force-click a disabled Save — `waitForSaveEnabled` (`transaction.ts`) polls `btn.isEnabled()` for up to 15s and throws a precise "Save and Submit remained disabled … tab walk likely incomplete" error if it never enables (an incomplete tab walk is a real bug, not something to force past).
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
**Fix:** Read `personOrgSummary.personNameValue` first, then use the old leaf-text heuristic only as a fallback for legacy renderings. The fallback label list now contains UI copy only. (SUPERSEDED IN PART 2026-07-08: the NPC-id chain this prescribed turned out entirely DEAD on the live page — see the 2026-07-08 lesson below; `#PERSON_NAME_NAME` is now the primary arm.)
**Selector:** `personOrgSummary.personNameValue` in `selectors.ts`
**Tags:** person-org-summary, name, detail, header, heuristic, selector
**References:** `src/systems/ucpath/LESSONS.md#2026-07-08` (dead chain masked by the heuristic)

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

**Fix:** Keep both UCPath values separate: populate `EidResult.startDate` from Last Hire/first day of service and `EidResult.effectiveDate` from assignment EFFDT — but treat BOTH as **backend context only** (EID disambiguation, `crmMatch` date tolerance). The operator-facing person-lookup "Start Date" is sourced from **CRM** (First Day of Service), not from either UCPath date (superseded the original "display UCPath `startDate`" rule — see `src/workflows/person-lookup/CLAUDE.md` and the matching ucpath `CLAUDE.md` Lessons entry).

**Tags:** person-org-summary, last-hire, start-date, effdt, person-lookup, dashboard, crm

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

## 2026-06-24 — EVERY Workforce Job Summary tab must read the row in effect AS OF the separation date (not just Work Location)

**Tried:** Only the Work Location department was effective-date-gated (`extractWorkLocation` → `pickWorkLocationRow`). `extractJobInfo` (Job Code → Kuali Payroll Title Code/Title) still returned the FIRST job-coded `tr` (cells[0]=code, cells[1]=desc), ignoring Effective Date.
**Failed because:** Workforce Job Summary lists one effective-dated row per job state (hire, transfer, promotion, reclassification, …) and ALL tabs (Work Location, Job Information, …) are column-views of those SAME rows. Gating only the department meant a promotion/reclassification effective AFTER the separation could ship a post-separation Payroll Title to Kuali, even while the department resolved correctly — so the "most recent on or before the separation date" rule has to apply to everything extracted, not just the dept in the Work Location tab.
**Fix:** Generalized the picker to the pure, unit-pinned `pickEffectiveDatedRow<T extends { effectiveDate }>` (`pickWorkLocationRow` is now a thin wrapper). `extractJobInfo` scans ALL job-coded rows WITH their Effective Date (read in-row; a count-exact zip recovers dates from a frozen left-column table when absent — same two-pass approach as Work Location) and applies the same rule. Separation date is threaded `getJobSummaryIdentity(page, eid, { separationDate })` → BOTH `extractWorkLocation` AND `extractJobInfo`. No separation date → latest row (current job). No readable dates → first row (legacy fallback, no regression). `workLocationDateKey` kept as an alias of the renamed `effectiveDateKey`.
**Selector:** `jobSummary.workLocationTab`/`jobInformationTab` + `extractWorkLocation`/`extractJobInfo`/`pickEffectiveDatedRow` in `job-summary.ts`
**Tags:** job-summary, work-location, job-information, payroll-title, department, effective-date, separation, transfer, promotion, kronos-gate
**References:** `src/workflows/separations/CLAUDE.md` "Department gate"; `tests/unit/systems/ucpath/job-summary.test.ts`

## 2026-06-24 — SS Smart HR results grid: header-only scan misses the row under PeopleSoft nesting

**Tried:** `scanSsSmartHrResults` located the data table by a header row carrying "Transaction ID" + "Action" + "Approval Status", then mapped data columns by that header's positions.
**Failed because:** PeopleSoft can split the header and data into separate tables / nest cells, so the single-table header+data assumption found no rows. Live: an APPROVED TER for EID 10759273 ("Ava Tolles") was present (5 results visible) but returned empty, so separations' transaction-check fell through to "none", created a duplicate termination, and UCPath rejected the Empl ID ("UCPath did not recognize Empl ID").
**Fix:** The DOM step now only collects a cell-text matrix (each `<tr>`'s direct `:scope > td/th`); the parse is the pure `parseSsSmartHrRows` (unit-pinned) running TWO passes deduped by T-id — (A) header-keyed when a clean header exists, then (B) a header-INDEPENDENT pattern pass: any row with a T-id cell (`^T\d{4,}$`) + a status keyword, plus a 3-letter action code when present (so 5-letter BU "SDCMP" is never mistaken for the action). A debug log lists every scanned `T#=action/status` for live verification.
**Selector:** `ssSmartHRTransactions.*` + `parseSsSmartHrRows`/`scanSsSmartHrResults` in `ss-smart-hr.ts`
**Tags:** ss-smart-hr, transaction, termination, ter, grid, scan, header, nested-table, approval-status
**References:** `src/workflows/separations/CLAUDE.md` "Transaction check"; `tests/unit/systems/ucpath/ss-smart-hr.test.ts`

## 2026-06-24 — `__name is not defined` in page.evaluate (tsx keepNames instruments named helpers) — RECURRED 2026-07-13, now guarded

**Tried:** Defining a `const norm = (s) => (s ?? "").replace(/\s+/g," ").trim()` helper INSIDE a `page.evaluate(() => { ... })` body (the rewritten `extractWorkLocation` Work Location scan). **Recurred 2026-07-13** in `searchPerson`'s results-grid extraction (`const readField = (fieldId) => doc.getElementById(fieldId)…` inside `evaluateAll`), written by an author who had not read this lesson — the two warning comments already sitting in `job-summary.ts` did not stop it.
**Failed because:** The runtime is `tsx`, whose esbuild has `keepNames` on by default — it wraps every NAMED function/arrow binding with `__name(fn, "name")` and defines `var __name = …` at MODULE scope. When Playwright serializes the evaluate callback (`fn.toString()`) and runs it in the browser, the body references `__name`, which does not exist in the page context → `page.evaluate: ReferenceError: __name is not defined` at runtime (passes typecheck + unit tests; fails only live — surfaced on a live Job Summary fetch for EID 10797079, "Roye, Micah"). **The 2026-07-13 recurrence is the cautionary one: the throw was SWALLOWED** by a `catch` that returned a bare `{ found: true }`, so the separations I-9 check reported every matched person as "found" with NO Empl ID and NO name for a month — a dead code path that unit tests, typecheck, and the dashboard all read as success. A `__name` bug does not announce itself; it degrades.
**Fix:** Do NOT declare named helpers (`const x = (...) => …`, `function x(){}`) inside an `evaluate`/`evaluateHandle`/`$eval` body — INLINE the logic instead. Anonymous callbacks passed directly to `.map`/`.find`/`.findIndex`/`.some` are safe (no name binding → no `__name`). **This is now mechanically enforced** — `tests/unit/architecture/evaluate-named-fn.test.ts` scans every evaluated callback in `src/` and fails on any named binding, so the third recurrence is impossible. Pair it with the fail-loud rule: an evaluate that can't read what it came for must THROW, never return a plausible default.
**Selector:** `extractWorkLocation` / `extractJobInfo` in `job-summary.ts`, `searchPerson` in `navigate.ts` (and any `page.evaluate` body)
**Tags:** page.evaluate, __name, tsx, esbuild, keep-names, browser-context, named-function, reference-error, runtime, fail-loud, architecture-guard

## 2026-06-24 — Work Location tab times out because we never reached the DETAIL page (grid-id probe missed the results layout)

**Tried:** After a non-empty Job Summary search, `handleMultiRowGrid` decided "are we on a results grid?" via `searchResultsGrid` (`[id*="SEARCH_RESULT"]`/`.PSLEVEL1GRID`). Count 0 → assume PeopleSoft auto-redirected to the detail page; proceed to click the Work Location / Job Information tabs.
**Failed because:** For some live result layouts that grid probe returned 0 even though we were STILL on a search-results list (not the detail page), so we never drilled in. The detail page never loaded → `extractEmployeeName` read `<none>` and the Work Location tab click timed out 15s (the tab doesn't exist on a results list — no selector fallback can help). Live: EID 10641172 ("Results loaded" → "Detail-page name: <none>" → 15s tab timeout), recurring across the 2026-06-24 batch.
**Fix:** Two stages. (1) Replaced the grid-id probe with a DETAIL-PAGE-driven `ensureJobSummaryDetailPage`: gate on the person-name header OR Work Location tab being present in the SAME `getFormRoot` the extraction uses (so the gate exactly tracks extraction success — no false-negative regression). If the detail page isn't up: drill into the first non-terminated `searchResultRows` row; else a grid-independent `resultDrillLinks`; then fail LOUD with a precise "could not reach the detail page (scoped rows=…, EMPLID links=…)" message instead of the opaque tab timeout. (2) **The first version's row/drill selectors were GUESSED from screenshots (`[id*="SEARCH_RESULT"]`/`.PSLEVEL1GRID`/`a[id*="EMPLID"]`) and all returned 0 on the live page** — so `ensureJobSummaryDetailPage` then threw "scoped rows=0, EMPLID links=0" for EVERY multi-row EID (6 EIDs, 2026-06-24 separations batch). **Live-mapped 2026-06-24** (EID 10615924, Claudia Bran, 2 empl records): Workforce Job Summary is now the modern PeopleSoft **Fluid "Find an Existing Value"** page — **NO `#main_target_win0` iframe** (content native to the page body; the `getFormRoot` direct-URL/body branch is the one that runs, and the `waitForPeopleSoftProcessing(page.frameLocator("#main_target_win0"))` calls are harmless no-ops), and the results grid renders each row as a **clickable `tr[id^="trPTS_CFG_CL_STD_RSL"]`** whose own `onclick` (`submitAction_win0(..,'#ICRow<n>')`) drills to the detail page — **there is NO `<a>` drill-in link**. Re-mapped: `searchResultRows` → `tr[id^="trPTS_CFG_CL_STD_RSL"]`; `rowDrillInLink` → the row itself (`.or(row)`); `rowHrStatusCell` → the Payroll Status span `span[id*="PTS_CFG_CL_RSLT_NUI_SRCH13"]` ("Terminated"/"Active"); `searchResultsGrid` → `[id^="divgbrPTS_CFG_CL_STD_RSL"]`. Detail-page selectors (`#DERIVED_NAME_DISPLAY_NAME`, Work Location/Job Information `role="tab"`) and the position/job-code DOM scans all VERIFIED working on the Fluid detail page in the same session (dept 000412 / job code 004944 extracted). Classic-grid id guesses kept as trailing `.or()` fallbacks.
**Selector:** `jobSummary.searchResultRows`/`rowDrillInLink`/`rowHrStatusCell`/`searchResultsGrid`/`resultDrillLinks` (re-mapped to live Fluid ids) + `ensureJobSummaryDetailPage`/`waitForDetailPage` in `job-summary.ts`
**Tags:** job-summary, work-location, detail-page, drill-in, multi-row, search-results, fluid, find-existing-value, tab-timeout, fail-loud
**References:** `tests/unit/systems/ucpath/job-summary.test.ts`; live-verified via `playwright-cli` 2026-06-24 (EID 10615924)

## 2026-06-24 — Transaction-check must verify the TER's effective date, not just its existence

**Tried:** `findTerminationTransactionStatus` picked the first TER row from the SS Smart HR results grid and reused it (Approved) / deleted it (Pending) on existence alone.
**Failed because:** An employee can be terminated for a PRIOR job, leaving an old TER on the list that is NOT this separation. Reusing/skipping on that prior TER means the current separation's transaction never gets created (the screenshot case: a 2023-10-08 TER for "Megan Pateno" vs a 2026 separation).
**Fix:** When a Kuali separation date is supplied, drill into the newest TER (`ssSmartHRTransactions.transactionResultRow`), read its effective date from the Transaction Details page (`Effdt: YYYY-MM-DD` strip, `Start Date` cell fallback — via page-text regex, not an exact cell selector), and compare with the pure `isWithinSeparationWindow` (±`SEPARATION_TERMINATION_WINDOW_DAYS` = 14). Outside the window → `found:false`/`priorTerminationSkipped` → create a fresh transaction. The newest TER suffices; `ucpath-transaction`'s EID+effdt existence check backstops the rare newer-unrelated-TER case. Unreadable effdt → **create fresh** (`priorTerminationSkipped`) + `log.warn`, NOT reuse (see the drill-in selector note below).
**Selector:** `ssSmartHRTransactions.transactionResultRow` + `findTerminationTransactionStatus`/`readTerminationEffectiveDate`/`isWithinSeparationWindow` in `ss-smart-hr.ts`
**Tags:** ss-smart-hr, transaction, termination, ter, effective-date, effdt, prior-termination, separation, window
**References:** `src/workflows/separations/CLAUDE.md` "Transaction check"; `tests/unit/systems/ucpath/ss-smart-hr.test.ts`

## 2026-06-24 — SS Smart HR drill-in target is the result ROW `<tr>`, not a Transaction-ID link

**Tried:** `transactionResultLink` drilled into a TER by `getByRole("link", { name: transactionId })` (the effective-date gating above was authored from screenshots, never `playwright-cli`-verified).
**Failed because:** On the live SS Smart HR results grid the Transaction ID column is a **display-only `<span>`** (`PSEDITBOX_DISPONLY`), NOT a hyperlink — there is no link named after the txn id. The click timed out after 10s, `readTerminationEffectiveDate` returned `""`, and the step fell back to **reusing** the TER. Live incident (Micah Roye, EID 10797079, doc #4323): an APPROVED TER `T001928408` with **Effdt 2025-07-01** was reused for an **06/17/2026** separation — ~351 days apart — so the real termination was never created (logs: `selector fallback triggered: ss smart hr transaction drill-in link (click failed after 10002ms)`).
**Fix:** The clickable element is the result **ROW** `<tr id^="trPTS_CFG_CL_STD_RSL">` (it carries the row onclick). `transactionResultRow` filters that row by the per-row-unique txn-id text, with the old link as a `.or()` fallback for any view that does render a hyperlink. Live-verified via `playwright-cli` (EID 10797079 → row `T001928408` → `Effdt: 2025-07-01` reads; `rowMatchCount: 1`). Also flipped the unreadable-effdt fallback from reuse → **create fresh** (`priorTerminationSkipped`): reusing an unverifiable TER is the exact failure mode above; `ucpath-transaction`'s EID+effdt `findExistingTerminationTransaction` (keyed on the CURRENT effective date) is the precise duplicate-submit backstop.
**Selector:** `ssSmartHRTransactions.transactionResultRow` (renamed from `transactionResultLink`)
**Tags:** ss-smart-hr, transaction, drill-in, row, span, peoplesoft, effdt, prior-termination, live-verified
**References:** `tests/unit/systems/ucpath/ss-smart-hr.test.ts`; `src/workflows/separations/CLAUDE.md` "Transaction check"

## 2026-07-01 — Onboarding duplicate-hire probe: search SS Smart HR by NAME, not EID

**Tried:** Reusing separations' EID-keyed existence check (`findTerminationTransactionStatus` / `findExistingTerminationTransaction`, which search SS Smart HR by Empl ID) for onboarding's pre-submit duplicate-hire guard.
**Failed because:** A brand-new hire has **no Empl ID** — the Person ID column renders "NEW" until the Smart HR hire transaction is processed (documented on `clickSaveAndSubmit`). An EID search returns nothing, so the probe would never see the in-flight hire and a retry would re-file it. Onboarding also only reaches the transaction step for a person NOT already in UCPath (rehires short-circuit earlier), so there is no EID to key on at all.
**Fix:** `findExistingHireTransaction` (`ss-smart-hr.ts`) searches the SS Smart HR Transactions page by the **Name** box (`ssSmartHRTransactions.nameInput`, `buildHireSearchName` → `"Last,First"`), reuses the shared `scanSsSmartHrResults` + `parseSsSmartHrRows` grid parse, and matches a `HIR`/`REH` action via the pure `pickHireRow` (the hire-family analogue of `pickTerminationRow`). Best-effort: a failure/empty-name degrades to `found:false` so a probe glitch never blocks a legit hire. The grid exposes no effdt/template column, so the match is name + hire-action (effdt/template are logged only).
**Selector:** `ssSmartHRTransactions.nameInput` / `.searchButton` (reused) + `findExistingHireTransaction`/`pickHireRow`/`buildHireSearchName` in `ss-smart-hr.ts`
**Tags:** ss-smart-hr, onboarding, hire, hir, reh, duplicate, idempotency, name-search, new-hire, no-eid
**References:** `tests/unit/systems/ucpath/ss-smart-hr.test.ts`; `src/workflows/onboarding/CLAUDE.md` "Retry safety". **NEEDS LIVE VERIFY:** the Name search returns a pending hire and `Last,First` is the right key format. **(Superseded-in-part by the next lesson: name+hire-action alone is NOT sufficient — the skip is now approval-status + exact-effdt gated.)**

## 2026-07-01 — Onboarding duplicate-hire probe must be high-confidence (approval-status + exact-effdt gated), not name+action alone

**Tried:** `findExistingHireTransaction` skipped the Smart HR hire submit (stamped `status:"Already Submitted"`) whenever a `HIR`/`REH` row matched the person's NAME on the SS Smart HR list — no approval-status and no effective-date disambiguation.
**Failed because:** The SS Smart HR "Name" search is a PeopleSoft **begins-with** match, so the sole person filter was too loose, in two ways: (1) **False positive → silently skips a legit hire.** A DIFFERENT same-named person ("Nguyen,John" hired last week, HIR row still on the list) makes today's onboarding of a different "Nguyen,John" match that stale row → the workflow stamps "Already Submitted" and NEVER hires the real person — on the FIRST run, not just a retry. (2) **Status-blind skip.** The skip fired on any HIR/REH regardless of `approvalStatus`, so a prior hire that was **Denied / Error / Pushed Back** (a hire that did NOT go through and legitimately needs resubmitting) also tripped the skip and could never be resubmitted.
**Fix:** The skip is now a HIGH-CONFIDENCE decision in the pure `decideHireDuplicateSkip` (`ss-smart-hr.ts`, unit-pinned) — `skip:true` requires ALL of: (a) a HIR/REH row (`pickHireRow`); (b) an in-flight/approved approval status — `Pending`/`Approved`/`Manually Processed` (`isHireInFlightStatus` / `HIRE_IN_FLIGHT_APPROVAL_STATUSES`; a terminal-failed hire must be resubmitted, so it never skips); (c) the hire's effective date matches THIS run's `data.effectiveDate` EXACTLY (`hireEffectiveDateMatches`, same-day, ISO-or-US), read by drilling the row into Transaction Details (`readHireEffectiveDate`, mirroring separations' `readTerminationEffectiveDate`, reusing the same `readTransactionEffdt` glue + `transactionResultRow` drill-in). **Fail-open:** an unreadable effdt, a non-matching effdt, a non-hire action, a terminal-failed status, an empty name, or any probe error all resolve to `found:false` → SUBMIT. Rationale (conservative, irreversible hire logic): a false SKIP never hires the real person, which is worse than the probe-guarded double-submit risk, so uncertainty must resolve to "submit," never "skip."
**Selector:** `ssSmartHRTransactions.transactionResultRow` (reused drill-in) + `decideHireDuplicateSkip`/`isHireInFlightStatus`/`hireEffectiveDateMatches`/`readHireEffectiveDate` in `ss-smart-hr.ts`
**Tags:** ss-smart-hr, onboarding, hire, hir, reh, duplicate, idempotency, approval-status, effdt, high-confidence, fail-open, name-search
**References:** `tests/unit/systems/ucpath/ss-smart-hr.test.ts`; `src/workflows/onboarding/CLAUDE.md` "Retry safety". **NEEDS LIVE VERIFY:** a HIR row drills into a detail page exposing `Effdt:` (the drill-in ROW selector + `Effdt:` read are TER-live-verified 2026-06-24; the HIR path reuses the same grid/detail shape but is not yet live-exercised).

## 2026-07-01 — Person-search + submit outcome must wait for a DEFINITIVE signal, not sample once

**Tried:** (a) `searchPerson` classified new-hire-vs-rehire from a SINGLE `dismissPeopleSoftDialog` probe taken right after `networkidle`; (b) `clickCreateTransaction` / `clickSaveAndSubmit` read `errorBanner.count()` once after a fixed `waitForTimeout` + short spinner wait.
**Failed because:** Both sample a race at one instant. (a) If the probe reads the page before EITHER the confirmation dialog or the results grid has rendered, a real rehire (grid still painting) is misclassified as a new hire → onboarding creates a **duplicate person**. (b) A PeopleSoft error banner that renders LATE reads `count() === 0` at that instant, so a transaction that actually errored returns `{ success: true }`.
**Fix:** RACE the two definitive outcomes and decide only once one is present. (a) `raceNewHireVsRehireSignal` polls {results grid with an employee-id row → rehire} vs {`#ICOK` dialog present → new hire} (grid checked first so it wins a tie), classified by the pure `classifyPersonSearchSignal`; `none` (timeout) falls back to the legacy single probe (never worse than before). Added non-destructive `isPeopleSoftDialogPresent`. (b) `waitForTransactionOutcome` polls {error banner visible} vs {success marker visible — reason-code dropdown for create, confirmation-OK for submit}, classified by the pure `classifyOutcomeSignals` (error wins a tie); timeout falls back to the legacy `count()` check.
**Selector:** `personSearch.resultRows`, `#ICOK` (dialog) / `smartHR.errorBanner`, `smartHR.reasonCodeSelect`, `smartHR.confirmationOkButton`
**Tags:** person-search, new-hire, rehire, race, error-banner, success-marker, transaction, submit, flakiness, duplicate-person
**References:** `tests/unit/systems/ucpath/navigate.test.ts`, `tests/unit/systems/ucpath/transaction.test.ts`. **NEEDS LIVE VERIFY:** reason-code dropdown (create) + confirmation-OK (submit) are reliable success markers on the live Smart HR pages.

## 2026-07-01 — Person-search: the National Id magnifier is LOAD-BEARING (its click fires the FieldChange that ENABLES Search); its "no prompt values" dialog + `#pt_modalMask` are on the MAIN page, not the iframe

**Tried:** `searchPerson` clicked the National Id lookup magnifier (`personSearch.ssnLookupButton` = `DERIVED_HCR_SM_SM_CHAR_INPUT$prompt$0`) to "validate" the National Id, then dismissed the resulting dialog with `dismissPeopleSoftDialog` (`#ICOK`) and cleared the mask with `ensureNoBlockingModal`, which waited for `#pt_modalMask` INSIDE the `#main_target_win0` iframe (`frame.locator("#pt_modalMask")`).
**Failed because:** Two compounding faults. (1) The National Id field has NO prompt table, so the magnifier ALWAYS raises a "There are no prompt values currently available for this field. (4,4) — The prompt table for this field is currently not specified." dialog — even for a COMPLETE record (valid 9-digit NID + first/last + DOB), so it was never about missing criteria. (2) That dialog AND its `#pt_modalMask` (class `ps_modalmask`, `display:block`, z-index 210) render on the **MAIN page document**, NOT inside the iframe — so `ensureNoBlockingModal`'s `frame.locator("#pt_modalMask")` matched nothing, treated the mask as already hidden, and returned instantly while the real main-page mask kept overlaying the iframe and intercepting the in-frame Search click for the full 10 s (`selector fallback triggered: ucpath person search submit button (click failed after 10000ms) … Timeout`, twice, then the run failed at `person-search`). The dialog also renders client-side slightly AFTER the magnifier click's networkidle resolves, so the early `dismissPeopleSoftDialog` fired before it existed.
**Fix:** (CORRECTED 2026-07-01 — the real DAEMON disproved the interactive finding.) The magnifier click is LOAD-BEARING — it fires the PeopleSoft FieldChange postback that ENABLES the Search button. The earlier "filling criteria alone enables Search, so skip the magnifier" held ONLY in an interactive `playwright-cli` session (dummy NID 123456789); in the real DAEMON flow the fields are filled back-to-back and Search stays `PSPUSHBUTTONDISABLED` ("Search button still disabled" → the 10s click timeout — live on charlottee, a COMPLETE record with SSN + DOB). So `searchPerson` clicks the magnifier via `fireNationalIdLookupAndClearDialog(page, frame)`: click `personSearch.ssnLookupButton` → POLL for the client-side dialog (`isPeopleSoftDialogPresent`) → dismiss the MAIN-PAGE `#ICOK` (`dismissPeopleSoftDialog` scans every frame incl. main) → wait for the MAIN-PAGE `#pt_modalMask` (`page.locator("#pt_modalMask, .ps_modalmask")`, top document) to go hidden, retrying up to 4× → then `waitForPersonSearchButtonEnabled` (now enabled by the postback) → Search `safeClick`. The main-page-vs-iframe mask insight in "Failed because" STANDS; only the "skip the magnifier" conclusion was wrong. The `personSearchCriteriaSufficient` fail-fast guard (neither SSN nor DOB → throw) is kept.
**Selector:** `personSearch.searchSubmitButton` / `personSearch.ssnLookupButton` in `selectors.ts`; `waitForPersonSearchButtonEnabled` in `navigate.ts`
**Tags:** person-search, national-id, magnifier, prompt-table, modal, mask, pt_modalmask, main-page, iframe, search-button, disabled, enabled, timeout, onboarding
**References:** `tests/unit/systems/ucpath/navigate.test.ts`. LIVE-VERIFIED END-TO-END 2026-07-01 — real daemon onboarding dry-run (charlottee, complete record): person-search → outcome `duplicate-dialog` → `new-hire` → I-9 search-first (existing profile 2189301) → dry-run terminal `completed`. (The earlier dummy-NID interactive check mis-concluded the magnifier was unnecessary — see the corrected Fix above.)

## 2026-07-08 — Person Org Summary name chain was entirely DEAD live; the body-scan heuristic was silently carrying production (`#PERSON_NAME_NAME` is the real anchor)

**Tried:** Trusting the `personOrgSummary.personNameValue` 4-arm `.or()` chain (`#PERSON_NPC_VW_NAME_DISPLAY` → `#PERSON_NPC_VW_NAME_DISPL` → `#PERSON_NPC_VW_NAME` → `[id*='PERSON_NPC_VW'][id*='NAME']`), carrying a `verified 2026-05-15` date, as the primary name source on the detail page — with the generic leaf-text body-scan heuristic in `person-org-summary.ts` as a legacy fallback.

**Failed because:** A live DOM probe (2026-07-08, EID 10618178, `getElementById` per arm inside `#main_target_win0`) found NO element for ANY of the four arms — the wildcard included — while the name renders in `<span id="PERSON_NAME_NAME" class="PABOLD11TEXT">`. So the "verified" chain had been dead for an unknown period and every production name extraction was actually served by the unverified body-scan heuristic, invisible until the 2026-07 fail-loud audit put a `log.warn` on that fallback path. Broader gotcha: a verified-dated `.or()` chain can be entirely dead while a downstream heuristic masks it, and an a11y snapshot cannot verify id-based selectors — only a per-arm DOM id probe shows which arm actually fires.

**Fix:** `#PERSON_NAME_NAME` added as the chain's primary arm (`verified 2026-07-08`); the NPC arms demoted to legacy fallbacks. The heuristic keeps its loud `selector fallback triggered` warn so any future chain death surfaces on the Selector Health Panel instead of hiding again. When live-verifying a chain, probe EVERY arm (`getElementById` each), not just "did the locator resolve".

**Selector:** `personOrgSummary.personNameValue` in `selectors.ts`
**Tags:** person-org-summary, name, detail, header, selector, dead-chain, fallback, heuristic, live-probe, selector-health
**References:** `src/systems/ucpath/LESSONS.md#2026-05-15` (the guidance this supersedes in part); `src/systems/ucpath/CLAUDE.md` 2026-05-15 lesson.

## 2026-07-13 — Person-search results grid was NEVER matched live: `personSearch.resultRows` scored 0 hits, so every FOUND person timed out as "ambiguous"

**Tried:** Detecting a person-search match (the rehire / found-in-UCPath signal) with `personSearch.resultRows` = `[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr` filtered on `hasText: /\d{5,}/`, carrying a `verified 2026-04-01` date. `raceNewHireVsRehireSignal` polls that locator's `.count()` against the "no matching person" `#ICOK` dialog.

**Failed because:** The live PERSON_RESULTS page carries **neither** anchor. Its grid is `table#l0PERSON$0`, with per-row field ids (`EMPLID$0`, `HTML2$0` legal first, `HTML4$0` legal last) — no `SEARCH_RESULT` in any id, no `.PSLEVEL1GRID` class. Probed live on a real match: `[id*="SEARCH_RESULT"] tr, .PSLEVEL1GRID tr` → **0 elements**; `span[id^="EMPLID$"]` → 1. So the grid arm could never win the race: a genuine match sat there until the 15s window expired and the run **threw the "neither the results grid nor the dialog appeared" ambiguity error**. The failure was invisible because the fail-loud guard did exactly its job — it refused to guess — so it read as flakiness rather than a dead selector. Real impact (2026-07-10 i9 batch): **25 of 104 HR-Tasks match runs failed this way**; the 79 that "worked" were all `duplicate-dialog` (not-found), i.e. the only outcome the code could actually detect. A found person was 100% unreportable.

**Fix:** `personSearch.resultRows` replaced by **`personSearch.resultEmplIdCells`** = `table[id^="l0PERSON$"] span[id^="EMPLID$"]` (one cell per matched person; `verified 2026-07-13`). `searchPerson`'s match extraction reads each row's fields by their stable per-row ids (`EMPLID$<n>` / `HTML2$<n>` / `HTML4$<n>`) instead of walking `td`s positionally — the grid nests tables, so positional cell-walking double-reads and mis-assigns names. Its `catch` now `log.warn`s the extraction failure instead of silently returning a bare `{found:true}`.

**Generalizable gotcha:** a `verified <date>` selector whose ONLY consumer is a *race against another signal* can be dead indefinitely without a single error naming it — the race just always resolves the other way (or times out). When a fail-loud guard fires repeatedly on one branch, **suspect the branch that never fires**, and probe both arms' `.count()` on a live page that is supposed to satisfy the silent one.

**Selector:** `personSearch.resultEmplIdCells` in `selectors.ts` (replaces `personSearch.resultRows`)
**Tags:** person-search, results-grid, rehire, duplicate, emplid, dead-selector, race, ambiguous, fail-loud, l0person, match-mode
**References:** `src/systems/ucpath/navigate.ts` (`raceNewHireVsRehireSignal`, `searchPerson`); `src/workflows/person-lookup/CLAUDE.md`. Live-probed 2026-07-13 via `playwright-cli` + Duo Autopilot on a real PERSON_SEARCH → PERSON_RESULTS match.

## 2026-07-16 — Last Day Worked in comments does not set the UCPath transaction field

**Tried:** Carrying the reconciled Last Day Worked only inside the Smart HR comments, with no write to the dedicated field or override checkbox.
**Failed because:** A live read-only termination showed comments saying Last Day Worked 06/14/2026 while `HR_TBH_SCR_WRK_TBH_DATE$3` displayed 06/12/2026 and `HR_TBH_SCR_WRK_TBH_CHK2$3` was the separate override. Comments are audit context, not transaction state.
**Fix:** Added input-specific termination selectors and `fillTerminationLastDateWorked`: check the override, fill the reconciled date, re-resolve both controls, and require checked + exact value readback. Separations converts any uncertainty to fatal `LastDateWorkedVerificationError` before submit and records provenance only after success.
**Tags:** termination, last-date-worked, override, peoplesoft, readback, provenance, fail-loud, live-verified
**References:** **Corrected 2026-07-28** — this entry's selectors and its "require EACH original control to detach/hide" rule were mapped against a READ-ONLY submitted record and could not run on the editable form. Only the override checkbox round-trips; see `#2026-07-28`.

## 2026-07-28 — Termination LDW controls were mapped on a READ-ONLY record: the override matched PeopleSoft's hidden `$chk$` twin, and the date field was made to wait for a refresh it never does

**Tried:** Writing the reconciled Last Date Worked with the 2026-07-16 pair — `overrideLastDateWorkedCheckbox` = `input[id^="HR_TBH_SCR_WRK_TBH_CHK2$"]`, and `requirePeopleSoftControlRefresh` around BOTH the override click and the date input's `Tab` press (each original control had to detach/hide during a PeopleSoft fragment refresh before readback).

**Failed because:** Both halves were mapped from a **read-only submitted transaction**, whose DOM differs from the editable form the automation actually drives. On the live editable UC_VOL_TERM form: (1) PeopleSoft renders every checkbox as the visible input **plus a hidden companion** `<FIELD>$chk$<row>` that carries the posted Y/N — `HR_TBH_SCR_WRK_TBH_CHK2$3` **and** `HR_TBH_SCR_WRK_TBH_CHK2$chk$3` both match the bare prefix, so the very first `isChecked()` threw `strict mode violation: ... resolved to 2 elements` and killed the run before any write (real failure 2026-07-28 08:00, doc 4453 / EID 10859396 — the form was otherwise correct, only the readback was broken). A read-only record renders no `$chk$` companion, which is why the prefix looked unique. (2) The date input's only handler is `onchange="addchg_win0(this);oChange_win0=this;"` — PeopleSoft dirty-tracking, **no `submitAction_win0`**, so no server round-trip: after fill + `Tab` the SAME input node is still connected. Requiring it to detach/hide could only ever burn 15s and throw. The override checkbox is the opposite (`onclick` = `…addchg_win0(this);submitAction_win0(this.form,this.id);`) — its node genuinely IS replaced, so its refresh wait is correct and stays.

**Fix:** `input[type="checkbox"][id^="HR_TBH_SCR_WRK_TBH_CHK2$"]` (element-type constraint is load-bearing, not cosmetic — it excludes the `$chk$` twin; the `id^=` prefix still frees the row suffix). In `fillTerminationLastDateWorked`, the date write is now `safeFill` → `press("Tab")` (blur raises the `change` that `fill` alone does not) → `waitForPeopleSoftProcessing` → re-resolve → exact readback; **no detach requirement on the date field**. Also live-confirmed: UC_VOL_TERM **pre-checks** the override and pre-fills Last Date Worked with (effective date − 1) — we still write and verify our own reconciled date rather than trusting the default. Pinned by `tests/unit/systems/ucpath/selectors.test.ts` (both selectors keep their element-type constraint) and the `fillTerminationLastDateWorked` block in `transaction.test.ts` (date write must NOT request an `elementHandle`; override refresh armed before the click).

**Generalizable gotcha:** verify a selector against the **page state the automation drives**. A read-only view of the same record is a different DOM — display-only PeopleSoft fields drop their hidden post-companions and their FieldChange handlers, so a selector or a wait mapped there can be structurally impossible on the editable form while looking perfectly verified. When a control's behavior matters (does this write round-trip?), read its `onclick`/`onchange` attribute live rather than assuming symmetric behavior across a form's fields.

**Selector:** `termination.overrideLastDateWorkedCheckbox`, `termination.lastDateWorkedInput` in `selectors.ts`
**Tags:** termination, last-date-worked, override, checkbox, strict-mode, hidden-input, peoplesoft, fragment-refresh, submitaction, readback, fail-loud, live-verified, read-only-dom
**References:** Supersedes the mapping in `#2026-07-16`. Live-probed 2026-07-28 via `playwright-cli` + Duo Autopilot on a real UC_VOL_TERM transaction (created, inspected, **cancelled without saving** — the in-progress grid was confirmed clean afterward).

## 2026-08-04 — A `T…` transaction NUMBER is issued regardless of outcome — success needs the (number, approvalStatus) PAIR

**Tried:** `interpretPostSubmitTxnReadback` (`transaction.ts`) validated a post-submit Smart HR receipt with `/^T\d{6,}$/` — the transaction NUMBER alone — and onboarding stamped `transactionNumber` + `status: "Done"` whenever that matched.
**Failed because:** UCPath issues a well-formed `T…` number for a Smart HR transaction **regardless of its outcome**. Live transaction `T002204014` is **Denied** and carries a perfectly valid number, so the number-only rule stamped a REFUSED UCPath transaction as a successful receipt — in the system that files real hires. Two related holes: (1) the readback reused `findExistingHireTransaction`, the PRE-submit duplicate guard, which fails OPEN and by design only ever reports an in-flight/approved hire — so a Denied hire came back indistinguishable from "the number could not be read", and the operator was told to go look up a number for a transaction UCPath had rejected; (2) `Pending` (the normal state right after a submit, awaiting an approver) was collapsed into plain "Done".
**Fix:** Success is now proved by the PAIR. `interpretPostSubmitTxnReadback(txnNumber, approvalStatus)` returns a discriminated `outcome` — `accepted` (`Approved`/`Manually Processed`) · `pending` (`Pending`, a real intermediate the caller surfaces distinctly) · `refused` (`Denied`/`Error`/`Pushed Back`/`Recycled`/`Cancelled`) · `unknown` (no readable number, or a number with a blank/unrecognized status) — plus a single `accepted` boolean. Anything not POSITIVELY recognized stays `unknown`; an unreadable status is never "assume approved". The number-only signature is GONE rather than deprecated so no caller can re-enter the bug. A dedicated post-submit reader, `readSubmittedHireReceipt` (`ss-smart-hr.ts`), replaces the duplicate-guard reuse: it reports whatever status the receipt carries, still effdt-gated to THIS run exactly, and never throws (the hire is already submitted — failing the run would invite a retry that files a DUPLICATE hire), so every uncertainty lands as a loud tracker row instead. Onboarding now stamps `Done` / `Pending Approval` / `Transaction Refused` / `Needs Review` with `transactionApprovalStatus` and an explicit marker on each non-success branch.
**Selector:** `ssSmartHRTransactions.transactionDetailTxnId` (`span#UC_SS_TRANSACT_UC_TRANSACT_ID`) + `ssSmartHRTransactions.transactionDetailApprovalStatus` (`span#UC_SS_TRANSACT_APPR_STATUS`), verified 2026-08-04 by read-only probe across 3 templates × 3 statuses (HIR/Approved, REH/Denied `T002204014`, XFR/Pending) — exactly one node each. These are BARE spans with no label association, so the PeopleSoft `RECORD_FIELD` id is the correct anchor **on this route only** — do NOT generalize it to Kuali, where role+label remains the rule. The detail route renders at TOP level (`getContentFrame()` resolves to nothing there) while the results grid it is reached from is served inside `#main_target_win0`, so `readSsSmartHrReceiptFields` probes both roots for the same unique id and fails loud when neither resolves.
**Tags:** ss-smart-hr, transaction, receipt, approval-status, denied, pending, onboarding, fail-loud, record-field, deep-link, live-verified
**References:** `tests/unit/systems/ucpath/transaction.test.ts` (`classifyTxnApprovalStatus`, `interpretPostSubmitTxnReadback`); `tests/unit/systems/ucpath/ss-smart-hr.test.ts` (`receiptMatchesRequestedTransaction`); `src/workflows/onboarding/CLAUDE.md`. **URL is never state evidence on this route:** the addressable form is `?Action=U&UC_TRANSACT_ID=T…`, but the BARE url is not a deep link — a reload silently returns to the search form with a byte-identical URL, and an UNKNOWN id renders the ordinary search form with NO error and NO banner. "The page loaded" proves nothing; assert the Transaction ID field RESOLVED **and** equals the requested id (`receiptMatchesRequestedTransaction`, pure + unit-pinned).

## 2026-08-04 — Person Org Summary search inputs gained a `$op` operator in their accessible name; every `exact: true` textbox arm went dead while the non-exact one silently survived

**Tried:** Searching Person Organizational Summary by name via the registry arms
`personOrgSummary.lastNameInput` (`getByRole("textbox", { name: "Last Name" })`,
non-exact) then `personOrgSummary.nameInput`
(`getByRole("textbox", { name: "Name", exact: true })`), as mapped 2026-04-24.
**Failed because:** PeopleSoft now points each search input's `aria-labelledby`
at the label **and** the adjacent operator `<select>` (`<field>$op`, the
"begins with" dropdown), so the computed accessible names became
`"Empl ID begins with"`, `"Last Name begins with"`, `"Name begins with"`. The
`exact: true` arms match **zero** elements and die on the 10s fill timeout, so
`nameInput` and `emplIdInput` were both structurally dead. `lastNameInput`
survived purely by accident — it was the one arm written non-exact, and
`"Last Name"` is still a substring of `"Last Name begins with"`. That asymmetry
is what made the break look like a data problem instead of a selector problem:
the run got far enough to log `Searching: Last Name="Paz", Name="Esperanza"`
and fill Last Name in 11ms before timing out, and the failure screenshot shows
a perfectly normal search form with the field plainly visible. All 10 name-mode
lookups in a batch failed identically at `step=searching`. Note the naive
repair — dropping `exact` — is also wrong: a bare `"Name"` substring matches
BOTH `"Name begins with"` and `"Last Name begins with"`, i.e. a strict-mode
violation rather than a timeout.
**Fix:** Anchor the role name with a regex and add the record.field element id
as a second, live-verified arm:
`f.getByRole("textbox", { name: /^Name\b/ }).or(f.locator("#UC_ORG_SUM_VW_NAME_DISPLAY")).first()`
— `^Label\b` pins to the start so each pattern resolves exactly one box and
stays correct if the operator text changes (`contains`, `=`, …). Ids are
`UC_ORG_SUM_VW_EMPLID` / `UC_ORG_SUM_VW_PARTNER_LAST_NAME` /
`UC_ORG_SUM_VW_NAME_DISPLAY`; both arms were probed on the same live page, so
neither is an unverified guess.

**Blast radius — the non-exact arms are the safe ones.** The UCPath search form
that production actually drives for EID lookups is **Workforce Job Summary**
(separations / onboarding), and it is structurally immune: `jobSummary` exposes
exactly one textbox selector, `emplIdInput`, written **non-exact**
(`getByRole("textbox", { name: "Empl ID" })`), so `"Empl ID"` still matches
`"Empl ID begins with"` by substring — the same accident that kept
`personOrgSummary.lastNameInput` alive. Its only `exact: true` is the Search
BUTTON, which has no `$op` sibling. `payPathActions` still carries the fragile
`exact: true` textbox shape on a `$op`-bearing search grid and would break the
same way, but no current workflow drives it (operator confirmed 2026-08-04:
"don't use paypath actions, use workforce job summary"), so it is left as-is
rather than edited unverified. **The rule to carry forward: on a PeopleSoft
Find-an-Existing-Value form, never pin a search textbox with `exact: true` on
the bare label — the operator text is part of the accessible name.**
**Selector:** `personOrgSummary.emplIdInput`, `personOrgSummary.lastNameInput`,
`personOrgSummary.nameInput`
**Tags:** person-org-summary, search, accessible-name, aria-labelledby, operator,
begins-with, exact, strict-mode, getbyrole, peoplesoft, person-lookup, selector-drift
**References:** Live-probed 2026-08-04 via `npm run sel:browser` + Duo Autopilot
(read-only). Related: `#2026-07-08` and `#2026-07-13`, the other two cases where a
Person-Org/person-search chain was dead live while looking verified in the registry.

## 2026-08-04 — A UCPath name-search "Not found" is usually a MISREAD FIRST NAME, not a missing record; and an EID-mode "Not found" can be a plain false negative

**Tried:** Treating `person-lookup` verdicts as authoritative while resolving 216
handwritten Emergency Contact forms: a name search returning "Not found" was
read as "this person has no UCPath record", and an EID-mode search returning
"Not found" was read as "this EID does not exist".
**Failed because:** Both verdicts are far weaker than they look.
(1) **Name searches fail on a single wrong letter, and the wrong letter is
usually mine, not the employee's.** Three of four "unresolvable" people resolved
immediately once the name line was re-read at 450 DPI: `Megan`→**`Merav`** Price
(10683737), `Dogan`→**`Dogen`** Shiota (10712336), and `Pina`→**`Piña`**
Contreras (10682312 — the accent is load-bearing; both unaccented spellings
returned "Not found" in two separate sessions days apart). A 200-DPI identity
crop is enough to transcribe an EID but NOT enough to trust a first name.
(2) **An EID-mode "Not found" can be transient.** Andrew Reyes' form EID
10495223 returned "Not found" by EID, but a name search returned that exact EID
(UCPath stores him as `Reyes-Gomez, Andrew`). Had the negative been trusted, a
correct form would have been sent back to the operator as bad data.
(3) Compound surnames defeat the naive `First Last` → `Last, First` flip:
`lsanchezhernandez@ucsd.edu` revealed the surname was **Sanchez Hernandez**,
which is why `Sanchez, Lucero` missed.
**Fix:** Before declaring anyone unresolvable — (a) **re-read the name at
≥450 DPI**, cropping the name line specifically, and (b) **cross-check it
against the campus email on the form**, which is the cheapest available oracle
for spelling: `meravprice@gmail.com` contradicted "Megan" on the very first
pass and would have saved three failed searches. `mschaever@ucsd.edu`
corroborated "Schaever", correctly leaving him as the one genuine no-record
case out of 216. (c) **Re-run every negative once** — a repeat "Not found"
across two runs is evidence; a single one is not. (d) For compound surnames,
derive the search key from the email local-part rather than by flipping tokens.
**Selector:** `personOrgSummary.nameInput`, `personOrgSummary.lastNameInput`
**Tags:** person-lookup, name-search, not-found, false-negative, accent, unicode,
compound-surname, campus-email, transcription, ocr, emergency-contact, onbase
**References:** Companion to the `#2026-08-04` `$op` accessible-name entry above
(that one made these searches fail at all; this one is about interpreting their
results). Live batch: 216 EC forms, 208 filed.
