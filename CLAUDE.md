# HR Automation

UCPath HR automation tool for UCSD — automates onboarding, separations, EID lookups, work-study updates, and UKG report downloads via Playwright browser automation. Designed for multiple HR workflows built on shared modules (auth, browser, UCPath, Kuali, Old/New Kronos).

## Commands

```bash
# Onboarding
npm run start-onboarding <email>       # Run full onboarding workflow for employee
npm run start-onboarding:dry <email>   # Dry-run onboarding (preview actions, no UCPath changes)
npm run start-onboarding:batch -- <N>  # Batch onboarding with N parallel workers
npm run extract <email>                # Extract employee data from CRM only

# Separations
npm run separation <docId>             # Process separation: Kuali → Kronos → UCPath
npm run separation:dry <docId>         # Dry-run separation (extract data only)

# Kronos Reports
npm run kronos                         # Download Time Detail PDFs from UKG (4 workers)
npm run kronos:dry                     # Dry-run kronos (preview employee list)
npm run kronos -- --workers 8          # Kronos with custom worker count

# Work Study
npm run work-study <emplId> <date>     # Update position pool via PayPath Actions
npm run work-study:dry <emplId> <date> # Dry-run work study

# EID Lookup (no npm script — use CLI directly)
tsx --env-file=.env src/cli.ts eid-lookup "Last, First Middle"
tsx --env-file=.env src/cli.ts eid-lookup --workers 4 "Name1" "Name2" "Name3"

# Export
tsx --env-file=.env src/cli.ts export <workflow>     # Export JSONL tracker to Excel
tsx --env-file=.env src/cli.ts export onboarding -o out.xlsx  # Custom output path

# Utilities
npm run test-login                     # Test UCPath + CRM auth flow
npm run typecheck                      # TypeScript type checking
npm run test                           # Run unit tests
```

All runtime scripts use `tsx --env-file=.env` — never run source files directly.

## Architecture

```
src/
  auth/
    sso-fields.ts   # Shared SSO credential filling (.or() chains)
    duo-poll.ts      # Unified Duo MFA polling with recovery callbacks
    (other login flows: UCPath SSO, ACT CRM, I9, UKG, Kuali, New Kronos — separate sessions)
  browser/
    session.ts       # WorkflowSession class (shared context per workflow)
    tiling.ts        # Window tiling computation for multi-browser layouts
    (launch.ts: headed mode, ephemeral or persistent sessions)
  config.ts         # Centralized URLs, PATHS, TIMEOUTS, SCREEN, ANNUAL_DATES constants
  crm/              # ACT CRM (Salesforce) navigation, search, and data extraction
  i9/               # I9 Complete employee record creation
  kuali/            # Kuali Build separation form automation (fill, extract, save)
  new-kronos/       # New Kronos (WFD/Dayforce) employee search and timecard checking
  old-kronos/       # Old Kronos (UKG) employee search, timecard, reports, iframe handling
  tracker/
    jsonl.ts         # JSONL append-only tracker (no file locks)
    dashboard.ts     # Live SSE dashboard at localhost:3838
    export-excel.ts  # On-demand Excel export from JSONL
    locked.ts        # Generic mutex-locked write wrapper
    spreadsheet.ts   # Excel tracking with daily worksheets (YYYY-MM-DD tabs)
  ucpath/           # UCPath PeopleSoft navigation, person search, Smart HR transactions
  utils/
    screenshot.ts    # Unified debug screenshot helper
    worker-pool.ts   # Generic parallel worker pool with queue
    (env.ts, log.ts, errors.ts: env validation, logging, error helpers)
  scripts/          # Dev tools: selector exploration, batch testing, kronos mapping
  workflows/        # Multi-step workflow orchestration
    onboarding/     # CRM extraction → UCPath hire transaction, parallel processing
    separations/    # Kuali → Old/New Kronos → UCPath termination (5 tiled browsers)
    eid-lookup/     # Person Org Summary name search, CRM cross-verification, Excel output
    old-kronos-reports/  # Batch Time Detail PDF downloads from Old Kronos, parallel workers
    work-study/     # UCPath PayPath position pool/compensation updates
  cli.ts            # Commander CLI entry point
```

