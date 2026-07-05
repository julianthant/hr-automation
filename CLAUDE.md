# HR Automation

UCPath HR automation for UCSD: Playwright-driven onboarding, separations, Person Lookup, work-study updates, UKG report downloads, oath workflows, OCR review, and emergency contact fills.

## Before You Start

- Read only the local instruction file for the area being changed: `src/systems/<system>/CLAUDE.md`, `src/workflows/<workflow>/CLAUDE.md`, `src/dashboard/CLAUDE.md`, `src/tracker/CLAUDE.md`, or `src/core/CLAUDE.md`.
- Before selector work, search `src/systems/<system>/LESSONS.md` and run `npm run selector:search "<intent>"`.
- Before non-trivial planning/debugging, read root `LESSONS.md`.
- Use `docs/engineering/codebase-conventions.md` for shared architecture and naming rules; use `docs/README.md` to distinguish maintained docs from historical or ephemeral docs.

## Commands

```bash
npm run dashboard            # SSE backend (:3838) + Vite dev (:5173) — open http://localhost:5173
npm run dashboard:watch      # Same as `dashboard`, but tsx watch restarts the SSE backend process on src/ changes (full restart, not HMR)
npm run dashboard:prod       # Serve pre-built dashboard from SSE only

npm run onboarding:stop
npm run separation:stop
npm run work-study:stop
npm run kronos-pay-rule:stop
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

Stamped row shapes are `single`, `preview`, `operation`, and `operation-member`. `single` means one person/subject, not one daemon run. Multi-person input runs and approval/upload flows that fan out to people are `operation` surfaces with `operation-member` rows — the fanned-out signer/contact rows under an `operation` coordinator (see below). The member shape rides the `rowShape` runtime option (`operation-member`, normalized in `workflow-tracker-data.ts`) so it survives the SQLite task store to the daemon re-emit, and projects to `single` surface type when rendered. **The legacy `batch` / `batch-member` shapes were retired 2026-06-30 → `operation` / `operation-member`; they are no longer stampable — old JSONL rows still on disk normalize on read via `resolveRowArchetype` (`batch → operation`, `batch-member → operation-member`).** Delegated rows carry `parentRunId`; scope is separate from shape.

**`operation`** is a top-level coordinator row for an OCR-backed target workflow (oath-signature / emergency-contact / onbase), created at PDF-upload time in the target workflow's own panel. The OCR run is delegated under it (`parentRunId`), so the OCR review row stays the one real row in the OCR panel — never duplicated. Before approval the operation row denormalizes the OCR status (`data.ocrStatus`/`data.ocrStep`/`data.ocrRunId`/`data.ocrSessionId`) and renders the status *label* (the other `ocr*` fields back routing + the link, not the display) plus an "Open OCR review" link that switches to the OCR panel, selects the review row, and opens its Preview tab; after approval its fanned-out signer/contact children (stamped `operation-member` and parented to it) render as inline expandable member rows under that coordinator, not a separate operation drill-in queue page. The OCR approve fan-out stamps `operation-member` only when the run belongs to an operation coordinator (`isOperationCoordinatorWorkflow(operationWorkflow)` — oath-signature / emergency-contact / onbase); a standalone OCR run keeps the natural archetype. It is a **display** row with no daemon task of its own (stamped explicitly at `/api/ocr/prepare`, NOT a `WorkflowArchetype`/`deriveRowArchetype` output). Oath Upload is deliberately **not** an operation row — it is a real daemon `single` task born at upload (option A) that walks `OCR prep → awaiting approval → wait signatures → submit` as one row; see `src/workflows/oath-upload/CLAUDE.md`.

A queue row has **three orthogonal axes**: **shape** (`single|preview|operation`, on `data.archetype`), **scope** (root vs delegated, `parentRunId`), and **kind** (`person|file|catalog`, on `data.queueRowKind`). Kind drives **only** the row's **title + subtitle** (resolved by `resolveQueueRowPresentation` in `src/domain/queue-row-presentation.ts`) — never footer buttons, layout, grouping, or status chips. Workflows declare `inputSubject` (`name|eid|email|kualiId|pdf|selector`, a literal or a resolver `(input) => subject`); the kernel **derives** `queueRowKind` from it (`name|eid|email|kualiId→person`, `pdf→file`, `selector→catalog`) and stamps it at pre-emit. Title by kind: person → resolved name (pending: typed name/EID), file → PDF filename, catalog → registry/spec label; a **person operation anchor has no title** (the count badge + member-name preview identify it). Subtitle rule: **EID if present, else the trace id.** Pending→resolved phase is derived at projection time from data presence, not stamped.

**Trace id** (`data.__traceId`, `src/domain/queue-trace-id.ts`): `<code>-<HHMMSS>-<runId4>` e.g. `ou-143012-a3f1`. `code` = the workflow's 2-char `defineWorkflow` code; `HHMMSS` = local time-of-day of the run start (date omitted — tracker files are already date-partitioned); `runId4` = first 4 UUID chars (log-greppable). Stamped once at pre-emit; displayed truncated with the full value in the hover `title`. **No session-local ordinals in titles** — `OATH 1`, `<label> · #1234`, `Onboarding Roster 2` are retired; disambiguation comes from the footer's time + `#run`. Daemon session-panel instances stay numbered internally for start/end pairing, but the session-card **title always drops the trailing ordinal** (every instance, not just a lone ` 1` — `WorkflowBox.displayInstance` strips `\s\d+$`). The session card's **subtitle is the running run's trace id** (`currentTraceId`, threaded from the `item_start` session event via `findFrozenTraceId`, identical to that run's queue-row subtitle); it's kept after the item completes and falls back to the phase text (e.g. "Authenticating 1/2") for a daemon with no run yet. Cards disambiguate by subtitle + elapsed timer, not a title number.

