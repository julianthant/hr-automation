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
npm run separation <id1> <id2> <id3>   # Batch separations (sequential, shared browsers)
npm run separation:dry <docId>         # Dry-run separation (extract data only)

# Kronos Reports
npm run kronos                         # Download Time Detail PDFs from UKG (4 workers)
npm run kronos:dry                     # Dry-run kronos (preview employee list)
npm run kronos -- --workers 8          # Kronos with custom worker count

# Work Study
npm run work-study <emplId> <date>     # Update position pool via PayPath Actions
npm run work-study:dry <emplId> <date> # Dry-run work study

# Emergency Contact
npm run emergency-contact <batchYaml>  # Fill Emergency Contact in UCPath for every record in a batch YAML
npm run emergency-contact:dry <batchYaml>  # Preview records without touching UCPath
# Optional flags:
#   --roster-url "<sharepoint-url>"       Download + verify against latest roster
#   --roster-path <localXlsx>             Use a local roster for pre-flight verification
#   --ignore-roster-mismatch              Proceed despite roster mismatches

# EID Lookup (no npm script — use CLI directly)
tsx --env-file=.env src/cli.ts eid-lookup "Last, First Middle"
tsx --env-file=.env src/cli.ts eid-lookup --workers 4 "Name1" "Name2" "Name3"

# Dashboard (run in a separate terminal — auto-updates when workflows run)
npm run dashboard                      # Start SSE backend + Vite dev server (http://localhost:5173)
npm run dashboard:prod                 # Serve pre-built dashboard from SSE server only
npm run dashboard -- -p 4000           # Custom SSE backend port
# dashboard.bat removed — use npm run dashboard or tsx directly

# Export
tsx --env-file=.env src/cli.ts export <workflow>     # Export JSONL tracker to Excel
tsx --env-file=.env src/cli.ts export onboarding -o out.xlsx  # Custom output path

# Utilities
npm run test-login                     # Test UCPath + CRM auth flow
npm run typecheck                      # TypeScript type checking
npm run test                           # Run unit tests
```

All runtime scripts use `tsx --env-file=.env` — never run source files directly. If `npm` is blocked by group policy, run tsx directly: `.\node_modules\.bin\tsx --env-file=.env src/cli.ts <command>`

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
    jsonl.ts         # JSONL append-only tracker + withTrackedWorkflow lifecycle wrapper
    dashboard.ts     # SSE API server (port 3838) — API-only, no HTML serving
    export-excel.ts  # On-demand Excel export from JSONL
    locked.ts        # Generic mutex-locked write wrapper
    spreadsheet.ts   # Excel tracking with daily worksheets (YYYY-MM-DD tabs)
  dashboard/          # React SPA (Vite + HeroUI v3 + Tailwind) — served via Vite dev server on port 5173
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
    emergency-contact/ # UCPath HR Tasks → Personal Data → Emergency Contact, batch-driven via YAML
  cli.ts            # Commander CLI entry point
```

### Data Flows

**Onboarding:**
```
CRM (search + record-page extract)
  → UCPath Entry Sheet extract → EmployeeData (schema)
  → CRM PDF download (Doc 1 + Doc 3 via direct iDocs fetch)
  → UCPath Person Search (rehire short-circuit if matched)
  → I-9 Complete: create employee profile → profileId
  → UCPath Smart HR Transaction (UC_FULL_HIRE, using real profileId)
  → Dashboard JSONL (no Excel tracker)
```

**Separations:**
```
Kuali (extract) → SeparationData (schema) → ┌ Old Kronos (timecard check)  ┐
                                             │ New Kronos (timecard check)  │ parallel
                                             │ UCPath Job Summary (verify)  │
                                             └ Kuali (timekeeper name fill) ┘
                                           → Resolve dates + fill Kuali fields
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

## Continuous Improvement Protocol

These rules are **mandatory** — follow them on every task, not just when asked.

### After Every Error Fix
- Update the relevant module/workflow `CLAUDE.md` with what went wrong and why
- Add the root cause under a `## Lessons Learned` section so the same error never happens again
- If the error was a selector issue, add the correct selector to the `## Verified Selectors` section

### After Every New Workflow
- Update the dashboard to support it: add to `WF_CONFIG` in `src/dashboard/components/types.ts`, add step definitions, detail fields, and name source
- Update `src/tracker/dashboard.ts` if new SSE endpoints or data formats are needed
- Add the workflow's step tracking to the root CLAUDE.md "Step Tracking Per Workflow" table
- Create a `CLAUDE.md` inside the new workflow directory following the existing pattern (Files, Data Flow, Gotchas)

