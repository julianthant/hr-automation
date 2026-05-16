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
npm run extract <email>                      # Extract employee data from CRM only

# Separations (daemon mode by default — see "Daemon mode" below)
npm run separation <docId> [docId ...] # Enqueue to an alive daemon or spawn one
npm run separation:stop                # Soft-stop all daemons (drain in-flight)

# Kronos Reports
npm run kronos                         # Download Time Detail PDFs (4 workers, kernel pool mode)

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
npm run clean:tracker                              # Prune .tracker/*.jsonl older than 30 days (default)
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
      batch-helpers.ts, batch-lifecycle.ts, shared-context-pool.ts, run-one-item.ts
    daemon/            # Daemon mode: registry, queue, client, HTTP keepalive
      types.ts, registry.ts, queue.ts, client.ts, daemon.ts, http.ts,
      worker-store.ts, keepalive.ts, enqueue-dispatch.ts
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
| Kernel API (defineWorkflow, Ctx, etc.) | Root CLAUDE.md → **Kernel Primer** | Read before authoring new workflows |
| Dashboard internals & React components | `src/dashboard/CLAUDE.md` | SSE streams, queue rendering, detail panels |
| Tracker & JSONL observability patterns | `src/tracker/CLAUDE.md` | Emit patterns, Excel export, child-run delegation |
| Daemon mode (queues, health checks, etc.) | Root CLAUDE.md → **Daemon Mode** | Default for most CLI commands; use `-n` / `-p N` flags |
| System-specific gotchas | `src/systems/<system>/CLAUDE.md` | PeopleSoft quirks, frame navigation, auth edge cases |
| Shared primitives & anti-patterns | `src/domain/`, `src/services/`, `src/infra/` + `docs/engineering/codebase-conventions.md` | Names, operators, logs, matching, OCR, capture, auth/browser — use before adding workflow-local |
| Architecture guards & what they enforce | `npm run test:architecture` + test files in `tests/unit/` | No inline selectors, no default exports, lesson format, catalog sync |
| General cross-codebase lessons | `LESSONS.md` (project root) | Read before every non-trivial task |

## Codebase conventions

Read `docs/engineering/codebase-conventions.md` before adding shared behavior, new workflows, dashboard controls, or system drivers.

High-level rules:
- Workflow folders own orchestration, not reusable domain/system helpers.
- Shared behavior used by two workflows, or by one workflow plus tracker/dashboard/core/OCR, belongs outside `src/workflows/<workflow>/`.
- New workflows must declare `operatorSubject`, `detailFields`, `getName`, `getId`, and pending-row display data.
- Operator-facing text should use the shared subject (`data.__subject`) before raw ids/run ids/session ids.
- Use action-oriented function names: `parse`, `normalize`, `display/format`, `derive`, `resolve`, `build`, `create`, `read/write/list/find`, `is/has/can/should`, `ensure`, `assert`, `run`.
- Do not add default exports in `src/`.
- Use `log.*`, structured log fields, and notification policy instead of ad hoc `console.*`, toasts, or Telegram messages.

## Node 26 conventions

Floor: Node 26.0.0 (pinned via `engines` + `.nvmrc`). Prefer the Node 26 primitives below over older equivalents in new code. Do **not** codemod existing working code for aesthetic reasons — adopt these as files are touched.

| Use this | Instead of | When |
|---|---|---|
| `Promise.withResolvers()` | `let resolve, reject; const p = new Promise((r, j) => { resolve = r; reject = j; })` | Building deferred promises (event handlers, lazy gates) |
| `Array.fromAsync(asyncIter)` | `const out = []; for await (const x of iter) out.push(x); return out;` | Materializing an async iterable |
| Iterator helpers (`.map/.filter/.take/.drop/.flatMap`) | `[...iter].map(...)` / `Array.from(iter).filter(...)` | Streaming transforms where you don't need the full array materialized |
| `AbortSignal.timeout(ms)` | `const c = new AbortController(); setTimeout(() => c.abort(), ms);` | Fetch / cancellation timeouts |
| `AbortSignal.any([a, b])` | Manual `addEventListener("abort", ...)` chaining | Composing multiple signals |
| `node:timers/promises` `setTimeout(ms, value, { signal })` | Hand-rolled abortable sleep | Sleep that should reject on abort |
| `import.meta.dirname` | `fileURLToPath(import.meta.url)` + `dirname()` | `__dirname` equivalent in ESM |
| `styleText("red", s)` from `node:util` | `chalk.red(s)` / `pc.red(s)` | Colored CLI output |
| `node:sqlite` (via `src/infra/sqlite/` shim) | `better-sqlite3` | Any SQLite — project default |
| `Object.groupBy(iter, fn)` | Reduce-into-accumulator | Bucketing items by key |
| `node:util.parseArgs` | `commander` (for **new internal scripts only**) | Tiny scripts in `src/scripts/` that don't need commander's subcommand tree |

