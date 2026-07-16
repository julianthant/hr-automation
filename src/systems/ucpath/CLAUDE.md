# UCPath Module

PeopleSoft HR automation: Smart HR transactions, person search, job summary extraction, emergency contact forms, and the ActionPlan execution pattern. Used by onboarding, work-study, emergency-contact, person-lookup, and separations workflows.

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

## Iframe Rule

**ALL PeopleSoft interactions must go through `getContentFrame(page)`** which returns the `#main_target_win0` FrameLocator. Never use `#ptifrmtgtframe` (older, incorrect frame ID).

## PeopleSoft Grid Index Gotcha

Position number fill in `fillJobData` triggers a page refresh that **changes grid indices** (e.g., `$11` → `$0`). All grid inputs use `.or()` chaining for cross-refresh selector compatibility. Always use `input[id="..."]` (not just `[id="..."]`) to avoid matching wrapper `<div>` elements.

## Smart HR Transaction Steps (transaction.ts)

1. `clickSmartHRTransactions` — opens form, collapses sidebar
2. `selectTemplate` — fills template textbox (e.g., `UC_FULL_HIRE`)
3. `enterEffectiveDate` — MM/DD/YYYY
4. `clickCreateTransaction` — checks for errors, returns `TransactionResult`
5. `selectReasonCode` — dropdown + Continue (JS fallback via `submitAction_win0()`)
6. `fillPersonalData` — name, DOB, SSN, address, phone (Mobile-Personal), email (Home), tracker profile ID
7. `fillComments` — both Comments and Initiator Comments textareas
8. Separations only: `fillTerminationLastDateWorked` — checks Override Last Date Worked, fills the reconciled date, requires each pre-action control to detach/hide during the PeopleSoft fragment refresh, then positively verifies both freshly resolved controls
9. `clickJobDataTab` / `fillJobData` — position, classification, comp rate, rate value, end date
10. `clickEarnsDistTab` / `clickEmployeeExperienceTab` — visit only (no fill)
11. `clickSaveAndSubmit` — after confirmation OK, reopens the Smart HR row, scrolls to the lower readback area, and extracts the `T...` transaction number

## SS Smart HR Transactions search + pending-delete (ss-smart-hr.ts, transaction.ts)

Used by separations' `transaction-check` step (see `src/workflows/separations/CLAUDE.md`).

- `findTerminationTransactionStatus(page, eid)` (`ss-smart-hr.ts`) — navigates to **SS Smart HR Transactions** (the self-service search page, distinct from the standard Smart HR Transactions create page), searches by Empl ID, scans the results grid (header-keyed columns: Transaction ID / Action / Approval Status), and returns the **TER (termination)** row's `{ found, transactionId, approvalStatus }`. Pure `pickTerminationRow(rows)` does the TER pick (unit-tested). A genuine no-TER result returns `found:false`; a results-grid READ failure now propagates (2026-07 fail-loud audit) rather than degrading to `found:false`.
- `deletePendingTransaction(page, eid)` (`transaction.ts`) — on the standard Smart HR "Transactions in Progress" grid, ticks the Select checkbox of **every** row matching the EID + "Terminat" (clicked **inside `frame.evaluate`** — PeopleSoft overlay intercepts Playwright clicks, same escape hatch as `#ICOK`), clicks `smartHR.deleteSelectedTransactionsButton` once (deletes all checked), and confirms the `#ICOK` dialog. Returns the **count** of rows deleted (0 = none matched / failed). **DATE-AGNOSTIC by design** (2026-06-24): the in-progress grid only holds unprocessed transactions, so it removes any stale pending termination for the EID regardless of effective date. `transaction-check` calls it on every create-bound path, decoupled from the effdt-gated SS Smart HR search (which only governs approved-reuse) — see `src/workflows/separations/CLAUDE.md` "Transaction check". The duplicate it prevents: a prior run's pending termination with a different computed effdt that both date-keyed backstops missed.
- **`deletePendingTransaction` LIVE-VERIFIED 2026-06-24** (`playwright-cli`, real UCPath in-progress grid): the EID + "Terminat" exact-cell match, the `checkbox.click()`-in-`evaluate` tick, the single `Delete Selected Transactions` button, and the `#ICOK` confirm dialog (`document.getElementById("#ICOK")`, "Select Ok to confirm deletion…") all confirmed; a real stale duplicate row was deleted with the keeper preserved. **`findTerminationTransactionStatus` grid LIVE-VERIFIED 2026-07-08** (`playwright-cli` + Duo Autopilot, read-only): a blank SS Smart HR search returned 100 result rows; the header row parses exactly as `parseSsSmartHrRows` Pass A expects (`Transaction ID`=col 0, `Action`=col 4, `Approval Status`=col 5 — concatenated wrapper rows are correctly skipped by the exact `/^action$/i` match), data rows align (e.g. a real `TER`/`Pending` row), and the drill-in row anchor `tr[id^=trPTS_CFG_CL_STD_RSL]` is present on all 100 rows.

