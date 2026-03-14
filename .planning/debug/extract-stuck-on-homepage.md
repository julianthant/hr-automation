---
status: awaiting_human_verify
trigger: "extract-stuck-on-homepage: npm run extract authenticates but gets stuck on onboarding homepage, search never executes"
created: 2026-03-14T00:00:00Z
updated: 2026-03-14T00:00:00Z
---

## Current Focus

hypothesis: CONFIRMED -- missing navigation to /hr/ONB_ViewOnboardings between auth and search
test: n/a -- fix applied, awaiting human verification with live Duo MFA
expecting: After auth, browser should navigate to View Existing Onboardings, find visible search input, and proceed
next_action: User runs `npm run extract -- yhoang0791@gmail.com` to verify the fix works end-to-end

## Symptoms

expected: After authentication, the extract command should search for the employee by email, select the result, navigate to UCPath Entry Sheet, and extract 10 fields.
actual: Auth succeeds, browser lands on https://act-crm.my.site.com/hr/a1Z/o (the onboarding homepage). The code then tries to find a search input (getByPlaceholder("Search") / getByRole("searchbox") / input[type="search"]) but the only search input on the page is hidden (visible: false). The page hangs waiting for the selector.
errors: No explicit error - the command hangs/times out because search input selectors don't match any visible element on the homepage.
reproduction: Run `npm run extract -- yhoang0791@gmail.com` -- after Duo MFA approval, the browser lands on the homepage and gets stuck.
started: First live test of the extraction pipeline. Auth flow was proven working in Phase 1.

## Eliminated

(none yet)

## Evidence

- timestamp: 2026-03-14T00:01:00Z
  checked: Live page data from debug output
  found: Post-auth URL is https://act-crm.my.site.com/hr/a1Z/o. The only input on the page is type=search, name=q, placeholder="Search..." but visible=FALSE. No tables found. Visible links include "View Existing Onboardings" -> /hr/ONB_ViewOnboardings.
  implication: The homepage has a hidden search input (probably a global site search, not the onboarding search). The actual onboarding search is on a different page entirely.

- timestamp: 2026-03-14T00:02:00Z
  checked: cli.ts extract command flow (lines 106-159)
  found: Flow is loginToACTCrm(page) -> searchByEmail(page, email) -> selectLatestResult(page) -> navigateToSection(page, "UCPath Entry Sheet") -> extractRawFields(page). There is NO navigation step between auth and searchByEmail.
  implication: The code assumes auth lands on a page with a visible search input. It does not. A navigation step to /hr/ONB_ViewOnboardings is needed before searching.

- timestamp: 2026-03-14T00:03:00Z
  checked: searchByEmail() in src/crm/search.ts (lines 11-30)
  found: Comment says "After auth, we're already on act-crm.my.site.com" and immediately tries selectors. No URL navigation. The selectors (getByPlaceholder("Search"), getByRole("searchbox"), input[type="search"]) all target search inputs, but the homepage's search input is hidden (visible: false), so Playwright's .first().fill() will timeout waiting for a visible element.
  implication: The assumption in the comment is wrong -- being on act-crm.my.site.com is not enough; you need to be on the specific /hr/ONB_ViewOnboardings sub-page.

- timestamp: 2026-03-14T00:04:00Z
  checked: TypeScript compilation after fix
  found: npx tsc --noEmit passes for all project files. Only error is pre-existing in src/debug-page.ts line 49 (unrelated to this change).
  implication: Fix is syntactically and type-safe correct.

## Resolution

root_cause: Missing navigation step. After ACT CRM authentication, the browser lands on the onboarding homepage (/hr/a1Z/o), NOT on a page with search functionality. searchByEmail() is called immediately without first navigating to "View Existing Onboardings" (/hr/ONB_ViewOnboardings) where the search input actually lives. The homepage has only a hidden search input (visible: false) which Playwright correctly ignores, causing an indefinite hang.
fix: Added explicit navigation to /hr/ONB_ViewOnboardings in searchByEmail() before attempting to find the search input. Also improved search input selector to use case-insensitive regex (/search/i) for getByPlaceholder and added :visible pseudo-selector for the CSS fallback, so it skips hidden inputs.
verification: TypeScript compiles cleanly (only pre-existing error in unrelated debug-page.ts). Awaiting live verification with Duo MFA.
files_changed:
  - src/crm/search.ts
