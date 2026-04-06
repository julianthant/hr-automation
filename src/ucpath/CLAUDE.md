# UCPath Module

PeopleSoft HR automation: Smart HR transactions, person search, job summary extraction, and the ActionPlan execution pattern.

## Files

- `action-plan.ts` — `ActionPlan` class: queue-based step collector with `add()`, `preview()` (dry-run), and `execute()` (sequential with error wrapping as `TransactionError`)
- `navigate.ts` — `getContentFrame(page)` (iframe `#main_target_win0`), `waitForPeopleSoftProcessing(frame)`, `searchPerson(page, ssn, firstName, lastName, dob)`, `navigateToSmartHR(page)` (direct URL preferred, menu fallback)
- `transaction.ts` — Full Smart HR flow: template selection, effective date, create transaction, reason code, personal data, comments, job data tabs, save/submit. Exports ~15 individual step functions
- `job-summary.ts` — `getJobSummaryData(page, emplId)`: navigates to Workforce Job Summary, searches by employee ID, extracts work location (deptId, description) and job info (jobCode, description)
- `types.ts` — `TransactionResult`, `TransactionError`, `PlannedAction`, `PersonSearchResult`, `PersonalDataInput`, `JobDataInput`, `JobSummaryData`
- `index.ts` — Barrel exports

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
8. `clickJobDataTab` / `fillJobData` — position, classification, comp rate, rate value, end date
9. `clickEarnsDistTab` / `clickEmployeeExperienceTab` — visit only (no fill)
10. `clickSaveAndSubmit` — extracts transaction number from confirmation text

## Gotchas

- Sidebar overlay intercepts clicks on iframe buttons — must collapse via "Navigation Area" button
- Every form fill has `{ timeout: 10_000 }` and 2-5s waits for PeopleSoft roundtrips
- Error detection: `.PSERROR`, `#ALERTMSG`, `.ps_alert-error` selectors
- Person search: discriminates new hires (dialog) vs rehires (results table) by UI presence
- Modal dialogs dismissed via `frame.evaluate()` + `document.getElementById("#ICOK")` (Playwright can't click behind PeopleSoft overlay)
- `parsePayRate("$17.75 per hour")` → `"17.75"`
- Phone/email grid indices hardcoded: `$6` for phone type, `$7` for email type
- SSN is optional (international students), address is required
- Transaction number extraction: regex for 7+ digit number in confirmation text
