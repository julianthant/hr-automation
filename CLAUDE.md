# HR Automation

UCPath HR automation tool for UCSD — automates onboarding data entry via Playwright browser automation.

## Commands

```bash
npm run test-login          # Test UCPath + CRM auth flow
npm run test-login:fresh    # Force fresh login (no session reuse)
npm run extract             # Extract employee data from CRM
npm run start-onboarding    # Run full onboarding workflow
npm run start-onboarding:dry # Dry-run onboarding (no data entry)
npm run typecheck           # TypeScript type checking
npm run test                # Run unit tests
```

All runtime scripts use `tsx --env-file=.env` — never run source files directly.

## Architecture

```
src/
  auth/         # Login flows (UCPath SSO + ACT CRM, separate sessions)
  browser/      # Playwright browser launch (always headed mode)
  crm/          # ACT CRM navigation, search, and data extraction
  ucpath/       # UCPath navigation, person search, transaction entry
  utils/        # Env validation, logging
  workflows/    # Multi-step workflows (onboarding/)
  cli.ts        # Commander CLI entry point
```

## Environment

Copy `.env.example` to `.env` and fill in:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password

## Key Patterns

- **Separate auth flows**: UCPath and CRM use different auth — never share browser sessions between them
- **No session persistence**: Always login fresh, leave browser open for user to observe
- **Headed browser**: Always use headed mode so user can see automation and approve Duo MFA
- **URL params over clicking**: Prefer URL manipulation over UI navigation where possible
- **Use playwright-cli**: Always use the playwright-cli skill for browser interactions — do not write raw Playwright code manually
- **Log every interaction**: Log every browser action (click, fill, navigate, wait) to console so the user can trace exactly what happened

## Gotchas

- UCPath content is inside iframe `#main_target_win0` (not `#ptifrmtgtframe`) — selectors must target the iframe
- UCPath Smart HR URL must use `ucphrprdpub.universityofcalifornia.edu` subdomain (not `ucpath.`) to avoid re-triggering SSO
- Duo MFA requires manual user approval on phone — automation must pause and wait

## Debug Versioning

When iterating on live selector discovery / auth fixes:
- Start at version **1.0**, increment by **0.1** per fix attempt
- Screenshots: `.auth/debug-v{version}-{description}.png`
- Log version in console output
- Review previous screenshots before making changes
- Current debug version: **2.2**

## Self-Sustaining Debug Loop

Run autonomously until workflow completes — do NOT stop after each step:
1. Run debug script → 2. Screenshot → 3. Close browser → 4. Check screenshots →
5. Diagnose → 6. Fix + increment version → 7. Re-run → 8. Repeat

Only pause for: Duo MFA approval, domain knowledge decisions, or workflow completion verification.