OCR approval fan-out is form-spec driven: `OcrFormSpec.approveTo` lets `/api/ocr/approve-batch` enqueue downstream rows; omitting it means the owning workflow consumes approved OCR records itself. The fan-out is additionally routed by **operation intent** (`data.operationWorkflow` on the OCR row, set from the run modal's `targetWorkflow`): an `oath-signature` PDF run signs oaths only (no ServiceNow ticket), an `oath-upload` full run skips the once-per-document ticket fan-out because its born-at-upload task files the ticket itself, and a **standalone OCR run has no approve flow at all** — approval ≡ delegation; the route rejects it loud (legacy both-targets fan-out removed 2026-06-11). Fanned-out children parent to the operation/coordinator run (`childParentRunId = parentRunId`).

## Codebase conventions

- No default exports in `src/`.
- No `page.locator(...)` inline in system files (architecture guard enforces this).
- Shared helpers used by 2+ workflows (or 1 workflow + tracker/dashboard/core/OCR) → promote out of `src/workflows/<workflow>/`. Shared homes listed in `src/workflows/CLAUDE.md`.
- Use `log.*` with structured fields; no ad hoc `console.*` or toasts.
- **No unverified silent fallbacks — fail loud.** See the section below; this is a correctness rule, not a style preference.

## Fail loud — no unverified silent fallbacks

**This is a single-operator tool that submits REAL HR transactions. Correctness beats graceful degradation every time.** A fallback that silently substitutes a plausible-but-wrong value when something fails is the single most dangerous pattern in this codebase — it hides the failure and can push wrong data (wrong pay rate, wrong person, wrong department, a blank/duplicate document, a false "submitted") into a live UCPath / Kuali / Kronos / OnBase / i9 transaction, or mislead the operator into acting on a lie. When it fails silently, we never find out; when it fails loud, we fix it.

**The rule:** when an operation fails or an expected value is missing, do **NOT** substitute a default, an alternative selector/element, a cached-or-"latest" value, a fabricated constant, a "safe" guess, or a swallowed-error return and then continue as if nothing happened. **Throw with a legible message that names the offending value/EID/field**, so the error surfaces and gets corrected at the source. This generalizes the UCPath "No cross-source auto-fallbacks" rule (`src/systems/ucpath/CLAUDE.md`, 2026-04-23 — *"fail loudly with a clear error so upstream data gets corrected at the source"*) to the **entire** codebase.

**A fallback is only acceptable when BOTH hold:**
1. The fallback path is itself **verified correct** for the exact case it handles (live-verified for selectors/page state; test-pinned for pure logic) — and its verification is noted (a `// verified <date>` comment, a lesson, or a test), AND
2. Absence/the fallback case is a **genuinely valid, expected state** (e.g. "no search results" is a real outcome; a documented default that is provably right).

If you can't satisfy both, **fail loud** — do not add the fallback. When in doubt, throw.

**Not a fallback (these are fine):** retrying the *same* operation on a transient error (Playwright timeout, auth flake) via `loginWithRetry` / `ctx.retry` — that re-runs the operation, it doesn't substitute data. Swallowing an error is fine only when the *action itself* is genuinely optional (`clickIfPresent` on a truly-optional dismiss) AND the caller does not treat the result as load-bearing.

**When you catch, don't swallow:** a `catch` that returns a default/empty/`{}`/`null`/`0`/`true` and lets execution continue must instead re-throw (or at minimum `log.warn` AND propagate a distinguishable "unknown" the caller checks) — never let "the check failed" become indistinguishable from "the check passed / found nothing." `catch { won = true }`, `catch { return [] }`, `JSON.parse(...) catch { return {} }`, `.catch(() => ({ match: true }))`, and `?? "SDCMP"` / `?? "queued"` on corrupted input are all bugs, not resilience.

## Best Practices

- **Selectors:** `npm run selector:search "<intent>"` first. New selector: map via `playwright-cli` → add JSDoc + `// verified <date>` to `selectors.ts` → `npm run selectors:catalog`. Full workflow: `src/systems/CLAUDE.md`.
- **New workflow:** `src/workflows/CLAUDE.md` (example, archetypes, daemon template). Kernel API: `src/core/CLAUDE.md`.
- **Before commits:** `npm run test` + `npm run test:architecture` (architecture guards run here).
- **After changes — CLAUDE.md:** update after every non-trivial fix, new pattern, or gotcha; merge/replace stale entries, don't layer duplicates.
- **After changes:** update only the nearest relevant `CLAUDE.md` when a non-obvious pattern, gotcha, or contract changes; merge stale lessons instead of adding duplicates.
- **Lessons (add vs. audit):** record a new gotcha with the `custom-hr-lesson` skill (it self-dedupes against neighbors before appending). Periodically GC the lesson stores with the `custom-hr-lesson-audit` skill (`.claude/skills/custom-hr-lesson-audit/`) — it sweeps every `LESSONS.md` + `CLAUDE.md` "Lessons Learned" section to remove duplicate/superseded/dead-reference lessons and verify each remaining lesson still maps to real code. Lessons are maintained, not append-only.

## Live verification — standing pre-authorization (always available, never ask)

**The live environment is always available, and reaching it for verification is pre-authorized. Never ask the user whether live access is up, whether to spend the live session, or to confirm a Duo prompt — assume yes and proceed.** This covers the whole range: a read-only selector `snapshot`, a `test-login` smoke check, a `tests/live/` collector, and a **full live workflow dry-run** (real UCPath / CRM / Kuali / ServiceNow / i9). Duo is cleared hands-off by Duo Autopilot on every verification/test path (`npm run sel:browser`, `tests/live/`, the e2e live lane), so there is no phone-approval step to wait on and nothing for the user to sign off. The safety boundary for live *workflow* runs is `dryRun=true` (no UCPath transaction, no Kuali finalization) — that, not gated access, is what keeps a live run safe. If a single live system is genuinely down, skip that system and proceed with the rest; don't treat one outage as "the live env is unavailable." (No standing outages — all systems, including i9, are currently up.)

Mapping or verifying a selector is **pre-approved** — do it whenever a fix, a selector edit, or any debugging needs it, and **never pause to ask**. A `snapshot` is a read-only view of a page; treat it like running a test, not like an action that needs sign-off.

`playwright-cli` runs **headless by default** — no display, no window steal, no permission prompt. `--headed` is opt-in only when *you* genuinely need to watch the page. So the autonomous loop is just: open headless → `snapshot` → read the ref IDs → confirm or repair the locator in `selectors.ts`. Use the `custom-hr-selector-map` skill for the full find→add→catalog loop; this section is only about *how to reach a live page headless without asking*.

**Public / login pages (no auth):** open straight away.

```bash
playwright-cli -s=sel open "<url>"               # headless — just omit --headed
playwright-cli -s=sel snapshot                   # accessibility tree + ref IDs
playwright-cli --raw snapshot > /tmp/snap.yml    # grep-friendly dump for big pages
playwright-cli -s=sel close
```

**Auth-gated pages (UCPath/PeopleSoft, CRM, Kuali, ServiceNow, I9, …) — use Duo Autopilot:** the `duo-autopilot/` extension answers the Duo MFA WebAuthn ceremony itself (no phone, no headed step), so an auth-gated login runs unattended. `npm run sel:browser` opens a headless `playwright-cli` session named `sel` with the extension loaded and self-armed from its packaged credential. The extension only clears **Duo** — you still fill the SSO username/password (from `.env`: `UCPATH_USER_ID` / `UCPATH_PASSWORD`).

```bash
playwright-cli install-browser chromium          # one-time: full Chromium (needed for --load-extension)
npm run sel:browser -- "<login-url>"             # headless session 'sel', extension loaded
playwright-cli -s=sel fill "<user-field>" "$UCPATH_USER_ID"
playwright-cli -s=sel fill "<pass-field>" "$UCPATH_PASSWORD" --submit
# …Duo Autopilot clears the MFA prompt automatically…
playwright-cli -s=sel goto "<deep-url>" && playwright-cli -s=sel snapshot
playwright-cli -s=sel close
```

How it works (verified 2026-06-24): the launcher writes a gitignored `.playwright/duo-autopilot.config.json` that loads the extension via `--load-extension` under Playwright's **full** bundled Chromium (`channel: chromium`, new headless — the lightweight `headless-shell` can't run extensions, and Google Chrome stable disabled `--load-extension` in 2024). The extension's service worker auto-imports `duo-autopilot/credentials/duo-webauthn.json` into storage on startup (no Options UI). See `duo-autopilot/README.md`. The one thing this can't do unattended is a brand-new credential enrollment — that's a one-time setup with the user.

