---
phase: 01-authentication-and-project-foundation
plan: 02
subsystem: auth
tags: [playwright, sso, duo-mfa, ucpath, act-crm, commander, browser-automation]

# Dependency graph
requires:
  - phase: 01-authentication-and-project-foundation/01
    provides: "TypeScript project, env validation, PII-safe logger, browser launch, auth type contracts"
provides:
  - "UCPath SSO login flow with credential entry and Duo MFA wait"
  - "ACT CRM authentication with separate browser context"
  - "Duo MFA polling loop with configurable timeout and retry"
  - "Session validity detection via URL redirect inspection"
  - "test-login CLI command orchestrating full auth flow"
  - "Session persistence: saved sessions reused, --fresh flag forces re-auth"
affects: [02-extraction, 03-entry, 04-batch]

# Tech tracking
tech-stack:
  added: []
  patterns: [separate browser contexts per system, URL-based session validation, text-based Playwright selectors for dynamic-ID pages, Duo MFA wait via page.waitForURL]

key-files:
  created:
    - src/auth/duo-wait.ts
    - src/auth/session.ts
    - src/auth/login.ts
    - src/cli.ts
  modified:
    - src/browser/launch.ts

key-decisions:
  - "Separate browser contexts for UCPath and ACT CRM -- required because UCPath cookies conflict with ACT CRM SSO flow"
  - "Duo timeout increased to 60s from planned 15s -- real-world Duo push approval takes longer than expected"
  - "UCPath session check URL set to actual app URL rather than root domain -- redirect detection only works against authenticated pages"
  - "Session validator detects UCSD SSO URLs (a5.ucsd.edu) as redirect indicators in addition to shibboleth/login patterns"

patterns-established:
  - "Separate browser contexts per target system to avoid cookie conflicts"
  - "URL-based redirect detection for session validity (check if redirected to SSO)"
  - "Text-based Playwright selectors only -- never use PeopleSoft dynamic element IDs"
  - "SELECTOR comments on locators that required live-testing adjustment"

requirements-completed: [AUTH-01, AUTH-02, AUTH-03, AUTH-04, AUTH-05]

# Metrics
duration: ~45min
completed: 2026-03-13
---

# Phase 1 Plan 02: Authentication Flows Summary

**UCPath SSO + Duo MFA + ACT CRM auth flows wired into test-login CLI with session persistence and separate browser contexts per system**

## Performance

- **Duration:** ~45 min (includes live verification and selector fixes)
- **Started:** 2026-03-13
- **Completed:** 2026-03-13
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- Full UCPath SSO login flow: navigate to UCPath, click "Log in" banner button, select "University of California, San Diego" on campus discovery, enter credentials on a5.ucsd.edu SSO page, wait for Duo MFA approval
- ACT CRM authentication via separate browser context to avoid cookie conflicts with UCPath session
- Duo MFA wait loop with 60-second timeout and one automatic retry
- Session validity detection by navigating to target URL and checking for SSO redirect
- test-login CLI command orchestrates: env validation (fail early), browser launch, UCPath auth, ACT CRM auth, session save, summary output, browser close
- Session persistence: second run detects valid session and skips login; --fresh flag forces full re-authentication

## Task Commits

Each task was committed atomically:

1. **Task 1: Auth modules -- Duo MFA wait, session detection, SSO login flows** - `03a757a` (feat)
2. **Task 2: CLI entry point wiring test-login command with full auth orchestration** - `7984bc0` (feat)
3. **Task 3: Live verification + selector fixes + session separation** - `a987375` (fix)

## Files Created/Modified
- `src/auth/duo-wait.ts` - Duo MFA polling loop with configurable timeout, retry, and URL-match detection
- `src/auth/session.ts` - Session validity checker via URL redirect inspection (detects SSO/login redirects)
- `src/auth/login.ts` - SSO login flows for UCPath (campus discovery + credential entry) and ACT CRM (separate context)
- `src/cli.ts` - CLI entry point with test-login command, --fresh flag, session orchestration, retry-once on crash
- `src/browser/launch.ts` - Modified to support separate browser contexts for UCPath and ACT CRM

