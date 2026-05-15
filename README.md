# HR Automation

UCPath HR automation for UCSD. Playwright-driven workflows for onboarding, separations, EID lookups, work-study updates, oath signatures, oath uploads, emergency contacts, and UKG report downloads.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # fill in credentials
npm run setup          # validates environment
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `UCPATH_USER_ID` | UCSD SSO username |
| `UCPATH_PASSWORD` | UCSD SSO password |
| `NAME` | Your timekeeper name (used in Kuali separation forms) |

Duo MFA is manual — the automation pauses and polls until you approve on your phone.

## Commands

Most commands use **daemon mode**: the first invocation spawns a persistent process (Duo once), subsequent invocations enqueue without re-authenticating. Use `:stop` to drain and shut down, `-n` to force-spawn an additional daemon, `-p N` to ensure N daemons are alive.

### Onboarding
```bash
npm run onboarding <email> [<email> ...]     # Enqueue; auto-spawns a daemon (CRM + UCPath + I9 Duo once)
npm run onboarding:stop                      # Soft-stop all onboarding daemons
npm run extract <email>                      # Extract employee data from CRM only (no UCPath)
```

### Separations
```bash
npm run separation <docId> [docId ...]       # Enqueue; auto-spawns a daemon
npm run separation:stop                      # Soft-stop all separation daemons
```

### Work Study
```bash
npm run work-study <emplId> <date>           # Enqueue UCPath PayPath update
npm run work-study:stop
```

### EID Lookup
```bash
npm run eid-lookup "Last, First Middle"      # Enqueue; auto-spawns a daemon
npm run eid-lookup:stop
```

### Active Check
```bash
npm run active-check "Last, First Middle"    # Check UCPath active status by name
npm run active-check 10873698                # Check by 8-digit EID
npm run active-check:stop
```

### Oath Signature
```bash
npm run oath-signature <emplId> [emplId ...] # Enqueue UCPath oath signature
npm run oath-signature:stop
```

### Oath Upload
```bash
npm run oath-upload <pdfPath> [pdfPath ...]  # OCR → fan out signatures → HR ticket
npm run oath-upload:stop
```

### Emergency Contact
```bash
npm run emergency-contact <batchYaml>        # Load YAML → preflight → enqueue each record
npm run emergency-contact:stop
# Flags: --roster-url "<sp-url>" | --roster-path <xlsx> | --ignore-roster-mismatch | -p N | -n
```

### CRM Doc Download
```bash
npm run crm-doc-download                     # Download iDocs PDFs from CRM (delegation target)
npm run crm-doc-download:stop
```

### Kronos Reports
```bash
npm run kronos                               # Download Time Detail PDFs (4 parallel workers)
```

### Dashboard
```bash
npm run dashboard                            # SSE backend (:3838) + Vite dev (:5173)
npm run dashboard:watch                      # Same, but tsx watch restarts SSE backend on src/ changes
npm run dashboard:prod                       # Serve pre-built dashboard from SSE only
npm run dashboard:tunneled                   # Dashboard with tunnel support
```

Open **http://localhost:5173** to monitor live workflow progress.

### Export / Utilities
```bash
tsx --env-file=.env src/cli.ts export <workflow>   # Dump JSONL tracker to xlsx
npm run clean:tracker                              # Prune .tracker/*.jsonl older than 30 days
npm run test-login                                 # Smoke test UCPath + CRM auth
npm run setup                                      # First-use environment validation wizard
npm run schemas:export                             # Write each workflow's Zod input schema as JSON Schema
npm run selectors:catalog                          # Regenerate per-system SELECTORS.md
npm run selector:search "<intent>"                 # Fuzzy search across SELECTORS.md + LESSONS.md
npm run typecheck                                  # Type-check src/
npm run typecheck:all                              # Type-check src/ + tests
npm run lint                                       # ESLint
npm run test                                       # Unit tests
npm run test:architecture                          # Static architecture/convention guards
npm run build:dashboard                            # Single-file dashboard build
```

> If `npm run` is blocked, invoke tsx directly: `./node_modules/.bin/tsx --env-file=.env src/cli.ts <command>`

## Architecture

See `CLAUDE.md` for the full architecture reference, kernel API, daemon mode design, and workflow authoring guide.

```
src/
  core/          # Workflow kernel (kernel/, daemon/, task-store/)
  systems/       # Playwright drivers: crm, ucpath, i9, kuali, old-kronos, new-kronos, servicenow, sharepoint
  workflows/     # Composed workflows: onboarding, separations, eid-lookup, active-check, work-study,
                 #   oath-signature, oath-upload, emergency-contact, ocr, old-kronos-reports,
                 #   sharepoint-download, crm-doc-download
  infra/         # Auth flows + browser launch
  services/      # OCR, roster matching, mobile photo capture
  tracker/       # JSONL append + SSE + Excel export
  dashboard/     # React SPA (Vite + shadcn/ui)
  domain/        # Pure HR business logic (identity, names, EIDs, etc.)
  utils/         # log, errors, env
  cli.ts         # Commander entry point
  config.ts      # URLs, PATHS, TIMEOUTS, SCREEN, ANNUAL_DATES
```

## How It Works

All workflows run headed Chromium browsers so you can approve Duo MFA prompts. In **daemon mode**, browsers stay open between items — Duo fires once per daemon spawn, not per item. Subsequent enqueues claim work from a shared SQLite queue without re-authentication.

### Selector Discovery

```bash
npm install -g @playwright/cli@latest
playwright-cli -s=mysession open --headed "<url>"
playwright-cli -s=mysession snapshot    # accessibility tree with ref IDs
playwright-cli -s=mysession click e40   # interact by ref
```

After mapping, add to `src/systems/<system>/selectors.ts` with `// verified YYYY-MM-DD`. Run `npm run selectors:catalog` to sync.