### Data Flows

**Onboarding:**
```
CRM (extract) → EmployeeData (schema) → Person Search (UCPath)
                                       → I9 Record (I9 Complete)
                                       → Smart HR Transaction (UCPath)
                                       → Tracker (Excel spreadsheet)
```

**Separations:**
```
Kuali (extract) → SeparationData (schema) → Old Kronos (timecard check)
                                           → New Kronos (timecard check)
                                           → UCPath Job Summary (verify)
                                           → UCPath Termination Transaction
                                           → Kuali (write back transaction ID)
```

**EID Lookup:**
```
Names (input) → Person Org Summary (UCPath) → SDCMP/HDH filter
                                             → CRM cross-verification (optional)
                                             → Tracker (Excel spreadsheet)
```

### Workflow Patterns

Workflows share common structures but vary by complexity:

**Onboarding pattern** (`src/workflows/onboarding/`):
1. `schema.ts` — Zod schema for validated employee data
2. `extract.ts` — CRM field extraction with label-based FIELD_MAP
3. `enter.ts` — ActionPlan builder composing UCPath transaction steps
4. `index.ts` — Barrel exports

**Separations pattern** (`src/workflows/separations/`):
1. `schema.ts` — Zod schema + data transformation helpers (date computation, reason code mapping)
2. `workflow.ts` — Multi-system orchestration (5 tiled browsers, parallel phases)
3. `config.ts` — URLs, template IDs, screen dimensions
4. `index.ts` — Barrel exports

## Environment

Copy `.env.example` to `.env` and fill in:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password

## Configuration

`src/config.ts` centralizes: URLs, PATHS (user-agnostic via homedir()), TIMEOUTS, SCREEN dimensions, ANNUAL_DATES (update each fiscal year). Workflow-specific configs in `src/workflows/*/config.ts` re-export from central config.

## Key Patterns

- **Separate auth flows**: UCPath, CRM, I9, UKG, Kuali, and New Kronos each use different auth — never share browser sessions between them
- **No session persistence** (UCPath/CRM/Kuali): Always login fresh, leave browser open for user to observe
- **Persistent sessions** (UKG/Kronos): Uses `launchBrowser({ sessionDir })` to reuse login state across runs
- **Headed browser**: Always use headed mode so user can see automation and approve Duo MFA
- **Sequential Duo MFA**: When multiple browsers need auth, stagger Duo prompts one at a time — simultaneous prompts cause errors
- **Multi-browser tiling**: Separations workflow launches 5 browsers tiled on screen (Kuali, Old Kronos, New Kronos, UCPath Txn, UCPath Job Summary)
- **URL params over clicking**: Prefer URL manipulation over UI navigation where possible
- **Use playwright-cli for selector discovery**: Never guess selectors — always use `playwright-cli` to map them live. See the playwright-cli section below for usage
- **Log every interaction**: Log every browser action (click, fill, navigate, wait) to console for traceability
- **ActionPlan pattern**: All UCPath transactions are built as ActionPlan steps — supports dry-run preview and step-by-step execution with error isolation
- **Tracker Excel files**: Always place tracker .xlsx files inside the workflow folder (e.g. `src/workflows/eid-lookup/eid-lookup-tracker.xlsx`), never in the project root
- **Promise.allSettled for parallel systems**: Use `Promise.allSettled` (not `Promise.all`) when querying multiple systems in parallel — one system's failure shouldn't block others
- Use `fillSsoCredentials()` and `pollDuoApproval()` — never write inline SSO/Duo loops
- Use `trackEvent()` for progress tracking — JSONL is append-safe, no file locks
- Use `WorkflowSession.create()` for new workflows — shares auth across all windows
- Use `computeTileLayout()` for multi-browser window positioning
- Use `runWorkerPool()` for parallel processing — handles queue, errors, teardown
- Live dashboard starts automatically at http://localhost:3838 during workflow runs

## Live Monitoring

