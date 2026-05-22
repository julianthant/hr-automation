# HR Automation

UCPath HR automation for UCSD. Playwright-driven onboarding, separations, EID lookups, work-study updates, UKG report downloads, and emergency contact fills — composed from per-system drivers and a small workflow kernel.

## Before You Start

**Read the relevant local CLAUDE.md FIRST — it's the source of truth for domain-specific patterns, gotchas, and verified selectors:**

- **System driver work** (selectors, auth, Playwright)?  
  → `src/systems/<system>/CLAUDE.md` (UCPath, CRM, I9, Kuali, Kronos, ServiceNow, SharePoint). Check `LESSONS.md` before mapping selectors.
- **Workflow implementation or modification?**  
  → `src/workflows/<workflow>/CLAUDE.md`
- **Dashboard or tracker changes?**  
  → `src/dashboard/CLAUDE.md` or `src/tracker/CLAUDE.md`
- **Shared primitives or architecture?**  
  → `docs/engineering/codebase-conventions.md`
- **Which markdown is canonical vs ephemeral (reviews, drift checks)?**  
  → `docs/README.md`

**General lessons that apply everywhere:**  
→ `LESSONS.md` (project root) — read before every non-trivial task. Selector workflow, shared code boundaries, kernel patterns, common mistakes, architecture guards, daemon mode.

Before non-trivial tasks:
- **Read `LESSONS.md`** in the project root — cross-codebase patterns, common mistakes, architecture decisions.
- **Query claude-mem** with `mem-search` skill to surface prior solutions.

## Commands

```bash
# Onboarding (daemon mode by default — see "Daemon mode" below)
npm run onboarding <email> [<email> ...]     # Enqueue each email as a separate queue item; daemon processes one at a time. Use `-p N` to spawn N daemons for parallel fan-out.
npm run onboarding:stop                      # Soft-stop all daemons

# Separations (daemon mode by default — see "Daemon mode" below)
npm run separation <docId> [docId ...] # Enqueue to an alive daemon or spawn one
npm run separation:stop                # Soft-stop all daemons (drain in-flight)

# Kronos Reports
npm run kronos                         # Download Time Detail PDFs (kernel pool mode, default 4 workers — edit DEFAULT_WORKERS in config.ts to change)

# Work Study (daemon mode by default — see "Daemon mode" below)
npm run work-study <emplId> <date>     # Enqueue to an alive daemon or spawn one
npm run work-study:stop                # Soft-stop all daemons

# Emergency Contact (daemon mode by default — see "Daemon mode" below)
npm run emergency-contact <batchYaml>      # Load YAML → preflight → enqueue each record to an alive daemon
npm run emergency-contact:stop             # Soft-stop all daemons
# Flags: --roster-url "<sp-url>" | --roster-path <xlsx> | --ignore-roster-mismatch | -p <N> | -n

# EID Lookup (daemon mode by default — see "Daemon mode" below)
npm run eid-lookup "Last, First Middle"    # Enqueue to an alive daemon or spawn one (CRM-on variant)
npm run eid-lookup:stop                    # Soft-stop all daemons

# Active Check (daemon mode by default — see "Daemon mode" below)
npm run active-check "Last, First Middle"  # Check UCPath Person Org Summary active status by name
npm run active-check 10873698               # Same check by EID (8-digit)
npm run active-check:stop                   # Soft-stop all daemons

# Oath Signature (daemon mode by default — see "Daemon mode" below)
npm run oath-signature <emplId> [emplId ...]     # Enqueue to an alive daemon or spawn one (UCPath only)
npm run oath-signature:stop                      # Soft-stop all daemons

# Oath Upload (daemon mode by default — see "Daemon mode" below)
npm run oath-upload <pdfPath> [pdfPath ...]      # Upload paper-oath PDF; OCR → fan out signatures → file HR ticket
npm run oath-upload:stop                         # Soft-stop all daemons

# Dashboard (separate terminal — auto-updates as workflows run)
npm run dashboard            # SSE backend (:3838) + Vite dev (:5173) — open http://localhost:5173
npm run dashboard:watch      # Same as `dashboard`, but tsx watch restarts the SSE backend process on src/ changes (full restart, not HMR)
npm run dashboard:prod       # Serve pre-built dashboard from SSE only

# Export / Utilities
tsx --env-file=.env src/cli.ts export <workflow>   # Dump JSONL tracker to xlsx
npm run clean:tracker                              # Prune .tracker/*.jsonl older than 7 days (default)
npm run clean:tracker -- --days 30 --dir .tracker  # Custom age + dir
npm run test-login                                 # Smoke test UCPath + CRM auth
npm run setup                                      # First-use environment validation wizard
npm run schemas:export                             # Write each workflow's Zod input schema as JSON Schema
npm run selectors:catalog                          # Regenerate per-system SELECTORS.md from selectors.ts
npm run selector:search "<intent>"                 # Fuzzy search across SELECTORS.md + LESSONS.md
npm run typecheck                                  # Type-check src/
npm run typecheck:all                              # Type-check src/ + tests
npm run test                                       # Unit tests
npm run test:architecture                          # Static architecture/convention guards
npm run build:dashboard                            # Single-file dashboard build
```