**Type-stripping note:** The codebase uses `tsx` for runtime TS execution. Native `node --strip-types` is intentionally NOT used because the codebase imports relative paths with `.js` extensions and Node 26's strip-types mode does not rewrite `.js` → `.ts`. Migrating to native execution would require rewriting every relative import — rejected for a marginal cold-start win. If `tsx` ever drops support, revisit then.

### Sandboxing (optional)

Node 26's permission model can sandbox daemon processes so a Playwright bug or rogue selector cannot write outside expected paths. Disabled by default — the threat model for an internal HR tool running on operator machines doesn't justify the operational cost (every new write path becomes an allowlist edit).

To enable for a specific deployment, launch daemons with:

```bash
node --permission \
  --allow-fs-read=* \
  --allow-fs-write=/Users/$USER/Documents/hr-automation/.tracker \
  --allow-fs-write=/Users/$USER/Documents/hr-automation/.screenshots \
  --allow-fs-write=/tmp \
  --allow-child-process \
  ./node_modules/.bin/tsx --env-file=.env src/cli-daemon.ts <workflow>
```

Required flags:
- `--allow-fs-read=*` — Playwright reads from many paths (Chromium binaries, user-data-dir, system fonts).
- `--allow-fs-write=<tracker dir>` — JSONL emissions, SQLite state DB, screenshot uploads.
- `--allow-fs-write=<screenshots dir>` — debug screenshots written by `Stepper.step` on failure.
- `--allow-fs-write=/tmp` — Playwright + Chromium temp files.
- `--allow-child-process` — Playwright spawns Chromium.

Network access does not need a flag (allowed by default in the permission model).

## Shared workflow primitives

Any helper used by two or more workflows, or by one workflow plus tracker/dashboard/core/OCR, belongs outside `src/workflows/<workflow>/`.

Use these shared homes first:
- `src/domain/identity/` for person names and EIDs.
- `src/domain/operator-subject.ts` for queue/toast/Telegram/log labels.
- `src/domain/log-events.ts` and `src/domain/notifications/` for structured logs and notification routing.
- `src/core/task-display.ts` and `src/core/task-control.ts` for delegation display and control vocabulary.
- `src/services/ocr/forms/` for OCR form specs and shared verification schemas.
- `src/services/matching/` for roster loading plus name/address/EID matching.
- `src/systems/ucpath/person-org-summary.ts` for UCPath Person Org Summary search.
- `src/domain/hdh/departments.ts` for HDH department acceptance.

Workflow folders own orchestration and workflow-specific business steps only. When fixing a bug, decide whether it belongs to the shared primitive or to the workflow-specific handler before adding a new helper.

## Best Practices

**Selectors:** Always use `npm run selector:search "<intent>"` before mapping a new selector. If a match exists, USE IT — don't remap. If not found, map via `playwright-cli snapshot`, add JSDoc + `// verified <date>` in `selectors.ts`, run `npm run selectors:catalog`, then append a lesson to `LESSONS.md` if you hit something non-obvious.

**Shared code:** If a function is used by 2+ workflows (or 1 workflow + tracker/dashboard/core/OCR), it belongs outside `src/workflows/`. Check the **Shared workflow primitives** section above before adding a new helper. Avoid duplication; prefer moving to `src/domain/` or `src/core/`.

**Architecture guards:** Run `npm run test:architecture` before commits. It enforces: no inline selectors in system files, no default exports in `src/`, lesson format correctness, and selector catalog sync. These gates catch drift early.