### After Every Selector Mapping (playwright-cli)
- Add discovered selectors to the relevant module's `CLAUDE.md` under `## Verified Selectors`
- Include the date verified, the system/page, and the exact selector string
- If a selector changed from a previous mapping, note the old → new change
- Use these documented selectors when writing code — never guess

### When Using playwright-cli
- Always run `playwright-cli --help` first if unsure about commands
- Install/update before use: `npm install -g @playwright/cli@latest`
- Use `snapshot` before writing ANY selector — never guess from documentation or memory
- After mapping, immediately document selectors in the relevant CLAUDE.md
- Use lessons from past selector failures to inform new mappings (check `## Lessons Learned` sections)

### After Every Fix or Update
- Update the corresponding module/workflow CLAUDE.md to reflect the change
- If a gotcha was discovered, add it to the Gotchas section
- If a pattern was established, document it for future sessions
- Keep CLAUDE.md files as living documentation — they are the memory across sessions

## Key Patterns

- **Separate auth flows**: UCPath, CRM, I9, UKG, Kuali, and New Kronos each use different auth — never share browser sessions between them
- **No session persistence** (UCPath/CRM/Kuali): Always login fresh, leave browser open for user to observe
- **Persistent sessions** (UKG/Kronos): Uses `launchBrowser({ sessionDir })` to reuse login state across runs
- **Headed browser**: Always use headed mode so user can see automation and approve Duo MFA
- **Sequential Duo MFA**: When multiple browsers need auth, stagger Duo prompts one at a time — simultaneous prompts cause errors. Use auth-ready promises to interleave auth with work (see "Multi-Browser Parallel Execution" section below)
- **Multi-browser tiling**: Separations workflow launches 4 browsers tiled on screen (Kuali, Old Kronos, New Kronos, UCPath)
- **URL params over clicking**: Prefer URL manipulation over UI navigation where possible
- **Use playwright-cli for selector discovery**: Never guess selectors — always use `playwright-cli` to map them live. See the playwright-cli section below for usage
- **Log every interaction**: Log every browser action (click, fill, navigate, wait) to console for traceability
- **ActionPlan pattern**: All UCPath transactions are built as ActionPlan steps — supports dry-run preview and step-by-step execution with error isolation
- **Tracker Excel files**: Always place tracker .xlsx files inside the workflow folder (e.g. `src/workflows/eid-lookup/eid-lookup-tracker.xlsx`), never in the project root
- **Promise.allSettled for parallel systems**: Use `Promise.allSettled` (not `Promise.all`) when querying multiple systems in parallel — one system's failure shouldn't block others
- Use `fillSsoCredentials()` and `pollDuoApproval()` — never write inline SSO/Duo loops
- **`withTrackedWorkflow()` for lifecycle tracking**: Wraps workflow execution — auto-emits `pending` on start, `done` on success, `failed` on error. Provides `setStep(step)` for granular progress and `updateData(d)` to enrich entries with discovered info (names, IDs). All 5 workflows use this. Accepts `onCleanup` callback for resource teardown and optional `preAssignedRunId` for batch mode.
- **SIGINT handling**: `withTrackedWorkflow` registers a SIGINT handler that writes a `failed` tracker entry and a log entry synchronously (bypassing async mutex) before calling `process.exit`. Also kills all Playwright Chrome processes via `wmic` on Windows.
- **Error classification**: `classifyError()` in `utils/errors.ts` maps raw Playwright errors to concise user-facing messages (e.g. "Browser closed unexpectedly"). Use this in catch blocks before emitting error events.
- **Tracker functions are Excel-only**: `updateOnboardingTracker`, `updateEidTracker`, `updateKronosTracker`, `updateWorkStudyTracker` write to `.xlsx` files only — they no longer call `trackEvent()` directly. The `withTrackedWorkflow` wrapper handles all JSONL event emissions.
- Use `WorkflowSession.create()` for new workflows — shares auth across all windows
- Use `computeTileLayout()` for multi-browser window positioning
- Use `runWorkerPool()` for parallel processing — handles queue, errors, teardown

## Multi-Browser Parallel Execution

When a workflow uses multiple browser windows (e.g., separations uses 4), maximize parallelism at every stage: during authentication, during work, and during form fills. The key insight is that each browser is an independent execution context — once authenticated, it can start work immediately without waiting for other browsers.

### Pattern 1: Auth-Ready Promises (Interleaved Auth + Work)

**Problem**: Duo MFA must be sequential (one at a time), but the old approach was: auth ALL browsers → THEN start work. With 4 browsers at ~15s each, that's 60s of auth before any work begins.

