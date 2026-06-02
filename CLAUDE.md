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

A queue row has **three orthogonal axes**: **shape** (`single|preview|batch`, on `data.archetype`), **scope** (root vs delegated, `parentRunId`), and **kind** (`person|file|catalog`, on `data.queueRowKind`). Kind drives **only** the row's **title + subtitle** (resolved by `resolveQueueRowPresentation` in `src/domain/queue-row-presentation.ts`) — never footer buttons, layout, grouping, or status chips. Workflows declare `inputSubject` (`name|eid|email|kualiId|pdf|selector`, a literal or a resolver `(input) => subject`); the kernel **derives** `queueRowKind` from it (`name|eid|email|kualiId→person`, `pdf→file`, `selector→catalog`) and stamps it at pre-emit. Title by kind: person → resolved name (pending: typed name/EID), file → PDF filename, catalog → registry/spec label; a **person batch anchor has no title** (the count badge + member-name preview identify it). Subtitle rule: **EID if present, else the trace id.** Pending→resolved phase is derived at projection time from data presence, not stamped.

**Trace id** (`data.__traceId`, `src/domain/queue-trace-id.ts`): `<code>-<HHMMSS>-<runId4>` e.g. `ou-143012-a3f1`. `code` = the workflow's 2-char `defineWorkflow` code; `HHMMSS` = local time-of-day of the run start (date omitted — tracker files are already date-partitioned); `runId4` = first 4 UUID chars (log-greppable). Stamped once at pre-emit; displayed truncated with the full value in the hover `title`. **No session-local ordinals in titles** — `OATH 1`, `<label> · #1234`, `Onboarding Roster 2` are retired; disambiguation comes from the footer's time + `#run`. Daemon session-panel instances stay numbered internally for start/end pairing, but the session-card **title always drops the trailing ordinal** (every instance, not just a lone ` 1` — `WorkflowBox.displayInstance` strips `\s\d+$`). The session card's **subtitle is the running run's trace id** (`currentTraceId`, threaded from the `item_start` session event via `findFrozenTraceId`, identical to that run's queue-row subtitle); it's kept after the item completes and falls back to the phase text (e.g. "Authenticating 1/2") for a daemon with no run yet. Cards disambiguate by subtitle + elapsed timer, not a title number.

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

Workflows emit JSONL to `.tracker/rows/{workflow}-{YYYY-MM-DD}.jsonl` (logs to `.tracker/logs/`, sessions to `.tracker/sessions/`); SSE server streams to React SPA. `.tracker/` is split into typed subdirs — `src/tracker/paths.ts` owns all path construction (see `src/tracker/CLAUDE.md`). All UI metadata (label, steps, detailFields) comes from the server-side kernel registry.

**Row lifecycle debug logs:** `.tracker/debug/row-lifecycle-{YYYY-MM-DD}.{jsonl,json}` — regenerated every 60s; full per-row status/surface/cause history. Useful when diagnosing surface mis-classification or stuck retries. See `src/tracker/CLAUDE.md`.

## Docs

What’s canonical vs ephemeral: `docs/README.md`. Full reference docs in `docs/engineering/`. Workflow behavior and delegation docs live in `docs/workflow/`. Session handoffs/plans in `docs/superpowers/` (ephemeral). Frozen snapshots in `docs/historical/`.

## Memory Search (claude-mem)

`MEMORY.md` and recent session summaries are auto-injected — no action needed. Use `mem-search` skill to go further back or find specific past decisions before non-trivial planning or debugging.

**Memory hygiene:** Delete project-state memories when work is done. Only feedback/preference memories are permanent.