**Fallback (no extension set up):** log in **once** headed (approve Duo that single time), `state-save .auth/<system>.json`, then `state-load` + open headless thereafter. `.auth/` is gitignored (never commit auth state). The saved state dies when the PeopleSoft/CRM session times out — re-save if a snapshot comes back at the login page.

**Always** `close` the session when done and sweep orphans (`playwright-cli list` → `playwright-cli close-all`) — these are real Chromium processes, not the user's Chrome. UCPath content lives inside the `#main_target_win0` iframe (`getContentFrame`, modal-mask timing, HR-Tasks-overlay) — those gotchas are in the `custom-hr-selector-map` skill. After verifying: bump the selector's `// verified YYYY-MM-DD` in `selectors.ts` and run `npm run selectors:catalog`.

## Environment

Copy `.env.example` → `.env` and set:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password
- `TIMEKEEPER_NAME` — operator timekeeper name for Kuali separation timekeeper fills (required; `src/config.ts` throws at startup if unset)

Duo MFA for **production operator runs** (workflows launched from the dashboard for real submission) is manual — the automation pauses and polls until you approve on your phone. **Verification and test runs are different:** selector snapshots, `tests/live/`, and live dry-runs clear Duo hands-off via Duo Autopilot — see "Live verification — standing pre-authorization" above. Never ask the user to confirm live access for verification work; assume it is always available.