All workflows automatically start a live dashboard at `http://localhost:3838` during execution. Open in a browser to see real-time progress. Data is stored in `.tracker/` as JSONL files (one per workflow per day). Export to Excel: `tsx --env-file=.env src/cli.ts export <workflow>`

## Gotchas

- UCPath content is inside iframe `#main_target_win0` (not `#ptifrmtgtframe`) — all selectors must target the iframe via `getContentFrame(page)`
- UCPath Smart HR URL must use `ucphrprdpub.universityofcalifornia.edu` subdomain (not `ucpath.`) to avoid re-triggering SSO
- Duo MFA requires manual user approval on phone — automation must pause and wait
- **PeopleSoft dynamic grid IDs**: Grid inputs (phone, email, comp rate) use indexed IDs like `HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0`. The index changes after page refreshes (e.g. position number fill). Always use `input[id="..."]` (not just `[id="..."]`) to avoid matching wrapper `<div>` elements, and provide multiple `.or()` fallback selectors
- **Sidebar overlay**: The HR Tasks sidebar panel intercepts clicks on iframe buttons. Must collapse sidebar (`Navigation Area` button) before interacting with transaction forms
- PeopleSoft `selectOption()` on dropdowns triggers page refreshes — always `waitForTimeout()` after dropdown changes before filling next field
- Comp Rate Code is `UCHRLY` (not HCHRLY)
- Expected Job End Date for dining hires is constant `06/30/2026`
- **Person Org Summary single-result redirect**: When search returns exactly 1 match, PeopleSoft skips the grid and goes directly to the detail page — automation must detect this and handle both paths
- **Name search fallbacks**: "Last, First Middle" may not match — try full name → first-only → middle-only strategies, and watch for spelling variants and legal vs preferred names

## Kuali Gotchas

- Kuali Build uses `getByRole()` selectors extensively — these are brittle if form layout changes
- Department combobox uses best-match case-insensitive selection (type then pick closest)
- Location field is optional — only filled if present in the form data
- All separations are assumed to be student employees (Final Pay = "Does not need Final Pay")
- Hardcoded space ID for the separation form

## New Kronos (WFD) Gotchas

- Uses modern `getByRole()` API — simpler than Old Kronos but different selector patterns
- Main content is inside a dynamic `portal-frame-*` iframe (ID changes per session)
- "No items to display" message indicates empty search results
- Timecard grid uses split DOM: dates in a pinned container, data in a viewport container — match by row index

## UKG (Old Kronos) Gotchas

- **4-level frame fallback strategy**: Direct ID → query selector → `page.frames()` scan → full page reload, up to 15 retries
- UKG main content is inside iframe `widgetFrame804` (or any `widgetFrame*`) — use `getGeniesIframe(page)`
- Reports page uses three nested frames: `khtmlReportList` (nav tree), `khtmlReportWorkspace` (options), `khtmlReportingContentIframe` (content)
- UKG modals pop up unexpectedly — `dismissModal()` must be called before most interactions
- Date inputs require digit-by-digit typing (triple-click to select, Delete, Home, then type each digit with 100ms delays)
- Report status polling uses two phases: Phase 1 finds the Running/Waiting row, Phase 2 polls that specific row by TR ID until Complete
- First attempt in Phase 1 may show a stale Complete row from a previous run — must skip it and keep refreshing
- Download capture uses Playwright's download event + filesystem fallback (diff snapshots before/after clicking View Report)
- Report navigation (Go To → Reports → run → download → back) is serialized via `reportLock` mutex to avoid UKG server-side session conflicts
- Session directories are per-worker (`ukg_session_worker1`, etc.) and cleaned up after all workers finish

## playwright-cli — Selector Discovery Tool

**Install**: `npm install -g @playwright/cli@latest`

playwright-cli lets you open headed browsers, interact with pages, and snapshot the full accessibility tree to discover exact selectors. **Always use this before writing new automation selectors.** Never guess selectors — map them first.

### Core Workflow

