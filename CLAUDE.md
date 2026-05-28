# HR Automation

UCPath HR automation for UCSD: Playwright-driven onboarding, separations, EID lookups, work-study updates, UKG report downloads, oath workflows, OCR review, and emergency contact fills.

## Before You Start

- Read only the local instruction file for the area being changed: `src/systems/<system>/CLAUDE.md`, `src/workflows/<workflow>/CLAUDE.md`, `src/dashboard/CLAUDE.md`, `src/tracker/CLAUDE.md`, or `src/core/CLAUDE.md`.
- Before selector work, search `src/systems/<system>/LESSONS.md` and run `npm run selector:search "<intent>"`.
- Before non-trivial planning/debugging, read root `LESSONS.md` and query claude-mem with `mem-search`.
- Use `docs/engineering/codebase-conventions.md` for shared architecture and naming rules; use `docs/README.md` to distinguish maintained docs from historical or ephemeral docs.

## Commands

```bash
npm run dashboard            # SSE backend (:3838) + Vite dev (:5173) — open http://localhost:5173
npm run dashboard:watch      # Same as `dashboard`, but tsx watch restarts the SSE backend process on src/ changes (full restart, not HMR)
npm run dashboard:prod       # Serve pre-built dashboard from SSE only

npm run onboarding:stop
npm run separation:stop
npm run work-study:stop
npm run emergency-contact:stop
npm run person-lookup:stop
npm run oath-signature:stop
npm run oath-upload:stop

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
npm run test                                       # Unit tests (dot reporter — live progress)
npm run test:verbose                               # Per-test lines (scoped debugging)
npm run test:watch                                 # Vitest in watch mode for iterative dev
npm run test:architecture                          # Static architecture/convention guards
npm run build:dashboard                            # Single-file dashboard build
```

Workflow starts are dashboard-only: upload run (`RunModal`) for PDF/file-backed workflows, input run (`InputRunPanel`) for typed IDs/names. Do not add `npm run <workflow>` launch scripts or revive YAML/batch-file starts. Runtime scripts use `tsx --env-file=.env`.

## Architecture

Layer order: `domain` → `infra` / `services` / `systems` → `core` → `control` / `workflows`; `tracker`, `dashboard`, `scripts`, and `utils` support those layers.

Every tracker row carries `data.archetype`. Queue rendering, log-panel labels, and display-name resolution all dispatch on this field plus `parentRunId`. **Scope** (root vs delegated) is `parentRunId`, not a separate archetype family. **Child presentation and wait gates** (e.g. OCR blocking approval until Person Lookup finishes) belong on the **parent workflow** (`runtimePolicy` + orchestrator), not on the child row type.

Stamped row shapes are `single`, `preview`, `batch`, and `batch-member`. `single` means one person/subject, not one daemon run. Multi-person input runs and approval/upload flows that fan out to people are `batch` surfaces with `batch-member` rows. Delegated rows carry `parentRunId`; scope is separate from shape.

OCR approval fan-out is form-spec driven: `OcrFormSpec.approveTo` lets `/api/ocr/approve-batch` enqueue downstream rows; omitting it means the owning workflow consumes approved OCR records itself.

## Codebase conventions

- No default exports in `src/`.
- No `page.locator(...)` inline in system files (architecture guard enforces this).
- Shared helpers used by 2+ workflows (or 1 workflow + tracker/dashboard/core/OCR) → promote out of `src/workflows/<workflow>/`. Shared homes listed in `src/workflows/CLAUDE.md`.
- Use `log.*` with structured fields; no ad hoc `console.*`, toasts, or Telegram messages.

## Best Practices

- **Selectors:** `npm run selector:search "<intent>"` first. New selector: map via `playwright-cli` → add JSDoc + `// verified <date>` to `selectors.ts` → `npm run selectors:catalog`. Full workflow: `src/systems/CLAUDE.md`.
- **New workflow:** `src/workflows/CLAUDE.md` (example, archetypes, daemon template). Kernel API: `src/core/CLAUDE.md`.
- **Before commits:** `npm run test` + `npm run test:architecture` (architecture guards run here).
- **After changes — CLAUDE.md:** update after every non-trivial fix, new pattern, or gotcha; merge/replace stale entries, don't layer duplicates.
- **After changes:** update only the nearest relevant `CLAUDE.md` when a non-obvious pattern, gotcha, or contract changes; merge stale lessons instead of adding duplicates.

## Environment

Copy `.env.example` → `.env` and set:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password
- `TIMEKEEPER_NAME` — operator timekeeper name for Kuali separation timekeeper fills (required; `src/config.ts` throws at startup if unset)

Duo MFA is manual — the automation pauses and polls until you approve on your phone.

## Configuration

`src/config.ts` centralizes URLs, PATHS (user-agnostic via `homedir()`), TIMEOUTS, SCREEN dimensions, and ANNUAL_DATES (update each fiscal year). Workflow-specific configs in `src/workflows/*/config.ts` re-export or narrow.

## Dashboard

`npm run dashboard` starts SSE backend (`:3838`) + Vite frontend (`:5173`). Workflow starts are centralized here: upload runs use `RunModal` / `RUN_MODAL_REGISTRY`, and typed input runs use `InputRunPanel` / `INPUT_RUN_REGISTRY`.

Workflows emit JSONL to `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`; SSE server streams to React SPA. All UI metadata (label, steps, detailFields) comes from the server-side kernel registry.

**Row lifecycle debug logs:** `.tracker/debug/row-lifecycle-{YYYY-MM-DD}.{jsonl,json}` — regenerated every 60s; full per-row status/surface/cause history. Useful when diagnosing surface mis-classification or stuck retries. See `src/tracker/CLAUDE.md`.

## Docs

What’s canonical vs ephemeral: `docs/README.md`. Full reference docs in `docs/engineering/`. Workflow behavior and delegation docs live in `docs/workflow/`. Session handoffs/plans in `docs/superpowers/` (ephemeral). Frozen snapshots in `docs/historical/`.

## Memory Search (claude-mem)

`MEMORY.md` and recent session summaries are auto-injected — no action needed. Use `mem-search` skill to go further back or find specific past decisions before non-trivial planning or debugging.

**Memory hygiene:** Delete project-state memories when work is done. Only feedback/preference memories are permanent.