## Configuration

`src/config.ts` centralizes URLs, PATHS (user-agnostic via `homedir()`), TIMEOUTS, SCREEN dimensions, and ANNUAL_DATES (update each fiscal year). Workflow-specific configs in `src/workflows/*/config.ts` re-export or narrow.

## Dashboard

`npm run dashboard` starts SSE backend (`:3838`) + Vite frontend (`:5173`). Workflow starts are centralized here: upload runs use `RunModal` / `RUN_MODAL_REGISTRY`, and typed input runs use `InputRunPanel` / `INPUT_RUN_REGISTRY`.

Workflows emit JSONL to `.tracker/rows/{workflow}-{YYYY-MM-DD}.jsonl` (logs to `.tracker/logs/`, sessions to `.tracker/sessions/`); SSE server streams to React SPA. `.tracker/` is split into typed subdirs — `src/tracker/paths.ts` owns all path construction (see `src/tracker/CLAUDE.md`). All UI metadata (label, steps, detailFields) comes from the server-side kernel registry.

Workflow rail badges are backend-authoritative: React consumes SSE `wfCounts` as-is via `buildWorkflowRailEntryCounts`; do not override the active workflow count from QueuePanel state. Backend `wfCounts` must use the same top-level queue-surface model as the rail, including delegated batch collapse and OCR prep rows that still render in the queue.