All runtime scripts use `tsx --env-file=.env` (tsx is in `devDependencies` and picks up the env file natively). If `npm run` is blocked by group policy, invoke tsx directly: `./node_modules/.bin/tsx --env-file=.env src/cli.ts <command>`. If the `tsx` binary itself is blocked (symlinked bins occasionally are), fall back to `node --import tsx/esm --env-file=.env src/cli.ts <command>` — same behaviour, just wordier.

## Architecture

The repo is split into clear layers: business concepts (`src/domain/`), runtime infrastructure (`src/infra/`), reusable services (`src/services/`), per-system drivers (`src/systems/`), the workflow kernel (`src/core/`), and composed workflows (`src/workflows/`). Tracker, dashboard, scripts, and utils remain top-level support areas.

```
src/
  core/                # Workflow kernel, daemon mode, and SQLite control plane
    kernel/            # defineWorkflow, Session, Stepper, Ctx, pool, batch helpers
      types.ts, workflow.ts, pool.ts, session.ts, stepper.ts, registry.ts, ctx.ts,
      batch-helpers.ts, batch-lifecycle.ts, shared-context-pool.ts, run-one-item.ts,
      run-workflow.ts, session-observer.ts, workflow-tracker-data.ts
    daemon/            # Daemon mode: registry, queue, client, HTTP keepalive
      types.ts, registry.ts, queue.ts, client.ts, daemon.ts, http.ts,
      worker-store.ts, keepalive.ts, enqueue-dispatch.ts, daemon-types.ts,
      auth-timing.ts, shutdown.ts, worker-commands.ts, in-process-control.ts
    task-store/        # SQLite control plane: enqueue, claim, retry, terminal
      index.ts, enqueue.ts, claim.ts, retry.ts, terminal.ts, queries.ts, types.ts, child-state.ts
    control-db.ts, control-schema.ts, workflow-loaders.ts, find-input.ts,
    task-control.ts, task-display.ts
    index.ts           # Barrel re-export
  systems/             # Playwright drivers, one per external system
    common/            # safeClick / safeFill / dismissPeopleSoftModalMask (cross-system)
    crm/               # ACT CRM (Salesforce) search + record-page extract
    i9/                # I9 Complete employee profile + record creation
    ucpath/            # PeopleSoft Smart HR, person search, PayPath, emergency contact, ActionPlan
    kuali/             # Kuali Build separation form extract + fill
    new-kronos/        # WFD/Dayforce employee search + timecard
    old-kronos/        # UKG Kronos search + Time Detail report download
    servicenow/        # support.ucsd.edu HR Inquiry form (oath-upload tickets)
    sharepoint/        # SharePoint document download (roster files)
  workflows/           # Composed workflows — each is defineWorkflow(...) + CLI adapter
    work-study/        # Kernel. UCPath PayPath work-study update.
    emergency-contact/ # Kernel (batch, preEmitPending). UCPath Emergency Contact fill.
    eid-lookup/        # Kernel. Person Org Summary lookup + optional CRM cross-verify.
    active-check/      # Kernel. Person Org Summary active/inactive check by name or EID.
    onboarding/        # Kernel (single mode). CRM → UCPath + I9. Daemon mode for repeated runs.
    separations/       # Kernel (4 systems, interleaved auth, sequential batch via runWorkflowBatch).
    old-kronos-reports/# Kernel (pool mode, N workers, per-worker sessionDir via opts.launchFn).
    oath-signature/    # Kernel + daemon-mode. UCPath oath signature transaction.
    oath-upload/       # Kernel + daemon-mode. ServiceNow + delegated OCR + delegated oath-signature.
    ocr/               # Kernel (dashboard HTTP only). Upload PDF → OCR → match → delegate downstream.
    sharepoint-download/ # Kernel helper: headed roster download from SharePoint (dashboard / CLI script).
    crm-doc-download/  # Kernel (delegation target). Downloads iDocs PDFs from CRM.
  infra/               # Runtime infrastructure that makes automation possible.
    auth/              # Per-system login flows + duo-poll + sso-fields (shared).
    browser/           # launchBrowser, tiling math. Kernel-internal.
  services/            # Reusable IO/stateful primitives used by workflows + dashboard backend.
    capture/           # Mobile photo capture + QR/session/PDF bundling.
    matching/          # Roster loading, name/address/EID matching, optional LLM disambiguation.
    timecard/          # Shared UKG/timecard helpers (Old/New Kronos workflows).
    ocr/               # OCR engine, provider rotation, page rendering, form specs.
  tracker/             # JSONL append + SSE dashboard server + Excel export.
  dashboard/           # React SPA (Vite + shadcn/ui). Reads SSE, renders queue + logs.
  utils/               # env / errors / log (with AsyncLocalStorage runId context).
  scripts/             # Dev tools: selector exploration, batch testing.
  cli.ts               # Commander entry point.
  config.ts            # URLs, PATHS (via homedir), TIMEOUTS, SCREEN, ANNUAL_DATES.
```