```bash
# 1. Open a browser session (named, headed)
playwright-cli -s=mysession open --headed "https://example.com"

# 2. Snapshot the page — returns full accessibility tree with ref IDs
playwright-cli -s=mysession snapshot

# 3. Interact using ref IDs from snapshot
playwright-cli -s=mysession fill e34 'some text'      # fill a textbox
playwright-cli -s=mysession click e40                   # click a button
playwright-cli -s=mysession check f4e58                 # check a checkbox

# 4. Take screenshot to visually verify
playwright-cli -s=mysession screenshot

# 5. Run JS inside the page (for iframes or complex DOM queries)
playwright-cli -s=mysession eval "(()=>{ return document.title })()"

# 6. Run JS inside an iframe (use ref from snapshot)
playwright-cli -s=mysession eval "(()=>{ return 'hello' })()" f2e1

# 7. Close when done
playwright-cli -s=mysession close
playwright-cli close-all          # close all sessions
playwright-cli kill-all           # force kill zombies
```

### Key Commands

| Command | What it does |
|---------|-------------|
| `open --headed <url>` | Open browser (visible) at URL |
| `snapshot` | Dump accessibility tree with `ref=` IDs for every element |
| `click <ref>` | Click element by ref ID |
| `fill <ref> <text>` | Fill text into input by ref |
| `check <ref>` | Check a checkbox |
| `select <ref> <value>` | Select dropdown option |
| `screenshot` | Take screenshot of current viewport |
| `eval <code>` | Run JS on page |
| `eval <code> <ref>` | Run JS scoped to element/iframe |
| `tab-list` | List all open tabs |
| `list` | List all browser sessions |

### Reading Snapshots

Snapshots return YAML-like accessibility trees:
```yaml
- button "Login" [ref=e40] [cursor=pointer]
- textbox "Username" [ref=e34]
- iframe [ref=e125]:
  - generic [ref=f2e1]:         # f-prefix = inside iframe
    - gridcell "Mon 3/16" [ref=f2e237]
```

- `ref=eNN` — element on the main page
- `ref=fNeNN` — element inside iframe N (e.g., `f2e1` = iframe 2, element 1)
- `[active]` — currently focused
- `[expanded]` — dropdown is open
- `[disabled]` — not clickable
- `[cursor=pointer]` — clickable

### Tips

- **Sessions are named** (`-s=mysession`) — you can have multiple browsers open at once
- **Iframes**: snapshot shows iframe content inline with `f`-prefixed refs. You can click/fill them directly.
- **Hidden elements**: If `click` says "element is not visible", the element is in DOM but hidden. Use `eval` with JS `.click()` instead.
- **Auth flows**: Fill SSO credentials via `fill` + `click`, then wait for Duo manually, then `snapshot` again.
- **Dropdown menus**: After clicking a dropdown trigger, `snapshot` again to see the newly visible options.
- **Split grids** (like New Kronos): Dates and data may be in separate DOM containers. Use `eval` with JS to query both and correlate by index.

### Example: Mapping a New Page

```bash
# Open and auth
playwright-cli -s=ukg open --headed "https://ucsd.kronos.net/wfc/navigator/logon"
playwright-cli -s=ukg snapshot                    # see SSO form
playwright-cli -s=ukg fill e34 'username'
playwright-cli -s=ukg fill e37 'password'
playwright-cli -s=ukg click e40                    # Login button
# ... approve Duo on phone ...
playwright-cli -s=ukg snapshot                    # see dashboard
playwright-cli -s=ukg click e74                   # click Timecards sidebar
playwright-cli -s=ukg snapshot                    # see timecard grid
playwright-cli -s=ukg screenshot                  # visual verification
```

## Separations Workflow Flow

1. Launch 5 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath Txn, UCPath Job Summary)
2. Authenticate all 5 with staggered Duo MFA (one at a time)
3. **Phase 1 (parallel)**: Extract Kuali separation data + search both Kronos systems for timesheets
4. Resolve Kronos dates: compare Old/New Kronos last timecard dates with Kuali separation date, update if needed
5. **Phase 2**: Fetch UCPath job summary, create termination Smart HR transaction
6. Termination effective date = separation date + 1 day
7. Reason code: exact match → fuzzy match → fallback mapping from Kuali termination type
8. **Phase 3**: Write UCPath transaction ID back to Kuali form, save

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