**Row lifecycle debug logs:** `.tracker/debug/row-lifecycle-{YYYY-MM-DD}.{jsonl,json}` — regenerated every 60s; full per-row status/surface/cause history. Useful when diagnosing surface mis-classification or stuck retries. See `src/tracker/CLAUDE.md`.

**Settings overlay** (`components/settings/`, navbar gear → centered Dialog) has two kinds of section. **Editable** (persists a SPARSE override): General (operator identity, annual/fiscal dates), Display, **System URLs** (per-system entry URLs — empty = production default, set to target a test instance), Performance (nav retries, timeouts incl. UKG/Duo/retry, OCR concurrency + backoff + validation retries, default workers), **Audit capture** (capture geometry), **Recovery & daemon** (browser-health refresh/reopen rungs + daemon idle/re-poll timing), Features, Paths; plus non-persisted Notifications + read-only `.env` Credentials. **Read-only reference** ("what exists in the system", a "Reference" nav group): **Row & queue model** (archetypes/shapes/kinds/input-subjects/statuses/trace-id), **Workflows & OCR** (the live workflow index — code/category/shape/systems/steps from `/api/workflow-definitions` — + OCR form specs/steps), **System reference** (browser-health verdicts + recovery ladder, daemon states, idle-refresh systems). Reference content is client-safe + drift-protected against the real domain unions (`src/domain/settings/reference.ts`); it renders no Save footer. The Workflow Editor still launches from the nav bottom into its full-page takeover. Editable values persist to `config/settings.json` (gitignored) via `/api/settings`; `src/config.ts` applies them at module load with precedence **env var > settings.json > code default** (empty file = today's behavior), and `applyOperatorSettingsToEnv` populates cross-module env knobs (OCR/capture/browser-health/daemon/concurrency) ONLY for operator-set fields. Backend store mirrors the workflow-presentation override pattern (`src/tracker/settings/`, shared type in `src/domain/settings/types.ts`). Architecture: `src/dashboard/CLAUDE.md` (2026-06-30 lesson).

**Workflow Modifier page** (`components/workflow-modifier/`) — an n8n-style `@xyflow/react` node-graph editor for shaping per-workflow presentation, now reached from the **Settings page → Workflow Editor** section (it was briefly a rail entry). **Dual output:** edits write the live config override (`config/workflow-presentation/<workflow>.json`, applies hot via `effectiveMetadata`) AND, via "Generate scaffold", a **design-intent scaffold** (`config/workflow-design/<workflow>.{json,md}`, git-tracked) capturing design intent beyond today's schema for a future session. The `<workflow>.md` brief is **generated — never hand-edit; edit the graph and re-generate.** Architecture + projections: `src/dashboard/CLAUDE.md` (2026-06-25 lesson).

## Verifying dashboard changes (headless, with `playwright-cli`)

**The dashboard has no component-render harness (jsdom/RTL) — by design** (it fights the "extract pure logic → unit-test that" pattern and is blind to layout/visual bugs). Instead, VERIFY your dashboard change by **seeding synthetic state into an isolated tracker dir, booting the REAL dashboard against it, and driving it headless with `playwright-cli`.** This is high-fidelity (real React + real CSS + real DOM) and needs no live daemon / Duo / browsers. It is the canonical "I actually saw it render" check — do this for every non-trivial dashboard change, don't just trust typecheck + build.

The loop (the session-panel fixture is the worked example; copy its shape for other surfaces):

```bash
# 1. SEED a synthetic fixture (real emitters → events; STAYS ALIVE so cards stay "live")
npx tsx scripts/seed-session-fixture.ts generated/.dashboard-preview/tracker &   # background
#    → covers every per-browser health state (healthy/refreshing/unhealthy/failed/paused) + a trail

# 2. BUILD + BOOT the dashboard against that dir (use --port if :3838 is busy)
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3939 &

# 3. DRIVE + assert with playwright-cli (accessibility tree is the authoritative proof)
playwright-cli -s=preview open http://localhost:3939
playwright-cli -s=preview snapshot            # grep the a11y tree for your expected text/labels/state
playwright-cli -s=preview screenshot --filename "$(pwd)/.screenshots/dashboard-preview/x.png"  # then Read the PNG
#    hover/click controls by [aria-label="..."]; the bottom "session" bar toggles the drawer

# 4. CLEAN UP (these are real processes — always sweep)
playwright-cli close-all
pkill -f seed-session-fixture; pkill -f 'dashboard --prod --port 3939'
```

Principles: `HRAUTO_TRACKER_DIR` points the dashboard (and the e2e stub lane) at an isolated root — NEVER seed into the real `.tracker/`. The session panel only shows a card whose `workflow_start.pid` is a LIVE process, which is why the seeder hangs (kill it when done). The seeder uses the **production emitters** (`emitBrowserHealth`, …) so the fixture can't drift from the event schema — extend it (or write a sibling seeder) when you add a surface. The a11y `snapshot` is more reliable to assert on than a screenshot (text/labels/`[pressed]`/aria); `Read` the PNG only for the visual gestalt. `:3838` is usually the user's own dashboard — use a fallback port and never kill it. Screenshots land in `.screenshots/` (gitignored). **ALWAYS surface the screenshots back to the user after a verification — `Read` the PNG(s) into your reply (they render inline in the conversation) and cite the saved `.screenshots/<area>/` path(s).** The user can't always re-run your verification, so showing the actual rendered result (not just asserting "it works") is mandatory: every dashboard/UI verification ends with the operator SEEING the before/after, the same images you judged from. What this CANNOT verify: behavior that needs a real browser daemon (refresh/reopen/peek *acting*, real auth) — that's the opt-in live lane (see "Live verification — standing pre-authorization" above + `tests/live/`).

## Docs

What’s canonical vs ephemeral: `docs/README.md`. Full reference docs in `docs/engineering/`. Workflow behavior and delegation docs live in `docs/workflow/`. Session handoffs/plans in `docs/superpowers/` (ephemeral). Frozen snapshots in `docs/historical/`.