## Gotchas

- Sidebar overlay intercepts clicks on iframe buttons — must collapse via "Navigation Area" button
- Every form fill has `{ timeout: 10_000 }` and 2-5s waits for PeopleSoft roundtrips
- Error detection: `.PSERROR`, `#ALERTMSG`, `.ps_alert-error` selectors
- Person search: discriminates new hires (dialog) vs rehires (results table) by UI presence
- Person Org Summary: detail pages with multiple Employment Instances must click `View All` when present and select the preferred assignment row (active first, HDH-active before non-HDH, then highest empl record). Do not derive active/inactive from the first visible assignment row.
- Person Org Summary dates: `EidResult.startDate` is the ORG Instance Last Hire date (`PER_INST_EMP_VW_LAST_HIRE_DT$0`, first day of service). `EidResult.effectiveDate` is the selected assignment-row EFFDT. Do not use assignment EFFDT as the person-lookup dashboard start date.
- Person Org Summary termination reason: `EidResult.terminationReason` is the PeopleSoft action-reason rendered next to the Termination Date in the ORG Instance section (`personOrgSummary.terminationReason` = `#PER_INST_EMP_VW_DESCR$0`, e.g. "Resign - Personal Reasons"). Extracted in both detail paths and blanked when there's no termination date. Same `PER_INST_EMP_VW_*$0` field family as Last Hire / Termination Date.
- Modal dialogs dismissed via `frame.evaluate()` + `document.getElementById("#ICOK")` (Playwright can't click behind PeopleSoft overlay)
- `parsePayRate("$17.75 per hour")` → `"17.75"`
- Phone/email grid indices hardcoded: `$6` for phone type, `$7` for email type
- SSN is optional (international students), address is required
- Transaction number extraction: parse the reopened Smart HR readback page, accepting both `Transaction ID: T...` and the approval strip `Transaction: T...`; scroll to that lower section before workflow screenshots

## No cross-source auto-fallbacks

`getJobSummaryData` throws on empty Workforce Job Summary results. We do NOT fall back to Person Organizational Summary by EID, and we do NOT attempt name-based EID correction. A previous iteration (2026-04-23) shipped a three-tier cascade (Workforce → PersonOrg by EID → name-based lookup) — that code was reverted same day because silent fallbacks hide the underlying data problem.

When an upstream record has the wrong EID (Kuali Build, Salesforce, etc.), the correct fix is:

1. The workflow errors with a legible message naming the offending EID.
2. The user opens the upstream record and corrects it.
3. The workflow is re-run. Separations' pre-submit existence check (`findExistingTerminationTransaction`, scans the Smart HR Transactions list for an existing row matching `(employeeId, effectiveDate, termination action)`) prevents duplicate submits on re-run. Other workflows rely on their own live-page probes where applicable — there is no tracker-side idempotency cache as of 2026-04-23.

Auto-correction via cross-source name matching is a correctness risk: names aren't unique, variants can match different employees, and a silent match produces a wrong-employee transaction. Transient-error retries (Playwright timeouts, auth flakes) still go through `loginWithRetry` / `ctx.retry` — that's retrying the same operation, not substituting data.

**Before adding any cross-source fallback to a UCPath read, confirm with the user.** The default answer is no.

**Confirmed exception — separations `identity-check` (2026-06-18, CONDITIONAL + THREE-TIER).** Separations name-checks the EID only when the **Workforce Job Summary search flags a problem** — NOT an every-run pass (earlier same-day versions delegated-always, then a binary match/mismatch gate; both replaced). It branches on `classifyNameSimilarity(kualiName, jobSummaryName)` → `same`/`similar`/`different` (order-insensitive token alignment, `src/services/matching/match.ts`): **`same`** → trust the EID, no lookup; **`similar`** (close spelling variant — Kuali "Balmaceda, Jaden" vs UCPath "Jayden Balmaceda") → trust the EID, correct the misspelled Kuali NAME in place (`correctNameSpelling` + Kuali `updateEmployeeName`), NO person-lookup, NO EID change; **`different`** (the `10694136`-for-the-wrong-person case) → delegate to person-lookup BY NAME (name wins, fails loud if unverifiable). Not-found cases: short (<8 digit) EID → delegate BY NAME; complete 8-digit EID → FAIL LOUD with no lookup. This reads the name via the identity-aware `getJobSummaryIdentity` (`job-summary.ts`, returns `{ found, name, data }`, non-throwing on a miss); `getJobSummaryData` is a thin throw-on-miss wrapper over it. It is NOT the hidden in-read cascade reverted on 2026-04-23 — it is a VISIBLE, conditional pipeline step (`identity-check`, AFTER `kronos-search`) + (on `different`/not-found only) a delegated person-lookup child row. The Workforce-read no-fallback rule below is unchanged (`getJobSummaryIdentity`/`getJobSummaryData` still do no cross-source fallback themselves); the name-based correction and name-in-place fix live only in the separations handler. See `src/workflows/separations/CLAUDE.md` ("Conditional name↔EID verification").

## Lessons Learned

- **2026-07-16: A termination comment is not the Last Date Worked transaction field.** A live read-only Smart HR record showed comments saying 06/14/2026 while the actual `HR_TBH_SCR_WRK_TBH_DATE$3` field showed 06/12/2026 with `HR_TBH_SCR_WRK_TBH_CHK2$3` as the override. Separations now checks the override, fills the dedicated input, requires the original controls to detach/hide so a late/no-spinner fragment refresh cannot race readback, then re-resolves and requires exact checkbox/value state before submit. Any uncertainty is fatal.

- **2026-06-22: Job Information grid scan must POLL the render, not trust the spinner wait — and an empty job code on a found record now FAILS LOUD (blank Kuali Payroll Title bug, separations doc 4290).** `extractJobInfo` clicked the Job Information tab, called `waitForPeopleSoftProcessing`, then scanned the DOM once for a 6-digit job code. But that tab loads its grid LAZILY and does NOT reliably raise the PeopleSoft processing spinner, so `waitForPeopleSoftProcessing` returned on its 2s "spinner never appeared" timeout (`waitFor visible, timeout 2_000` → catch) — ~1s before the prior fixed `waitForTimeout(3_000)` would have, and not synchronized to the grid render at all. The single scan then read a half-rendered grid, found no job code, and returned `{jobCode:"", jobDescription:""}`. Work Location succeeded on the same page because it's the default detail view (already rendered); Job Information is the secondary tab. The regression was `84beeef7` (2026-06-11, replaced the fixed sleep with the spinner wait). Symptom in logs: `Job Code: ` / `Description: ` both blank ~2s after the tab click, then Kuali fills only the department and the run logs `[Kuali] Department + payroll filled` as success → blank **Payroll Title Code** + **Payroll Title** in the saved Kuali form. Fix (`job-summary.ts`): (1) `extractJobInfo` now re-runs the scan via the pure `pollForJobInfoScan` helper (20 × 500ms ≈ 10s, injected `sleep` for testability) until the job code appears; (2) `getJobSummaryIdentity` THROWS directly when a **found** record yields an empty job code after polling — a genuine extraction failure that propagates as a thrown error to the separations handler and fails the run, instead of silently shipping a blank fill (aligns with this module's "only no-results is a soft `found:false`" contract). The downstream Kuali fill guards (`if (opts.payrollTitleCode)` / `if (opts.payrollTitle)` in `kuali/navigate.ts`) were correctly skipping empty values — they were not the bug. Pinned by `tests/unit/systems/ucpath/job-summary.test.ts` (`pollForJobInfoScan` re-scans past empty renders, returns empty after exhausting attempts). **NEEDS LIVE UCPATH RE-VERIFY:** confirm the job code is genuinely the 6-digit `cells[0]` value on the live Job Information grid — if a live run still fails loud here after polling, the `/^\d{6}$/` heuristic or the grid layout is the next suspect, not the timing.
- **2026-06-22: Workforce Job Summary nav must check the search box, not just the URL (ISS-B02 — live separations batch).** `navigateToWorkforceJobSummary` skipped re-navigation on a URL-only guard (`page.url().includes("WF_JOB_SUMMARY")`). After the first doc drills into the Work Location / Job Information detail tabs the URL keeps `WF_JOB_SUMMARY` (same PeopleSoft component) but the Empl ID **search box is gone**, and there is no ucpath `resetUrl` restoring it between docs. So every 2nd+ doc of a **sequential separations batch** short-circuited as "already on page," `searchJobSummary`'s Empl ID fill timed out (`locator.fill: Timeout 10000ms ... textbox "Empl ID"`), and the doc failed at `kronos-search` — only doc #1 ever succeeded. Fix: the skip decision is now gated on URL **and** `jobSummary.emplIdInput(root).count() > 0` (pure helper `canSkipJobSummaryNavigation`); absent search box → re-navigate. Pinned by `tests/unit/systems/ucpath/job-summary.test.ts` (decision truth table + a fake-page wiring test asserting `goto` fires when the search box is absent). **NEEDS LIVE UCPATH RE-VERIFY** of the multi-doc batch path. If a `resetUrl` for ucpath is ever added, point it at `JOB_SUMMARY_URL` so the search page is restored between docs structurally.
- **2026-06-02: Person Org Summary Last Hire is backend context, NOT the displayed start date.** Person Org detail exposes Last Hire in the ORG Instance section and assignment EFFDT in the Employment Instances grid. Keep `EidResult.startDate` on Last Hire and `EidResult.effectiveDate` on EFFDT for backend use (EID disambiguation / `crmMatch` date tolerance). The operator-facing person-lookup "Start Date" is sourced from CRM (First Day of Service), not from either UCPath date — see `src/workflows/person-lookup/CLAUDE.md`.
- **2026-05-28: Person Org Summary multiple employment instances need active-row selection.** UCPath can open Person Org detail on an inactive instance while an active instance is hidden behind the Employment Instances `View All` link. `person-org-summary.ts` now expands the detail view when possible and selects the preferred assignment row before Person Lookup and other callers derive status.
- **2026-05-27: Smart HR Transactions sidebar selector must be exact.** UCPath renders both "Smart HR Transactions" and "SS Smart HR Transactions" under Smart HR Templates; loose `getByText("Smart HR Transactions")` matches both and fails strict mode before separations can create transactions. Keep `hrTasks.smartHRTransactionsLink` on an exact link role selector.
- **2026-05-27: Transaction readback lives below the fold.** The submitted Smart HR readback page shows `Transaction ID: T...` and the approval strip below the comments/save area. `readLatestTransactionNumber` scrolls to that section before parsing, and separations captures `ucpath-transaction-submitted-missing-number` if UCPath accepted the submit but no T-number was parsed.
- **2026-05-15: Person Org Summary name lookup moved to a registry selector.** `person-org-summary.ts` now reads `personOrgSummary.personNameValue` before falling back to generic leaf-text heuristics. Do not add personal names to skip lists; if the name readback fails, fix or extend the selector chain and record a selector lesson.
- **2026-05-15: UCPath driver interactions use `safeClick`/`safeFill`.** Registry-locator clicks/fills in UCPath system modules should stay wrapped so the dashboard selector health panel can aggregate fallback/stall warnings by label. JS-eval and element-handle escape hatches remain documented inline.
- **2026-04-23: `page.screenshot` outlier removed from `transaction.ts`.** `clickSaveAndSubmit` no longer captures its own ad-hoc `.screenshots/save-disabled-*.png` on waitForSaveEnabled timeout. Workflow handlers that want diagnostic captures call `ctx.screenshot({ kind: 'error', label: ... })` from their catch block — keeps the system module ctx-free and routes the image through the structured tracker pipeline.
- **2026-04-23: Three-tier EID cascade reverted.** Briefly shipped Workforce → PersonOrg by EID → name-based-lookup cascade in `getJobSummaryData`. User pushed back same day — preference is to fail loudly with a clear error so upstream data (Kuali EID) gets corrected at the source. Cross-source auto-fallbacks are off by default. `employee-search.ts` and `person-org-summary-fallback.ts` were deleted with the revert. (The original design spec under `docs/superpowers/specs/` has since been removed — it described the now-reverted cascade and no longer reflects shipped code.)
- **2026-04-10: Transaction number extraction after confirmation OK** — After clicking OK on the UCPath confirmation dialog, the transaction page navigates away and the transaction number is no longer visible. Fix: after clicking OK, renavigate to Smart HR via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number from there.
- **2026-04-10: framenavigated listener cleanup** — The `[NAV]` `framenavigated` listener registered during UCPath auth (to detect successful login) must be removed after auth completes. If left active, it fires on every subsequent PeopleSoft page navigation, creating noisy log entries and potential interference with navigation detection logic.