**Solution**: Each browser's auth creates a "ready" promise. Work tasks chain off their own ready promise via `.then()`. As soon as one browser's Duo clears, its work starts — while the user is still approving remaining Duos on their phone.

```typescript
// Declare ready promises — default to resolved for batch mode (already authed)
let browserAReady: Promise<void> = Promise.resolve();
let browserBReady: Promise<void> = Promise.resolve();

if (existingWindows) {
  // Batch mode: browsers already authed, promises stay resolved
} else {
  // Fresh mode: auth chain runs in background
  // Auth #1 (blocking — everything depends on primary system)
  await loginToPrimary(primaryWin.page);

  // Auth #2 starts, becomes a ready promise
  browserAReady = (async () => {
    await loginToSystemA(browserA.page);
  })();

  // Wait for primary nav + Auth #2 to complete
  await Promise.allSettled([primaryNavigation(), browserAReady]);

  // Auth chain continues in background — DON'T await
  browserBReady = browserAReady
    .catch(() => {})  // don't block chain if Auth #2 failed
    .then(async () => {
      await loginToSystemB(browserB.page);
    });

  // Prevent unhandled rejection if workflow exits early
  browserBReady.catch(() => {});
}

// Work tasks chain off ready promises — start as soon as their auth clears
const [resultA, resultB] = await Promise.allSettled([
  browserAReady.then(async () => { /* System A work */ }),
  browserBReady.then(async () => { /* System B work */ }),
  (async () => { /* Primary system work — already authed, starts immediately */ })(),
]);
```

**Key rules**:
- `.catch(() => {})` between chain steps prevents one auth failure from blocking subsequent auths
- Add `browserBReady.catch(() => {})` at the end to prevent unhandled rejection if workflow exits before `Promise.allSettled` consumes the promise
- In batch mode (reusing browsers), ready promises are `Promise.resolve()` → `.then()` fires immediately
- Health checks (`ensurePageHealthy`) must be batch-only — in fresh mode, browsers may not be authed yet when Phase 1 starts

### Pattern 2: Phase Parallelization (Independent Tasks in Parallel)

**Problem**: Workflows often have phases that run sequentially even though they have no data dependency on each other.

**Solution**: Identify which tasks actually depend on each other vs. which just happen to use different browser windows. Run independent tasks in the same `Promise.allSettled` block.

**How to identify parallelizable tasks**: For each task, ask: "What data does this need that isn't available yet?" If the answer is only data from the extraction phase (already complete), it can run in parallel with other such tasks.

```
Before: Extract → Phase 1 (System A + B) → Phase 2 (System C + form fill) → Transaction
After:  Extract → [System A + System B + System C + form fill] → Transaction
                   (all in parallel — different browser windows, no data conflicts)
```

**Separations example** — tasks after Kuali extraction:
| Task | Needs | Browser | Can parallelize? |
|------|-------|---------|-----------------|
| Old Kronos search | EID | oldKronosWin | Yes |
| New Kronos search | EID | newKronosWin | Yes |
| UCPath Job Summary | EID | ucpathWin | Yes |
| Kuali timekeeper fill | Timekeeper name | kualiWin | Yes (different form fields) |
| Kuali term date fill | Kronos dates | kualiWin | No — depends on Kronos results |
| UCPath Transaction | Final term date | ucpathWin | No — depends on Kronos + Job Summary |

Result: 4 tasks run in parallel, 2 must wait. The bottleneck (Old Kronos, ~60s) hides the others (~15-30s each).

### Pattern 3: Batch-Only Guards

Operations that reset state between items (health checks, browser resets, UCPath session resets) are only needed in batch mode. In fresh mode, browsers were just launched and authenticated — skip the overhead.

```typescript
// Health checks + reset: batch mode only
if (existingWindows) {
  await Promise.allSettled([
    ensurePageHealthy(browserA.page, ...),
    ensurePageHealthy(browserB.page, ...),
  ]);
  // Reset browsers to starting state for next item
  await Promise.allSettled([resetBrowserA(), resetBrowserB()]);
}

// Post-transaction cleanup: batch mode only
if (existingWindows) {
  await navigateToStartPage(browser.page);
}
```

### Pattern 4: Same-Page Parallel Form Fills

When filling a long form, independent sections can be filled in parallel IF:
1. They use different form fields (no DOM conflicts)
2. Neither triggers a page navigation or refresh
3. They happen on the same already-loaded page

**Safe**: Filling "Timekeeper Name" while Kronos searches run (different page section, different browser)
**Unsafe**: Filling a PeopleSoft dropdown while another field is being filled (dropdown triggers page refresh)

### Applying to New Workflows

When building a multi-browser workflow:

