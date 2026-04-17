# UCPath Module

PeopleSoft HR automation: Smart HR transactions, person search, job summary extraction, emergency contact forms, and the ActionPlan execution pattern. Used by onboarding, work-study, emergency-contact, eid-lookup, and separations workflows.

## Files

- `action-plan.ts` — `ActionPlan` class: queue-based step collector with `add()`, `preview()` (dry-run), and `execute()` (sequential with error wrapping as `TransactionError`)
- `navigate.ts` — `getContentFrame(page)` (iframe `#main_target_win0`), `waitForPeopleSoftProcessing(frame)`, `searchPerson(page, ssn, firstName, lastName, dob)`, `navigateToSmartHR(page)` (direct URL preferred, menu fallback), `dismissModalMask(page)` (legacy alias — re-exports from `src/systems/common/modal.ts`)
- `transaction.ts` — Full Smart HR flow: template selection, effective date, create transaction, reason code, personal data, comments, job data tabs, save/submit. Exports ~15 individual step functions
- `personal-data.ts` — Emergency Contact standalone component: `navigateToEmergencyContact(page, emplId)`, `readExistingContactNames(page)`, `hidePeopleSoftModalMask(page)` (legacy alias — re-exports from `src/systems/common/modal.ts`)
- `job-summary.ts` — `getJobSummaryData(page, emplId)`: navigates to Workforce Job Summary, searches by employee ID, extracts work location (deptId, description) and job info (jobCode, description)
- `selectors.ts` — **Selector registry** (Subsystem A). All Playwright locators grouped by flow: `smartHR`, `personalData`, `comments`, `jobData`, `personSearch`, `jobSummary`, `hrTasks`, `emergencyContact`. Callers import group-level namespaces and invoke `selector(root)` to get a Locator.
- `types.ts` — `TransactionResult`, `TransactionError`, `PlannedAction`, `PersonSearchResult`, `PersonalDataInput`, `JobDataInput`, `JobSummaryData`
- `index.ts` — Barrel exports (includes `ucpathSelectors` registry barrel)

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

## Verified Selectors

All Playwright selectors for this system live in [`selectors.ts`](./selectors.ts),
grouped by page/flow. Each selector carries a `// verified YYYY-MM-DD` inline
comment. Grid-index-mutating selectors (PeopleSoft `$0`/`$11` shifts around
position-number refresh — Comp Rate Code, Compensation Rate) use 5-deep
`.or()` fallback chains.

**Do not add inline selectors outside `selectors.ts`.** The
[`tests/unit/systems/inline-selectors.test.ts`](../../../tests/unit/systems/inline-selectors.test.ts)
guard will reject PRs that do. Dynamic regex-based employee-name lookups and
JS-eval paths (e.g. `#ICOK` dialog dismiss, `#processing` spinner probe) are
whitelisted via end-of-line `// allow-inline-selector` comments.

When you verify a selector via playwright-cli, update the `// verified`
comment in `selectors.ts` to today's date.

## Lessons Learned

- **2026-04-10: Transaction number extraction after confirmation OK** — After clicking OK on the UCPath confirmation dialog, the transaction page navigates away and the transaction number is no longer visible. Fix: after clicking OK, renavigate to Smart HR via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number from there.
- **2026-04-10: framenavigated listener cleanup** — The `[NAV]` `framenavigated` listener registered during UCPath auth (to detect successful login) must be removed after auth completes. If left active, it fires on every subsequent PeopleSoft page navigation, creating noisy log entries and potential interference with navigation detection logic.
