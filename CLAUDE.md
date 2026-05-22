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
# Onboarding (daemon mode by default)
npm run onboarding <email> [<email> ...]     # Enqueue each email as a separate queue item; daemon processes one at a time. Use `-p N` to spawn N daemons for parallel fan-out.
npm run onboarding:stop                      # Soft-stop all daemons

# Separations (daemon mode by default)
npm run separation <docId> [docId ...] # Enqueue to an alive daemon or spawn one
npm run separation:stop                # Soft-stop all daemons (drain in-flight)

# Kronos Reports
npm run kronos                         # Download Time Detail PDFs (kernel pool mode, default 4 workers — edit DEFAULT_WORKERS in config.ts to change)

# Work Study (daemon mode by default)
npm run work-study <emplId> <date>     # Enqueue to an alive daemon or spawn one
npm run work-study:stop                # Soft-stop all daemons

# Emergency Contact (daemon mode by default)
npm run emergency-contact <batchYaml>      # Load YAML → preflight → enqueue each record to an alive daemon
npm run emergency-contact:stop             # Soft-stop all daemons
# Flags: --roster-url "<sp-url>" | --roster-path <xlsx> | --ignore-roster-mismatch | -p <N> | -n

# EID Lookup (daemon mode by default)
npm run eid-lookup "Last, First Middle"    # Enqueue to an alive daemon or spawn one (CRM-on variant)
npm run eid-lookup:stop                    # Soft-stop all daemons

# Active Check (daemon mode by default)
npm run active-check "Last, First Middle"  # Check UCPath Person Org Summary active status by name
npm run active-check 10873698               # Same check by EID (8-digit)
npm run active-check:stop                   # Soft-stop all daemons

# Oath Signature (daemon mode by default)
npm run oath-signature <emplId> [emplId ...]     # Enqueue to an alive daemon or spawn one (UCPath only)
npm run oath-signature:stop                      # Soft-stop all daemons

# Oath Upload (daemon mode by default)
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

All runtime scripts use `tsx --env-file=.env`. Fallback if `npm run` is blocked: `./node_modules/.bin/tsx --env-file=.env src/cli.ts <command>`; if tsx binary is blocked: `node --import tsx/esm --env-file=.env src/cli.ts <command>`.

## Architecture

Layers: `src/domain/` (business concepts) → `src/infra/` (runtime infra) → `src/services/` (reusable IO) → `src/systems/` (per-system Playwright drivers) → `src/core/` (workflow kernel + daemon + SQLite) → `src/control/` (operator actions) → `src/workflows/` (composed workflows). `src/tracker/`, `src/dashboard/`, `src/scripts/`, `src/utils/` are support areas.

Full walkthrough: `docs/engineering/architecture-deep-dive.md`. File-by-file kernel/daemon listing: `docs/engineering/core-internals.md`.

Observability: `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` + `*-logs.jsonl`, streamed to the dashboard. Debug lifecycle artifacts at `.tracker/debug/`.

## Where to Find Things

| Need | Location | Method |
|---|---|---|
| Playwright selector for UI element | `src/systems/<system>/selectors.ts` | Use `npm run selector:search "intent"` first; never guess |
| Lessons from past selector failures | `src/systems/<system>/LESSONS.md` | Search first; update/merge stale or contradictory entries before adding new ones |
| Workflow implementation example | `src/workflows/work-study/` or `src/workflows/onboarding/` | Reference minimal (work-study) or complex (onboarding) example |
| Selector registry, intelligence artifacts, playwright-cli guide | `src/systems/CLAUDE.md` | All systems' selectors.ts layout, SELECTORS.md, LESSONS.md, selector discovery workflow |
| New workflow guide + archetype glossary | `src/workflows/CLAUDE.md` | Writing a new workflow, archetypes, daemon conversion template |
| Kernel API (defineWorkflow, Ctx, etc.) | `src/core/CLAUDE.md` | User-facing primer, Ctx methods, run modes, dupe-protection |
| Daemon mode (queues, health checks, etc.) | `src/core/CLAUDE.md` | Queue mechanics, flags, daemon conversion guide |
| Workflow control actions & ops handlers | `src/control/CLAUDE.md` | Operator cancel/retry/delete/bump dispatch, low-level handlers, OCR discard |
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

- **Selectors:** `npm run selector:search "<intent>"` first. New selector: map via `playwright-cli` → add JSDoc + `// verified <date>` to `selectors.ts` → `npm run selectors:catalog`. Full workflow: `src/systems/CLAUDE.md`.
- **New workflow:** `src/workflows/CLAUDE.md` (example, archetypes, daemon template). Kernel API: `src/core/CLAUDE.md`.
- **Before commits:** `npm run test` + `npm run test:architecture` (architecture guards run here).
- **After changes — CLAUDE.md:** update after every non-trivial fix, new pattern, or gotcha; merge/replace stale entries, don't layer duplicates.
- **After changes — docs/engineering/:** update only when the reference material structurally changes — new endpoint added/removed, new module file, changed API signature, removed feature. Not needed for every implementation change.

## Environment

Copy `.env.example` → `.env` and set:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password
- `TIMEKEEPER_NAME` — operator timekeeper name for Kuali separation timekeeper fills (required; `src/config.ts` throws at startup if unset)

Duo MFA is manual — the automation pauses and polls until you approve on your phone.

## Configuration

`src/config.ts` centralizes URLs, PATHS (user-agnostic via `homedir()`), TIMEOUTS, SCREEN dimensions, and ANNUAL_DATES (update each fiscal year). Workflow-specific configs in `src/workflows/*/config.ts` re-export or narrow.

## Dashboard

`npm run dashboard` starts SSE backend (`:3838`) + Vite frontend (`:5173`). Observation-only: workflows launched via npm scripts, dashboard displays live queue and logs.

Workflows emit JSONL to `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`; SSE server streams to React SPA. All UI metadata (label, steps, detailFields) comes from server-side kernel registry — no frontend edits needed when adding workflows.

**Row lifecycle debug logs:** `.tracker/debug/row-lifecycle-{YYYY-MM-DD}.{jsonl,json}` — regenerated every 60s; full per-row status/surface/cause history. Useful when diagnosing surface mis-classification or stuck retries. See `src/tracker/CLAUDE.md`.

**Details:** `src/dashboard/CLAUDE.md` (frontend), `src/tracker/CLAUDE.md` (backend).

## Docs

What’s canonical vs ephemeral: `docs/README.md`. Full reference docs in `docs/engineering/`. Session handoffs/plans in `docs/superpowers/` (ephemeral). Frozen snapshots in `docs/historical/`.

## Memory Search (claude-mem)

`MEMORY.md` and recent session summaries are auto-injected — no action needed. Use `mem-search` skill to go further back or find specific past decisions before non-trivial planning or debugging.

**Memory hygiene:** Delete project-state memories when work is done. Only feedback/preference memories are permanent. See global CLAUDE.md for the full hygiene rules.

**Skills:** `mem-search` (past bugs/decisions), `knowledge-agent` (repeated broad questions in one session), `smart-explore` (code structure without reading full files), `timeline-report`
