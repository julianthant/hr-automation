# UCPath Module

PeopleSoft HR automation: Smart HR transactions, person search, job summary extraction, emergency contact forms, and the ActionPlan execution pattern. Used by onboarding, work-study, emergency-contact, eid-lookup, and separations workflows.

## Files

- `action-plan.ts` — `ActionPlan` class: queue-based step collector with `add()`, `preview()` (dry-run), and `execute()` (sequential with error wrapping as `TransactionError`)
- `navigate.ts` — `getContentFrame(page)` (iframe `#main_target_win0`), `waitForPeopleSoftProcessing(frame)`, `searchPerson(page, ssn, firstName, lastName, dob)`, `navigateToSmartHR(page)` (direct URL preferred, menu fallback), `dismissModalMask(page)` (legacy alias — re-exports from `src/systems/common/modal.ts`)
- `transaction.ts` — Full Smart HR flow: template selection, effective date, create transaction, reason code, personal data, comments, job data tabs, save/submit. Exports ~15 individual step functions
- `personal-data.ts` — Emergency Contact standalone component: `navigateToEmergencyContact(page, emplId)`, `readExistingContactNames(page)`, `hidePeopleSoftModalMask(page)` (legacy alias — re-exports from `src/systems/common/modal.ts`)
- `job-summary.ts` — `getJobSummaryData(page, emplId, opts?)`: three-tier cascade — Workforce Job Summary by EID → Person Org Summary by EID → **[opt-in via `opts.nameHint`]** name-based lookup + retry Person Org Summary. Returns `emplIdUsed` so callers can detect when tier 3 swapped in a corrected EID.
- `employee-search.ts` — `lookupEmplIdByName(page, name)`: simple Person Org Summary name search (no dept filter) used as a last-resort fallback when EID-based lookups fail. Returns first matching EID or `null`. Not dept-filtered — callers needing SDCMP/HDH filtering should use the eid-lookup workflow instead.
- `person-org-summary-fallback.ts` — `lookupJobInfoByEidFromPersonOrgSummary(page, emplId)`: tier-2 fallback for `getJobSummaryData` — broader coverage than Workforce Job Summary (handles historical records, non-SDCMP BUs).
- `selectors.ts` — **Selector registry** (Subsystem A). All Playwright locators grouped by flow: `smartHR`, `personalData`, `comments`, `jobData`, `personSearch`, `jobSummary`, `hrTasks`, `emergencyContact`. Callers import group-level namespaces and invoke `selector(root)` to get a Locator.
- `types.ts` — `TransactionResult`, `TransactionError`, `PlannedAction`, `PersonSearchResult`, `PersonalDataInput`, `JobDataInput`, `JobSummaryData`
- `index.ts` — Barrel exports (includes `ucpathSelectors` registry barrel)

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review the top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. If [`LESSONS.md`](./LESSONS.md) has a relevant entry, read it first to avoid repeating a known failure.
4. Otherwise, map a new selector following the conventions in [`selectors.ts`](./selectors.ts):
   a. Add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`).
   b. Run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).
   c. If you discovered a non-obvious failure mode along the way, append a lesson to [`LESSONS.md`](./LESSONS.md) following its template.
   d. Verify the inline-selector test still passes: `tsx --test tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the auto-generated catalog of every selector this module exports.

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

## Workflow-aware fallback primitives

When UCPath returns empty for a read that callers depend on, the system provides cascading fallbacks rather than forcing every workflow to re-implement the retry logic. The pattern for adding a new one:

1. **Keep the fallback stateless w.r.t. workflow context** — it should take `page` + the bare minimum upstream hints, return a shape structurally compatible with the primary path. This lets any workflow opt in with a one-line change at the call site.
2. **Make it opt-in via `opts`** — existing callers keep their terse signature; new callers pass `{ nameHint: ... }` or `{ ssnHint: ... }` or whatever applies.
3. **Surface what actually resolved** — if the fallback swaps in a corrected value (EID, SSN, etc.), return it in the result so callers can thread the correction downstream.
4. **Best-effort, return null on failure** — never throw from a fallback; the primary path's caller already knows how to handle "no data."

Reference implementation: the three-tier cascade in `getJobSummaryData` — Workforce JS → Person Org Summary by EID → name-based EID lookup + retry. Separations wires tier 3 by passing `kualiData.employeeName` as `nameHint`; onboarding / work-study / emergency-contact can opt in the same way when wrong-EID scenarios emerge in their flows.

## Lessons Learned

- **2026-04-23: Three-tier EID cascade in `getJobSummaryData`.** Added tier 3 (name-based lookup via `lookupEmplIdByName`) that fires when tiers 1–2 both return empty AND the caller passes `opts.nameHint`. Result carries `emplIdUsed` so callers can detect when the EID was corrected (e.g. HR admin typo in an upstream system). Design: `docs/superpowers/specs/2026-04-23-daemon-isolation-and-separations-stability-design.md` Part 3.
- **2026-04-23: `page.screenshot` outlier removed from `transaction.ts`.** `clickSaveAndSubmit` no longer captures its own ad-hoc `.screenshots/save-disabled-*.png` on waitForSaveEnabled timeout. Workflow handlers that want diagnostic captures call `ctx.screenshot({ kind: 'error', label: ... })` from their catch block — keeps the system module ctx-free and routes the image through the structured tracker pipeline.
- **2026-04-10: Transaction number extraction after confirmation OK** — After clicking OK on the UCPath confirmation dialog, the transaction page navigates away and the transaction number is no longer visible. Fix: after clicking OK, renavigate to Smart HR via `navigateToSmartHR()` + `clickSmartHRTransactions()` to reach the transactions list, then extract the most recent transaction number from there.
- **2026-04-10: framenavigated listener cleanup** — The `[NAV]` `framenavigated` listener registered during UCPath auth (to detect successful login) must be removed after auth completes. If left active, it fires on every subsequent PeopleSoft page navigation, creating noisy log entries and potential interference with navigation detection logic.