1. **Map data dependencies**: Draw which tasks need which data. Only tasks that need data from a prior task must be sequential.
2. **Assign browser windows**: Each parallel task should use its own browser window. Never share a browser between parallel tasks.
3. **Use auth-ready promises**: If the workflow needs multiple Duo auths, use the interleaved pattern so work starts as each browser authenticates.
4. **Use Promise.allSettled**: Never `Promise.all` — one system's failure shouldn't crash the workflow. Handle each result independently.
5. **Batch-only guards**: If the workflow supports batch mode (sequential items, reused browsers), guard health checks and resets behind `if (existingWindows)`.

### Timing Reference (Separations Workflow)

Fresh launch (first document):
```
Auth Kuali (#1)              ████  15s
[Kuali nav ‖ Old Kronos #2]  ��███  15s
Extract (1s) — auth chain continues in background:
  Old Kronos work starts     ████████████████████████████  60s
  Auth New Kronos (#3, 15s)  → New Kronos work  ████████████████  33s
  Auth UCPath (#4, 15s)                         → Job Summary  ██████  15s
Grand total: ~91s (was ~120s without interleaving)
```

Batch mode (2nd+ documents, browsers already authed):
```
Kuali nav + extract          ████████  24s
[Old Kronos ‖ New Kronos ‖ Job Summary ‖ Kuali fill]  ████████████████████████████  60s
(Job Summary + Kronos run in parallel — was sequential before)
Grand total: ~90s per doc (was ~120s without phase parallelization)
```

## Live Monitoring Dashboard

Run `npm run dashboard` in a separate terminal. This starts:
- **SSE API server** on port 3838 (reads `.tracker/` JSONL files, streams via Server-Sent Events)
- **Vite dev server** on port 5173 (React SPA with hot reload, proxies `/api` and `/events` to 3838)

Open **http://localhost:5173** to see real-time progress. The dashboard auto-updates when any workflow runs.

### How It Works
1. Workflows use `withTrackedWorkflow()` which emits events to `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`
2. Log calls via `withLogContext()` emit to `.tracker/{workflow}-{YYYY-MM-DD}-logs.jsonl`
3. SSE server polls these files (1s for entries, 500ms for logs) and streams to the React frontend
4. SSE server enriches entries with `firstLogTs`, `lastLogTs`, `lastLogMessage` per (itemId, runId)
5. Dashboard dedupes entries by ID (keeps latest), sorts by running start time (firstLogTs), pending at bottom
6. Workflow dropdown counts come from backend (`wfCounts`) for cross-workflow accuracy

### Step Tracking Per Workflow
| Workflow | Steps |
|----------|-------|
| Onboarding | crm-auth → extraction → pdf-download → ucpath-auth → person-search → i9-creation → transaction |
| Separations | launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization |
| EID Lookup | ucpath-auth → searching (+ crm-auth → cross-verification for CRM mode) |
| Kronos Reports | searching → extracting → downloading |
| Work Study | ucpath-auth → transaction |
| Emergency Contact | navigation → fill-form → save (per record) |

Export to Excel: `tsx --env-file=.env src/cli.ts export <workflow>`

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

**Install/Update**: `npm install -g @playwright/cli@latest` (run before every playwright session)

**First step**: Always run `playwright-cli --help` if unsure about commands or after updating.

playwright-cli lets you open headed browsers, interact with pages, and snapshot the full accessibility tree to discover exact selectors. **Always use this before writing new automation selectors.** Never guess selectors — map them first. After mapping, immediately document selectors in the relevant module's `CLAUDE.md` under `## Verified Selectors`.

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

1. Launch 4 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath)
2. Auth Kuali (Duo #1), then Kuali nav + Old Kronos auth (Duo #2) in parallel
3. Auth chain continues in background (New Kronos #3, UCPath #4) — extraction proceeds immediately
4. Extract Kuali separation data, compute termination effective date (separation date + 1 day)
5. **Phase 1 (4-way parallel)**: Each task starts as soon as its auth clears:
   - Old Kronos timecard search (starts immediately — auth already done)
   - New Kronos timecard search (starts when Duo #3 approved)
   - UCPath Job Summary lookup (starts when Duo #4 approved)
   - Kuali timekeeper name fill (starts immediately — already authed)
6. Resolve Kronos dates: Kronos dates always override Kuali dates when they differ (ground truth)
7. Fill remaining Kuali fields (term effective date, department, payroll code)
8. **UCPath Transaction**: Create termination Smart HR transaction
9. Reason code: exact match → fuzzy match → fallback mapping from Kuali termination type
10. **Kuali Finalization**: Write UCPath transaction ID back to Kuali form, save

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