**Continuous improvement:** After every selector re-map, system change, or discovered pattern: update the relevant CLAUDE.md with a dated lesson-learned entry. These files are the only memory between sessions — keep them accurate.

**Daemon mode:** Most CLI commands default to daemon mode (persistent long-lived processes, Duo auth once per session). Use `-n, --new` to spawn an additional daemon; `-p, --parallel <N>` to ensure N are alive. Always drain gracefully with `:stop` before force-killing.

**Testing:** Run `npm run test` + `npm run test:architecture` before PRs. Architecture guards are non-negotiable; they prevent anti-patterns from creeping in.

## Writing a new workflow

Declare it with `defineWorkflow`. The kernel handles browser launch, auth (Duo-aware, sequential or interleaved), tracker emissions, SIGINT cleanup, screenshotting on step failure, per-item `withTrackedWorkflow` wrapping in batch/pool modes, and the dashboard registry. Your handler just drives Playwright.

Minimal example:

```ts
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { MyInputSchema, type MyInput } from "./schema.js";

const steps = ["ucpath-auth", "transaction"] as const;

export const myWorkflow = defineWorkflow({
  name: "my-workflow",
  label: "My Workflow",
  systems: [{
    id: "ucpath",
    login: async (page) => {
      const ok = await loginToUCPath(page);
      if (!ok) throw new Error("UCPath authentication failed");
    },
  }],
  steps,
  schema: MyInputSchema,
  tiling: "single",
  authChain: "sequential",
  detailFields: [{ key: "emplId", label: "Empl ID" }, { key: "name", label: "Employee" }],
  getName: (d) => d.name ?? "",
  getId: (d) => d.emplId ?? "",
  operatorSubject: (d) => buildOperatorSubject({ kind: "eid", value: d.emplId, prefix: "My Workflow" }),
  handler: async (ctx, input: MyInput) => {
    ctx.updateData({ emplId: input.emplId });
    ctx.markStep("ucpath-auth");
    const page = await ctx.page("ucpath");
    await ctx.step("transaction", async () => {
      // ... Playwright work ...
      ctx.updateData({ name: "Jane Doe" });
    });
  },
});

export async function runMyWorkflow(input: MyInput) {
  await runWorkflow(myWorkflow, input);
}
```

Add a Commander subcommand in `src/cli.ts`, add npm scripts to `package.json`, fill in the schema + handler, and that's the whole story — no dashboard registry edits needed. (The `npm run new:workflow` scaffolder was removed; scaffold manually from the minimal example above.)

See `src/workflows/work-study/` for a clean one-system example, `src/workflows/emergency-contact/` for batch-mode with `preEmitPending`, `src/workflows/onboarding/` for multi-system sequential auth + pool-mode parallel, `src/workflows/old-kronos-reports/` for pool-mode with per-worker sessionDir injection, and `src/workflows/eid-lookup/` for `shared-context-pool` mode (N per-item tabs fanning out from a single Duo auth per system).

All production workflows are kernel-based as of 2026-04-17. New workflows must follow the kernel path exclusively.

## Kernel Essentials

**Full API reference:** See `src/core/CLAUDE.md` (defineWorkflow shape, Ctx methods, run modes, dupe-protection patterns).

**Quick reference:**
- `defineWorkflow({ name, systems, steps, schema, operatorSubject, handler, ... })` — declare workflow with type-narrowed steps + auto-registered in dashboard
- `ctx.page(id)` — Playwright Page for a system; blocks until auth is ready
- `ctx.step(name, fn)` — wraps your code, catches errors, screenshots on failure, emits to tracker
- `ctx.updateData(patch)` — merge into tracker entry's data field (use for operator-facing fields like emplId, name, etc.)
- `ctx.parallel({ task1, task2, ... })` — Promise.allSettled over multiple tasks
- Live-page dupe-protection: check the page state before submitting (e.g., `findExistingTerminationTransaction`) — no tracker cache
- `authChain: "sequential" | "interleaved"` — sequential: wait for each Duo before next; interleaved: auth#1 blocking, #2+ in background

## Daemon mode (persistent workflow processes)

