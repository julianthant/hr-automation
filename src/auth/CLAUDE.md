# Auth Module

Five independent login flows for UCSD systems. Each system uses different SSO/auth — never share browser sessions between them.

## Files

- `login.ts` — All login flows: `loginToUCPath`, `loginToACTCrm`, `loginToUKG` (split into `ukgNavigateAndFill` + `ukgSubmitAndWaitForDuo`), `loginToKuali`, `loginToNewKronos`
- `duo-poll.ts` — `pollDuoApproval(page, options)` — unified Duo polling loop with URL match, successCheck, postApproval, and recovery callbacks
- `session.ts` — `isOnAuthenticatedPage(page)` — URL-based check for ACT CRM auth state (not session persistence)
- `types.ts` — `LoginOptions` (fresh flag), `AuthResult` (ucpath/actCrm booleans)

## Login Flows

| Function | System | Duo? | Session Persistence? | Timeout |
|----------|--------|------|---------------------|---------|
| `loginToUCPath` | UCPath PeopleSoft | Yes (180s) | No | 10-15s nav |
| `loginToACTCrm` | Salesforce CRM | Yes (60s) | No | 15s nav |
| `loginToUKG` | UKG Kronos | Yes (180s) | Yes (sessionDir) | 60s nav |
| `loginToKuali` | Kuali Build | Yes (180s) | No | 10s nav |
| `loginToNewKronos` | WFD Kronos | Yes (180s) | No | 10s nav |

## Selector Pattern

All UCSD SSO forms use 3-level fallback selectors:
1. Accessibility label (e.g., `"User name (or email address)"`)
2. Alternate label (e.g., `"Username"`)
3. HTML attribute (e.g., `input[name="j_username"]`)

Submit button: always `button[name="_eventId_proceed"]` (avoids collision with "Enroll in Two-Step Login" nav link).

## Gotchas

- **Duo MFA is manual** — automation pauses and polls for user phone approval
- **Duo must be sequential** — multiple simultaneous Duo prompts cause errors
- UCPath may redirect back to campus discovery page after Duo — retry loop (3x) handles this
- UKG `ukgNavigateAndFill` returns `true | false | "already_logged_in"` (string return for persistent session detection)
- UKG is the only flow with network error retry logic (5s backoff for transient errors)
- ACTCrm may land on `act-crm.my.site.com` OR `crm.ucsd.edu` after Duo — both are checked
- Debug screenshots saved to `.auth/debug-*.png` (ACTCrm flow only)
- "Enroll in Two-Step Login" nav link has `role="button"` containing "Login" — causes selector collisions if not using `button[name=...]`

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and system)*

## Lessons Learned

- **2026-04-10: Duo pollDuoApproval auto-retry on timeout** — Duo MFA can time out if the user doesn't approve in time (e.g. phone not nearby). `pollDuoApproval` now auto-retries on timeout by clicking the "Try Again" button in the Duo iframe. This avoids the entire workflow failing because of a single missed Duo prompt.