### Data flows

**Onboarding (kernel, single mode)**
```
CRM (search + extract) → EmployeeData
  → CRM PDFs (direct iDocs fetch)
  → UCPath Person Search (rehire → short-circuit)
  → I9 search by SSN (reuse existing) | I9 create (profile + Section 1)
  → UCPath Smart HR Transaction (UC_FULL_HIRE, real profileId)
```

**Separations (legacy)**
```
Kuali extract → SeparationData → 4-way parallel:
  [Old Kronos timecard | New Kronos timecard | UCPath Job Summary | Kuali timekeeper fill]
  → Kronos dates override Kuali → fill remaining Kuali → UCPath termination → Kuali finalize
```

**EID lookup (kernel)**
```
Names → (shared-context pool, N tabs) → Person Org Summary (UCPath)
  → SDCMP/HDH filter → per-name dashboard row
  [optional] → CRM search + hire-date / EID cross-verify
```

Observability for every workflow: `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` + `*-logs.jsonl`, streamed to the dashboard. Some workflows also write xlsx trackers (see per-workflow docs).

## Where to Find Things

| Need | Location | Method |
|---|---|---|
| Playwright selector for UI element | `src/systems/<system>/selectors.ts` | Use `npm run selector:search "intent"` first; never guess |
| Lessons from past selector failures | `src/systems/<system>/LESSONS.md` | Append-only; read before mapping new selectors |
| Workflow implementation example | `src/workflows/work-study/` or `src/workflows/onboarding/` | Reference minimal (work-study) or complex (onboarding) example |
| Selector registry, intelligence artifacts, playwright-cli guide | `src/systems/CLAUDE.md` | All systems' selectors.ts layout, SELECTORS.md, LESSONS.md, selector discovery workflow |
| New workflow guide + archetype glossary | `src/workflows/CLAUDE.md` | Writing a new workflow, archetypes, daemon conversion template |
| Kernel API (defineWorkflow, Ctx, etc.) | `src/core/CLAUDE.md` | User-facing primer, Ctx methods, run modes, dupe-protection |
| Daemon mode (queues, health checks, etc.) | `src/core/CLAUDE.md` | Queue mechanics, flags, daemon conversion guide |
| Dashboard internals & React components | `src/dashboard/CLAUDE.md` | SSE streams, queue rendering, detail panels |
| Tracker & JSONL observability patterns | `src/tracker/CLAUDE.md` | Emit patterns, Excel export, child-run delegation |
| System-specific gotchas | `src/systems/<system>/CLAUDE.md` | PeopleSoft quirks, frame navigation, auth edge cases |
| Shared primitives & anti-patterns | `src/domain/`, `src/services/`, `src/infra/` + `docs/engineering/codebase-conventions.md` | Names, operators, logs, matching, OCR, capture, auth/browser — use before adding workflow-local |
| Canonical vs ephemeral docs (review / drift-check scope) | `docs/README.md` | Maintained codebase narrative vs `superpowers/` handoffs & plans vs historical snapshots |
| Architecture guards & what they enforce | `npm run test:architecture` + test files in `tests/unit/` | No inline selectors, no default exports, lesson format, catalog sync |
| General cross-codebase lessons | `LESSONS.md` (project root) | Read before every non-trivial task |

## Codebase conventions

Full rules: `docs/engineering/codebase-conventions.md`. Key points:
- No default exports in `src/`.
- No `page.locator(...)` inline in system files (architecture guard enforces this).
- Action-oriented function names: `parse`, `normalize`, `display/format`, `derive`, `resolve`, `build`, `create`, `read/write/list/find`, `is/has/can/should`, `ensure`, `assert`, `run`.
- Shared helpers used by 2+ workflows (or 1 workflow + tracker/dashboard/core/OCR) → promote out of `src/workflows/<workflow>/`. Shared homes listed in `src/workflows/CLAUDE.md`.
- Use `log.*` with structured fields; no ad hoc `console.*`, toasts, or Telegram messages.