Kernel workflows exposed on the CLI (`npm run separation <ids>`, `npm run work-study <emplId> <date>`, `npm run eid-lookup <names...>`, `npm run active-check <names-or-eids...>`, `npm run onboarding <emails...>`, `npm run oath-signature …`, `npm run oath-upload …`, `npm run emergency-contact …`) default to **daemon mode**:

- **First invocation with no alive daemon** → spawns one detached daemon (`tsx src/cli-daemon.ts <workflow>`), waits for auth (Duo once), enqueues the item. Daemon stays alive after processing.
- **Subsequent invocations** → insert into the shared SQLite queue (`tasks` table in `.tracker/state.db`, audit-appended to `.tracker/daemons/{workflow}.queue.jsonl` for `tail -f` debugging) and `POST /wake` every alive daemon. No re-Duo.
- **Multi-daemon dispatch**: all alive daemons for a workflow race to claim the next queued row via a single `UPDATE … RETURNING` against `tasks` indexed by `tasks_control_claimable_idx (workflow, control_state, priority DESC, enqueued_at ASC)`, run inside a `transaction(...)`. Whichever daemon's `UPDATE` wins grabs the row — dynamic load balancing without a coordinator. (No filesystem mutex; the JSONL `.queue.jsonl` is audit-only.)
- **Keepalive**: every 15 min idle, each daemon runs `session.healthCheck(system)` per system so SAML/Duo sessions don't silently expire between items.

Flags (on `separation`, `work-study`, `eid-lookup`, `active-check`, `onboarding`, `oath-signature`, `oath-upload`, `emergency-contact`):
- `-n, --new` — spawn one **additional** daemon even if others are alive.
- `-p, --parallel <N>` — ensure ≥N daemons are alive before enqueueing (spawns `max(0, N - alive)`).

`eid-lookup` daemon hard-wires the default CRM-on variant (`eidLookupCrmWorkflow`). If a different variant is ever needed, add a separate daemon shape.

`onboarding` daemon runs the standard `onboardingWorkflow` (CRM + UCPath + I9, 2 Duos per session since I9 is SSO no-2FA). For throughput, start N daemons with `-p N`. Pass multiple emails positionally to fan them across alive daemons via the shared queue.

Lifecycle commands (converted workflows: `separations`, `work-study`, `eid-lookup`, `active-check`, `onboarding`, `oath-signature`, `oath-upload`, `emergency-contact`):
- `npm run <workflow>:stop` — soft-stop (drain in-flight, re-queue). Use `-- --force` to mark in-flight as failed and exit immediately.

Converting a new workflow to daemon mode is mechanical — see `src/workflows/CLAUDE.md#daemon-mode-conversion-template`. Implementation: `src/core/daemon/{types,registry,queue,client,daemon}.ts` (main loop) + `src/cli-daemon.ts` (entry). Full design doc: `docs/superpowers/specs/2026-04-22-workflow-daemon-mode-design.md`.

## Environment

Copy `.env.example` → `.env` and set:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password

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

## Selector registry

Every Playwright selector used by automation lives in a per-system `selectors.ts`:

```
src/systems/ucpath/selectors.ts
src/systems/crm/selectors.ts
src/systems/i9/selectors.ts
src/systems/old-kronos/selectors.ts
src/systems/kuali/selectors.ts
src/systems/new-kronos/selectors.ts
```

Selectors are functions returning `Locator` / `FrameLocator`, each carrying a `// verified YYYY-MM-DD` comment. Fallback chains (`.or()`) up to 6-deep are used where PeopleSoft grid IDs mutate or similar brittle anchors need hardening. Wrap invocations with `safeClick` / `safeFill` from `src/systems/common/` to log `log.warn("selector fallback triggered: <label>")` when the primary + fallbacks all miss.

Do **not** inline `page.locator("...")` in system `.ts` files — the [`tests/unit/systems/inline-selectors.test.ts`](./tests/unit/systems/inline-selectors.test.ts) guard rejects PRs that do. Compound paths rooted in registry locators (`row.locator("td").nth(1)`) are whitelisted via end-of-line `// allow-inline-selector` comments.

