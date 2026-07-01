# I9 Module

Automates I9 Complete (Tracker I-9 by Mitratech) for employment verification: login, employee creation, search, and Section 2 signer lookup.

## Auth (UCOP portal → UCSD SSO + Duo)

Since **2026-07-01** I-9 login goes through the **UCOP portal** (`I9_URL` = `https://i9complete.ucop.edu`), **not** the old standalone `stse.i9complete.com` email/password vendor login. `loginToI9` (`login.ts`) drives: UCOP landing → click "Tracker I-9 Complete Application" → `samlproxy.ucop.edu` WAYF (select "University of California, San Diego") → UCSD TritON Shibboleth SSO (`a5.ucsd.edu`) → **Duo** → lands on the app host `I9_APP_URL` (`https://wwwe.i9complete.com`). It reuses the shared UCSD SSO helpers (`fillSsoCredentials` / `clickSsoSubmit` / `pollDuoApproval` / `requestDuoApproval`) and **UCPath credentials** — so hands-off Duo WebAuthn covers it like every other UCSD system, and there are no I-9-specific env credentials anymore. Deep-links (e.g. `create.ts`'s `saveAndContinue`) use `I9_APP_URL` directly (previously derived via `I9_URL.replace("stse.","wwwe.")`, which the UCOP entry URL broke).

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

## SSN Format Inconsistency

- **Create** (`I9EmployeeInput.ssn`): 9 digits, NO dashes — `"123456789"`
- **Search** (`I9SearchCriteria.ssn`): WITH dashes — `"123-45-6789"`

## Gotchas

- Login success = Duo clears and the page lands back on `wwwe.i9complete.com` (`successUrlMatch: url.includes("i9complete.com") && !duosecurity`). A bad **campus SSO** credential is rejected on the `a5.ucsd.edu` TritON form (never reaches Duo) → `pollDuoApproval` returns false → `requireLogin` throws — the same failure path as every other UCSD SSO system (the old i9-specific `classifyI9LoginResult` / `stse.i9complete.com/Account/Login` bounce was retired 2026-07-01 with the vendor login).
- Training notification popup appears post-login — must dismiss with 2-step click (gracefully handles if absent)
- Worksite dropdown options formatted as `6-{deptNum} DESCRIPTION` — matched via regex
- If no worksite matches department number, throws before saving (manual recovery needed)
- Profile ID extracted from URL pattern `/employee/profile/{id}` after save
- Grid parsing: last `.getByRole("grid")` in dialog is results, earlier grids are headers
- Search **Options** button (`dashboard.searchOptionsButton`) uses direct selector `#divSearchOptions` (not accessible role); the search *submit* (`search.submitButton`) uses `getByRole("button", { name: "Search" })`
- Returns `I9Result` error object on validation failure (doesn't throw)
- Summary-page signer lookup is **deterministic navigation** (2026-06-06): `page.goto('/form-I9/summary/{profileId}/{i9Id}')` built from the search hit's IDs — NOT a click-through. The old last-name-link → record-expand → Summary-tab flow was fragile (last-name cells are hrefless `<a>`, not link roles) and surfaced as a spurious "not found". Paper-imported records redirect to `/form-I9-historical/…` and lack the "Signed Section 2" audit row; detect with `page.url().includes("/form-I9-historical/")` to distinguish `historical` from genuinely `unsigned`.
- Audit trail columns are `[Section, Date, Event, Created By]` — signer is the **last cell** (Created By) of the row whose accessible name matches `/Signed Section 2/`. Use `.first()` so amended I-9s (multiple signings) return the most recent. **Wait on `summary.auditTrailHeaderRow` before counting `signedSection2Row`** — the summary heading renders before the audit table populates, so an early `count()` reads 0 and mis-classifies a signed record as unsigned.
- Access-restricted search: a zero-result search whose dialog shows `search.accessRestrictedAlert` ("…your user account has not been granted access to view those employees…") means the record EXISTS but is out of the operator's scope. `lookupSection2Signer` returns `status: "unable-to-access"` (distinct from `not-found`); verify renders "Unable to access".

## Lessons Learned

- **2026-05-15: Kendo-blocked I9 clicks use shared recovery.** Dashboard/search/create entry clicks now go through `clickWithKendoRecovery(page, locator, label)`, which snapshots visible Kendo windows, closes stale modals, and retries once. Keep new I9 dashboard clicks on this helper when stale `.k-window` overlays are plausible; ordinary field interactions use `safeClick`/`safeFill` for selector-health instrumentation.
- **2026-04-22: Section 2 signer — parse the audit trail, not the Section 2 tab.** The `/form-I9/summary/{profileId}/{i9Id}` page renders an "Electronic I-9 Audit Trail" grid that lists every lifecycle event including "Signed Section 2" (signer in the 4th cell, `Created By`). Reading the signer from the audit trail is structurally the same for both modern electronic and re-opened records, whereas the Section 2 tab's layout varies by flow type. Historical (paper) imports redirect to `/form-I9-historical/{profileId}/{i9Id}/0` and have no audit row for Section 2 — detect via URL prefix after `page.goto(summaryUrl)` and report `status: "historical"` rather than conflating with `unsigned`. Mapped live on 2026-04-22 against profile 2082422.