## Best Practices

**Selectors:** `npm run selector:search "<intent>"` first — use any existing match. New: map via `playwright-cli`, add JSDoc + `// verified <date>` to `selectors.ts`, run `npm run selectors:catalog`. Full workflow: `src/systems/CLAUDE.md`.

**Writing a new workflow:** See `src/workflows/CLAUDE.md` for `defineWorkflow` example, archetype vocabulary, and daemon-mode conversion template. Kernel API details: `src/core/CLAUDE.md`.

**Architecture guards:** `npm run test:architecture` before commits.

**Continuous improvement:** After every fix or new pattern, add a dated lesson entry to the relevant CLAUDE.md.

**Testing:** `npm run test` + `npm run test:architecture` before PRs.

## Environment

Copy `.env.example` → `.env` and set:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password
- `TIMEKEEPER_NAME` — operator timekeeper name for Kuali separation timekeeper fills (required; `src/config.ts` throws at startup if unset)

Duo MFA is manual — the automation pauses and polls until you approve on your phone.

## Configuration

`src/config.ts` centralizes URLs, PATHS (user-agnostic via `homedir()`), TIMEOUTS, SCREEN dimensions, and ANNUAL_DATES (update each fiscal year). Workflow-specific configs in `src/workflows/*/config.ts` re-export or narrow.

## System-Specific Gotchas

All system-level gotchas (PeopleSoft modal mask, frame navigation, dropdown behavior, grid ID mutation, date input quirks, etc.) live in per-system CLAUDE.md files:

- **UCPath** → `src/systems/ucpath/CLAUDE.md`  
- **CRM** → `src/systems/crm/CLAUDE.md`  
- **I9** → `src/systems/i9/CLAUDE.md`  
- **Kuali** → `src/systems/kuali/CLAUDE.md`  
- **Old/New Kronos** → `src/systems/old-kronos/CLAUDE.md` and `src/systems/new-kronos/CLAUDE.md`  
- **ServiceNow** → `src/systems/servicenow/CLAUDE.md`

Check the relevant system's CLAUDE.md before you get bitten. Lessons from past failures live in `src/systems/<system>/LESSONS.md`.

## Dashboard

`npm run dashboard` starts SSE backend (`:3838`) + Vite frontend (`:5173`). Observation-only: workflows launched via npm scripts, dashboard displays live queue and logs.

Workflows emit JSONL to `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`; SSE server streams to React SPA. All UI metadata (label, steps, detailFields) comes from server-side kernel registry — no frontend edits needed when adding workflows.

**Details:** See `src/dashboard/CLAUDE.md` (frontend), `src/tracker/CLAUDE.md` (backend).

## Deferred & archived docs

**Canonical maintained docs** (conventions, architecture, module `CLAUDE.md`, lessons, selector catalogs) are listed under **Canonical** in `docs/README.md`.

**Ephemeral / tool-generated** material under `docs/superpowers/` (including **`handoffs/`** for session pickup), plus `.superpowers/`, is scratch and continuity output — useful for *why* something was decided or what to do next in a fresh session, not guaranteed to match shipped code. **Do not** treat it as the documentation surface area for routine doc review.

**Frozen dated snapshots** (old backlog lists, etc.) live under `docs/historical/` — see that folder’s README.

Individual specs under `docs/superpowers/specs/` may exist only in your working tree if never committed; those paths remain valid *historical* references when linked from lesson sections in `CLAUDE.md` files.

## Continuous improvement

After every error fix, selector re-map, or new pattern: update the relevant CLAUDE.md. These files are the only memory between sessions — keep them accurate. Add notes to `## Lessons Learned` in the module/workflow you touched; bump `// verified` dates in `selectors.ts` when you re-map a selector; keep gotchas current.

## Memory Search (claude-mem)

**Auto-injected each session:** `MEMORY.md` (behavioral preferences) + recent session summaries. No querying needed for these.

**Active querying** (`mem-search` skill) adds value when you need to go further back than the session summaries, or find a specific past decision/bug not covered by them. Use before non-trivial planning, debugging, or implementing a system you haven't touched in several sessions.

Skip querying when: the session summaries already cover it, the task is trivial, or the codebase is the authoritative source.

**Memory hygiene:** Delete project-state memories when work is done. Only feedback/preference memories are permanent. See global CLAUDE.md for the full hygiene rules.

**Skills:** `mem-search` (past bugs/decisions), `knowledge-agent` (repeated broad questions in one session), `smart-explore` (code structure without reading full files), `timeline-report`