When you verify a selector via `playwright-cli snapshot`, bump its `// verified` date in `selectors.ts`. Never guess selectors — map the live page first.

## Selector Intelligence

Three artifacts per system support adding new workflows without re-mapping selectors or repeating past mistakes:

- **`src/systems/<sys>/SELECTORS.md`** — auto-generated catalog of every selector this system exports. Each entry has the FQN (e.g. `smartHR.tab.personalData`), one-line summary from JSDoc, `@tags`, and a clickable line ref into `selectors.ts`. Regenerate after any selectors.ts change with `npm run selectors:catalog`. Committed so future Claude sessions see the catalog without running anything. A unit test (`tests/unit/scripts/selectors-catalog.test.ts`) gates drift — PRs that change selectors without regenerating fail there.
- **`src/systems/<sys>/LESSONS.md`** — append-only structured lessons. Required subsections per H2: `**Tried:**`, `**Failed because:**`, `**Fix:**`, `**Tags:**` (plus optional `**Selector:**` and `**References:**`). `tests/unit/scripts/lessons-format.test.ts` enforces the shape. When you discover a non-obvious selector failure, append a lesson here so the next session doesn't relearn it.
- **`src/systems/<sys>/common-intents.txt`** — hand-curated 5-10 typical intents per system. Useful reference when authoring a new workflow's CLAUDE.md `selector:search` examples.

The fuzzy search:

```bash
npm run selector:search "comp rate"
# → top hit: ucpath/jobData.compRateCodeInput (selector)
# → also: relevant lessons that touch the same intent
```

Workflow when adding or finding a selector:
1. `npm run selector:search "<your intent>"` — does a matching selector exist?
2. If yes, USE IT. Don't remap.
3. If no, check the per-system `LESSONS.md` for related failure modes.
4. Map a new selector via `playwright-cli`, add JSDoc + `@tags` + `// verified <date>` in `selectors.ts`, run `npm run selectors:catalog`.
5. If you hit a non-obvious failure on the way, append a lesson to `LESSONS.md`.

Each per-system `CLAUDE.md` links to its `LESSONS.md` + `SELECTORS.md` and embeds this loop verbatim.

## Dashboard

`npm run dashboard` starts SSE backend (`:3838`) + Vite frontend (`:5173`). Observation-only: workflows launched via npm scripts, dashboard displays live queue and logs.

Workflows emit JSONL to `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`; SSE server streams to React SPA. All UI metadata (label, steps, detailFields) comes from server-side kernel registry — no frontend edits needed when adding workflows.

**Details:** See `src/dashboard/CLAUDE.md` (frontend), `src/tracker/CLAUDE.md` (backend).

## Deferred & Archived

Historical design decisions and obsolete patterns are documented in spec/plan files in `docs/superpowers/`. Refer to these for context on architectural decisions but don't need them for current work.

## Continuous improvement

After every error fix, selector re-map, or new pattern: update the relevant CLAUDE.md. These files are the only memory between sessions — keep them accurate. Add notes to `## Lessons Learned` in the module/workflow you touched; bump `// verified` dates in `selectors.ts` when you re-map a selector; keep gotchas current.

## Memory Search (claude-mem)

Before any non-trivial work (planning, debugging, implementing), query prior sessions with `mem-search` skill:
- **mem-search:** Natural-language query wrapper (search → timeline → get_observations)
- **knowledge-agent:** For repeated questions on the same topic in one session (build corpus, prime, query)

See `LESSONS.md` (project root) for when to query memory. Observations are historical — verify against current code before acting on recalled facts.

**Skills:** `mem-search`, `knowledge-agent`, `smart-explore` (code structure), `timeline-report`

## Selector Discovery (playwright-cli)

Use `playwright-cli` (install: `npm install -g @playwright/cli@latest`) to map selectors before writing code:

```bash
playwright-cli -s=session open --headed <url>
playwright-cli -s=session snapshot              # view element refs
playwright-cli -s=session click e40             # click by ref ID
playwright-cli -s=session screenshot
playwright-cli -s=session close
```

After mapping, add to `src/systems/<system>/selectors.ts` with `// verified YYYY-MM-DD` comment. Run `npm run selectors:catalog` to sync.