## Decisions Made
- **Separate browser contexts per system:** UCPath and ACT CRM each get their own browser context because UCPath cookies interfere with the ACT CRM SSO flow. This was discovered during live testing.
- **Duo timeout 60s (was 15s):** The planned 15-second Duo timeout was too short for real-world usage. Increased to 60 seconds to give users adequate time to approve on their phone.
- **UCPath session check URL:** Changed from root domain to actual app URL. The root domain does not reliably trigger SSO redirects, so session detection must check against an authenticated page.
- **SSO URL detection expanded:** Session validator now detects a5.ucsd.edu (the actual UCSD SSO hostname) in addition to the generic shibboleth/login patterns from the plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] UCPath "Log in" button selector fixed**
- **Found during:** Task 3 (live verification)
- **Issue:** Plan specified `getByRole('link', { name: /log in/i })` which matched a hidden nav link instead of the visible banner button
- **Fix:** Updated selector to target the visible "Log in" button in the UCPath landing page banner
- **Files modified:** src/auth/login.ts
- **Committed in:** a987375

**2. [Rule 1 - Bug] Campus discovery page institution name corrected**
- **Found during:** Task 3 (live verification)
- **Issue:** Plan used "UC San Diego" but the actual campus discovery page lists "University of California, San Diego"
- **Fix:** Changed selector text to match actual page content
- **Files modified:** src/auth/login.ts
- **Committed in:** a987375

**3. [Rule 1 - Bug] SSO hostname correction**
- **Found during:** Task 3 (live verification)
- **Issue:** Plan expected login.ucsd.edu but actual UCSD SSO runs on a5.ucsd.edu
- **Fix:** Updated URL checks and session detection to use correct hostname
- **Files modified:** src/auth/login.ts, src/auth/session.ts
- **Committed in:** a987375

**4. [Rule 1 - Bug] Login button text regex fixed**
- **Found during:** Task 3 (live verification)
- **Issue:** Regex expected "Log in" (with space) but actual button text is "Login" (no space)
- **Fix:** Corrected regex pattern to match actual button text
- **Files modified:** src/auth/login.ts
- **Committed in:** a987375

**5. [Rule 1 - Bug] Duo timeout too short**
- **Found during:** Task 3 (live verification)
- **Issue:** 15-second Duo timeout insufficient for real-world MFA approval
- **Fix:** Increased to 60 seconds
- **Files modified:** src/auth/duo-wait.ts
- **Committed in:** a987375

**6. [Rule 3 - Blocking] Separate browser contexts required**
- **Found during:** Task 3 (live verification)
- **Issue:** Single browser context caused UCPath cookies to conflict with ACT CRM SSO authentication
- **Fix:** Implemented separate browser contexts for each system
- **Files modified:** src/browser/launch.ts, src/cli.ts
- **Committed in:** a987375

**7. [Rule 1 - Bug] UCPath session check URL wrong**
- **Found during:** Task 3 (live verification)
- **Issue:** Session check against root domain did not trigger SSO redirect for session detection
- **Fix:** Changed to actual UCPath app URL
- **Files modified:** src/auth/session.ts
- **Committed in:** a987375

---

**Total deviations:** 7 auto-fixed (6 bugs, 1 blocking)
**Impact on plan:** All selector and config fixes were expected -- the plan explicitly noted that selectors were "BEST-GUESS" and "WILL need adjustment during the first live test run." The separate browser contexts fix was a necessary architectural tweak discovered through live testing. No scope creep.

## Issues Encountered
- All selector issues were anticipated by the plan (marked with "SELECTOR: may need adjustment after live testing" comments). The live verification checkpoint was specifically designed for this purpose.
- ACT CRM SSO cookie conflict required the separate-contexts approach, which was a minor structural change but not a new dependency or service.

## User Setup Required
None - user has already configured .env file with credentials during Phase 1 Plan 01.

## Next Phase Readiness
- Phase 1 complete: authenticated browser sessions to both UCPath and ACT CRM are fully operational
- Phase 2 (Data Extraction) can now use the established auth flow to reach ACT CRM in an authenticated state
- Session persistence means Phase 2 development can skip re-authentication on subsequent runs
- The separate browser context pattern established here should be carried forward -- each system gets its own context
- Cross-domain SSO blocker from STATE.md is now RESOLVED: UCPath and ACT CRM require separate Duo prompts (one per system), not a shared SSO session

## Self-Check: PASSED

- All 5 created/modified files exist on disk (duo-wait.ts, session.ts, login.ts, cli.ts, launch.ts)
- All 3 task commits verified in git log (03a757a, 7984bc0, a987375)
- Live verification approved by user (UCPath SSO, Duo MFA, ACT CRM, session reuse, --fresh flag)

---
*Phase: 01-authentication-and-project-foundation*
*Completed: 2026-03-13*
