# HR Automation

UCPath HR automation tool for UCSD. Automates onboarding, separations, EID lookups, work-study updates, and UKG report downloads via Playwright browser automation.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # fill in your UCSD credentials
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `UCPATH_USER_ID` | UCSD SSO username |
| `UCPATH_PASSWORD` | UCSD SSO password |
| `NAME` | Your timekeeper name (for Kuali forms) |

## Commands

### Onboarding

```bash
npm run onboarding <email>                   # Full onboarding for one employee
npm run onboarding <email1> <email2> ...     # Pool mode (min(N, 4) workers; override with --workers)
npm run onboarding:dry <email>               # Dry-run (preview, no UCPath changes)
npm run onboarding:batch -- --workers <N>    # Batch mode — reads src/workflows/onboarding/batch.yaml (N workers)
npm run extract <email>                      # Extract employee data from CRM only
```

### Separations

```bash
npm run separation <docId>             # Kuali -> Kronos -> UCPath termination
npm run separation:dry <docId>         # Dry-run (extract data only)
```

### Kronos Reports

```bash
npm run kronos                         # Download Time Detail PDFs (4 workers)
npm run kronos:dry                     # Dry-run (preview employee list)
npm run kronos -- --workers 8          # Custom worker count
```

### Work Study

```bash
npm run work-study <emplId> <date>     # Update position pool via PayPath
npm run work-study:dry <emplId> <date> # Dry-run
```

### EID Lookup

```bash
npx tsx --env-file=.env src/cli.ts eid-lookup "Last, First Middle"
npx tsx --env-file=.env src/cli.ts eid-lookup --workers 4 "Name1" "Name2"
```

### Dashboard

```bash
npm run dashboard                      # SSE backend + Vite dev server
npm run dashboard:prod                 # Serve pre-built dashboard only
npm run dashboard -- -p 4000           # Custom SSE port
```

Open **http://localhost:5173** to see real-time workflow progress.

### Export

```bash
npx tsx --env-file=.env src/cli.ts export <workflow>
npx tsx --env-file=.env src/cli.ts export onboarding -o out.xlsx
```

### Utilities

```bash
npm run test-login                     # Test UCPath + CRM auth
npm run typecheck                      # TypeScript type checking
npm run test                           # Run unit tests
```

> If `npm` is blocked by group policy, run tsx directly: `.\node_modules\.bin\tsx --env-file=.env src/cli.ts <command>`

## Architecture

```
src/
  cli.ts              # Commander CLI entry point
  config.ts           # Centralized URLs, paths, timeouts, screen dimensions
  auth/               # SSO login flows (UCPath, CRM, UKG, Kuali, New Kronos)
  browser/            # Playwright browser launch, session management, window tiling
  crm/                # ACT CRM search, navigation, field extraction
  i9/                 # I9 Complete employee record creation
  kuali/              # Kuali Build separation form automation
  new-kronos/         # New Kronos (WFD) employee search
  old-kronos/         # Old Kronos (UKG) search, reports, iframe handling
  ucpath/             # UCPath PeopleSoft navigation, Smart HR transactions
  tracker/            # JSONL streaming + Excel tracking + SSE dashboard server
  dashboard/          # React SPA (Vite + Tailwind + shadcn/ui)
  utils/              # Env validation, logging, error helpers, worker pool
  workflows/
    onboarding/       # CRM extraction -> UCPath hire transaction
    separations/      # Kuali -> Kronos -> UCPath termination (5 browsers)
    eid-lookup/       # Person Org Summary search + CRM cross-verification
    old-kronos-reports/ # Batch Time Detail PDF downloads
    work-study/       # UCPath PayPath position pool updates
  scripts/            # Dev tools: selector exploration, batch testing
```

## How It Works

All workflows run **headed Chromium browsers** so you can see the automation and approve Duo MFA prompts on your phone. Browsers stay open after completion for inspection.

### Workflow Data Flows

**Onboarding**: CRM (extract employee data) -> UCPath (person search + Smart HR hire transaction) -> Excel tracker

**Separations**: Kuali (extract termination data) -> Old/New Kronos (timecard check) -> UCPath (termination transaction) -> Kuali (write back transaction ID)

**EID Lookup**: UCPath Person Org Summary (name search) -> SDCMP/HDH filter -> optional CRM cross-verification -> Excel tracker

**Kronos Reports**: UKG (search employee -> run Time Detail report -> download PDF) in parallel across N workers

**Work Study**: UCPath PayPath Actions (search by ID -> update position pool/compensation)

## Dashboard

The live monitoring dashboard shows real-time workflow progress:

- **SSE backend** (port 3838) reads `.tracker/` JSONL files and streams updates
- **React frontend** (port 5173) displays queue status, log streams, and step progress

Workflows emit events via `withTrackedWorkflow()`. The dashboard deduplicates entries by ID and sorts by status: running > pending > failed > done.

## Key Concepts

- **Separate auth flows** — Each system (UCPath, CRM, UKG, Kuali, New Kronos) has its own login. Never share browser sessions.
- **Sequential Duo MFA** — When multiple browsers need auth, Duo prompts are staggered one at a time.
- **ActionPlan pattern** — UCPath transactions are built as step queues supporting dry-run preview and error isolation.
- **Persistent sessions** — UKG/Kronos reuse login state via `sessionDir`. UCPath/CRM always login fresh.
- **`withTrackedWorkflow`** — Lifecycle wrapper that auto-emits JSONL events for dashboard streaming.

## Development

```bash
npm run typecheck        # Type check
npm run test             # Run tests
npm run dev:dashboard    # Dashboard dev server with hot reload
```

### Selector Discovery

Use [playwright-cli](https://www.npmjs.com/package/@anthropic-ai/playwright-cli) to map selectors before writing automation code:

```bash
npm install -g @playwright/cli@latest
playwright-cli -s=mysession open --headed "https://example.com"
playwright-cli -s=mysession snapshot    # accessibility tree with ref IDs
playwright-cli -s=mysession click e40   # interact by ref
```
