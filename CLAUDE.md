# HR Automation

UCPath HR automation tool for UCSD — automates onboarding data entry and UKG report downloads via Playwright browser automation. Designed for multiple HR workflows (onboarding, offboarding, pay changes, kronos reports) built on shared modules.

## Commands

```bash
npm run start-onboarding <email>      # Run full onboarding workflow for employee
npm run start-onboarding:dry <email>  # Dry-run onboarding (preview actions, no UCPath changes)
npm run start-onboarding:batch -- <N>  # Batch onboarding with N parallel workers
npm run kronos                        # Download Time Detail PDFs from UKG (4 workers)
npm run kronos:dry                    # Dry-run kronos (preview employee list)
npm run kronos -- --workers 8         # Kronos with custom worker count
npm run extract <email>               # Extract employee data from CRM only
npm run test-login                    # Test UCPath + CRM auth flow
npm run typecheck                     # TypeScript type checking
npm run test                          # Run unit tests
```

All runtime scripts use `tsx --env-file=.env` — never run source files directly.

## Architecture

```
src/
  auth/           # Login flows (UCPath SSO, ACT CRM, I9, UKG — separate sessions each)
  browser/        # Playwright browser launch (headed mode, optional persistent sessions)
  config.ts       # Centralized URLs, constants, field maps
  crm/            # ACT CRM navigation, search, and data extraction
  i9/             # I9 Complete employee record creation
  tracker/        # Excel tracking with daily worksheets (YYYY-MM-DD tabs)
  ucpath/         # UCPath PeopleSoft navigation, person search, Smart HR transactions
  ukg/            # UKG (Kronos) navigation, iframe access, report generation
  utils/          # Env validation, logging, error helpers
  workflows/      # Multi-step workflow orchestration
    onboarding/   # Schema, CRM extraction, UCPath transaction, parallel processing
    kronos/       # UKG Time Detail report downloads, parallel workers, PDF validation
  cli.ts          # Commander CLI entry point
```

### Data Flow

```
CRM (extract) → EmployeeData (schema) → Person Search (UCPath)
                                       → I9 Record (I9 Complete)
                                       → Smart HR Transaction (UCPath)
                                       → Tracker (Excel spreadsheet)
```

### Workflow Pattern

Every workflow follows the same structure — new workflows should mirror `src/workflows/onboarding/`:
1. `schema.ts` — Zod schema for validated employee data
2. `extract.ts` — CRM field extraction with label-based FIELD_MAP
3. `enter.ts` — ActionPlan builder composing UCPath transaction steps
4. `index.ts` — Barrel exports

## Environment

Copy `.env.example` to `.env` and fill in:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password

## Key Patterns

- **Separate auth flows**: UCPath, CRM, I9, and UKG each use different auth — never share browser sessions between them
- **No session persistence** (UCPath/CRM): Always login fresh, leave browser open for user to observe
- **Persistent sessions** (UKG/Kronos): Uses `launchBrowser({ sessionDir })` to reuse login state across runs
- **Headed browser**: Always use headed mode so user can see automation and approve Duo MFA
- **URL params over clicking**: Prefer URL manipulation over UI navigation where possible
- **Use playwright-cli**: Always use the playwright-cli skill for live selector discovery — do not guess selectors
- **Log every interaction**: Log every browser action (click, fill, navigate, wait) to console for traceability
- **ActionPlan pattern**: All UCPath transactions are built as ActionPlan steps — supports dry-run preview and step-by-step execution with error isolation
- **Tracker Excel files**: Always place tracker .xlsx files inside the workflow folder (e.g. `src/workflows/eid-lookup/eid-lookup-tracker.xlsx`), never in the project root

## Gotchas

- UCPath content is inside iframe `#main_target_win0` (not `#ptifrmtgtframe`) — all selectors must target the iframe via `getContentFrame(page)`
- UCPath Smart HR URL must use `ucphrprdpub.universityofcalifornia.edu` subdomain (not `ucpath.`) to avoid re-triggering SSO
- Duo MFA requires manual user approval on phone — automation must pause and wait
- **PeopleSoft dynamic grid IDs**: Grid inputs (phone, email, comp rate) use indexed IDs like `HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0`. The index changes after page refreshes (e.g. position number fill). Always use `input[id="..."]` (not just `[id="..."]`) to avoid matching wrapper `<div>` elements, and provide multiple `.or()` fallback selectors
- **Sidebar overlay**: The HR Tasks sidebar panel intercepts clicks on iframe buttons. Must collapse sidebar (`Navigation Area` button) before interacting with transaction forms
- PeopleSoft `selectOption()` on dropdowns triggers page refreshes — always `waitForTimeout()` after dropdown changes before filling next field
- Comp Rate Code is `UCHRLY` (not HCHRLY)
- Expected Job End Date for dining hires is constant `06/30/2026`

## UKG (Kronos) Gotchas

- UKG main content is inside iframe `widgetFrame804` (or any `widgetFrame*`) — use `getGeniesIframe(page)`
- Reports page uses three nested frames: `khtmlReportList` (nav tree), `khtmlReportWorkspace` (options), `khtmlReportingContentIframe` (content)
- UKG modals pop up unexpectedly — `dismissModal()` must be called before most interactions
- Date inputs require digit-by-digit typing (triple-click to select, Delete, Home, then type each digit with 100ms delays)
- Report status polling uses two phases: Phase 1 finds the Running/Waiting row, Phase 2 polls that specific row by TR ID until Complete
- First attempt in Phase 1 may show a stale Complete row from a previous run — must skip it and keep refreshing
- Download capture uses Playwright's download event + filesystem fallback (diff snapshots before/after clicking View Report)
- Report navigation (Go To → Reports → run → download → back) is serialized via `reportLock` mutex to avoid UKG server-side session conflicts
- Session directories are per-worker (`ukg_session_worker1`, etc.) and cleaned up after all workers finish

## UCPath Smart HR Transaction Flow (14 Steps)

1. Navigate to HR Tasks page
2. Sidebar: Smart HR Templates → Smart HR Transactions (collapse sidebar after)
3. Fill template: `UC_FULL_HIRE`
4. Fill effective date
5. Click Create Transaction
6. Select reason: `Hire - No Prior UC Affiliation`, click Continue
7. Personal Data tab: legal name, DOB, SSN, address, phone (Mobile-Personal + preferred), email (Home), tracker profile ID
8. Fill Comments textarea
9. Job Data tab
10. Fill position number, employee classification, comp rate (UCHRLY), compensation rate, expected end date
11. Earns Dist tab (visit only)
12. Employee Experience tab (visit only)
13. Fill Initiator Comments (last tab, before submit)
14. Save and Submit
