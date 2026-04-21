# HR Automation

UCPath HR automation for UCSD. Playwright-driven onboarding, separations, EID lookups, work-study updates, UKG report downloads, and emergency contact fills — composed from per-system drivers and a small workflow kernel.

## Commands

```bash
# Onboarding
npm run start-onboarding <email>       # Full onboarding for one employee
npm run start-onboarding:dry <email>   # Dry-run onboarding (CRM extract only, no UCPath)
npm run start-onboarding:batch -- <N>  # Batch onboarding with N parallel workers (kernel pool mode)
npm run extract <email>                # Extract employee data from CRM only

# Separations
npm run separation <docId> [docId ...] # Single doc or batch; shared browsers across docs
npm run separation:dry <docId>         # Dry-run (extract + log only)

# Kronos Reports
npm run kronos                         # Download Time Detail PDFs (4 workers, kernel pool mode)
npm run kronos:dry                     # Dry-run (preview employee list)
npm run kronos -- --workers 8          # Custom worker count

# Work Study
npm run work-study <emplId> <date>     # PayPath position pool update
npm run work-study:dry <emplId> <date> # Dry-run (preview ActionPlan only)

# Emergency Contact
npm run emergency-contact <batchYaml>      # Fill Emergency Contact for every record
npm run emergency-contact:dry <batchYaml>  # Preview records (no browser)
# Flags: --roster-url "<sp-url>" | --roster-path <xlsx> | --ignore-roster-mismatch

# EID Lookup (no npm script — CLI directly)
tsx --env-file=.env src/cli.ts eid-lookup "Last, First Middle"
tsx --env-file=.env src/cli.ts eid-lookup --workers 4 "Name1" "Name2"
tsx --env-file=.env src/cli.ts eid-lookup --dry-run --no-crm "Name"

# Dashboard (separate terminal — auto-updates as workflows run)
npm run dashboard            # SSE backend (:3838) + Vite dev (:5173) — open http://localhost:5173
npm run dashboard:prod       # Serve pre-built dashboard from SSE only

# Export / Utilities
tsx --env-file=.env src/cli.ts export <workflow>   # Dump JSONL tracker to xlsx
npm run clean:tracker                              # Prune .tracker/*.jsonl older than 7 days
npm run clean:tracker -- --days 30 --dir .tracker  # Custom age + dir
npm run test-login                                 # Smoke test UCPath + CRM auth
npm run setup                                      # First-use environment validation wizard
npm run schemas:export                             # Write each workflow's Zod input schema as JSON Schema
npm run new:workflow -- <name> [--systems a,b]     # Scaffold a new kernel workflow
npm run selectors:catalog                          # Regenerate per-system SELECTORS.md from selectors.ts
npm run selector:search "<intent>"                 # Fuzzy search across SELECTORS.md + LESSONS.md
npm run typecheck                                  # Type-check src/
npm run typecheck:all                              # Type-check src/ + tests
npm run test                                       # Unit tests
npm run build:dashboard                            # Single-file dashboard build
```

All runtime scripts use `tsx --env-file=.env`. If `npm` is blocked by group policy, invoke tsx directly: `./node_modules/.bin/tsx --env-file=.env src/cli.ts <command>`.

## Architecture

The repo is split three ways: per-system drivers (`src/systems/`), a small workflow kernel (`src/core/`), and composed workflows (`src/workflows/`). Auth, tracker, dashboard, and utils are cross-cutting support.

```
src/
  core/                # Workflow kernel — defineWorkflow, runWorkflow(Batch|Pool), Session, Stepper, Ctx
    types.ts           # WorkflowConfig, Ctx, SystemConfig, RunOpts, WorkflowMetadata
    workflow.ts        # defineWorkflow + runWorkflow + runWorkflowBatch (sequential)
    pool.ts            # runWorkflowPool (N workers each with own Session)
    session.ts         # Session.launch: launch + tile + auth (sequential or interleaved)
    stepper.ts         # ctx.step/markStep/parallel/updateData plumbing
    registry.ts        # WorkflowMetadata registry; defineDashboardMetadata for legacy
    ctx.ts             # makeCtx — builds Ctx from Session + Stepper
  systems/             # Playwright drivers, one per external system
    common/            # safeClick / safeFill / dismissPeopleSoftModalMask (cross-system)
    crm/               # ACT CRM (Salesforce) search + record-page extract
    i9/                # I9 Complete employee profile + record creation
    ucpath/            # PeopleSoft Smart HR, person search, PayPath, emergency contact, ActionPlan
    kuali/             # Kuali Build separation form extract + fill
    new-kronos/        # WFD/Dayforce employee search + timecard
    old-kronos/        # UKG Kronos search + Time Detail report download
  workflows/           # Composed workflows — each is defineWorkflow(...) + CLI adapter
    work-study/        # Kernel. UCPath PayPath work-study update.
    emergency-contact/ # Kernel (batch, preEmitPending). UCPath Emergency Contact fill.
    eid-lookup/        # Kernel. Person Org Summary lookup + optional CRM cross-verify.
    onboarding/        # Kernel (single + pool mode). CRM → UCPath + I9. Parallel mode via runWorkflowBatch.
    separations/       # Kernel (4 systems, interleaved auth, sequential batch via runWorkflowBatch).
    old-kronos-reports/# Kernel (pool mode, N workers, per-worker sessionDir via opts.launchFn).
  auth/                # Per-system login flows + duo-poll + sso-fields (shared).
  browser/             # launchBrowser, tiling math. Kernel-internal.
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

## Writing a new workflow

Declare it with `defineWorkflow`. The kernel handles browser launch, auth (Duo-aware, sequential or interleaved), tracker emissions, SIGINT cleanup, screenshotting on step failure, per-item `withTrackedWorkflow` wrapping in batch/pool modes, and the dashboard registry. Your handler just drives Playwright.

Minimal example:

```ts
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { loginToUCPath } from "../../auth/login.js";
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

Run `npm run new:workflow -- my-workflow --systems ucpath,crm` to scaffold the five canonical files. The generated `CLAUDE.md` links the per-system `LESSONS.md` + `SELECTORS.md` for each declared system and embeds the "Before mapping a new selector" boilerplate so the loop is self-bootstrapping. Then add a Commander subcommand in `src/cli.ts`, add npm scripts to `package.json`, fill in the schema + handler, and that's the whole story — no dashboard registry edits needed.

See `src/workflows/work-study/` for a clean one-system example, `src/workflows/emergency-contact/` for batch-mode with `preEmitPending`, `src/workflows/onboarding/` for multi-system sequential auth + pool-mode parallel, `src/workflows/old-kronos-reports/` for pool-mode with per-worker sessionDir injection, and `src/workflows/eid-lookup/` for `shared-context-pool` mode (N per-item tabs fanning out from a single Duo auth per system).

All production workflows are kernel-based as of 2026-04-17. No `defineDashboardMetadata(...)` callers remain in `src/workflows/*`. New workflows should follow the kernel path exclusively; the legacy shape is institutional memory only.

## Kernel primer

`defineWorkflow<TData, TSteps>` takes a config and returns a `RegisteredWorkflow`. The config shape:

- `name` / `label` — kebab-case id + human label (auto-titled if `label` omitted).
- `systems: SystemConfig[]` — one per external system. `{ id, login, sessionDir?, resetUrl? }`. `login` must throw on failure.
- `steps: readonly string[] as const` — declared step names. `ctx.step`/`markStep` are type-narrowed against this tuple.
- `schema: ZodType<TData>` — validated before the handler runs.
- `authChain: "sequential" | "interleaved"` — sequential waits for each Duo before the next; interleaved auths #1 blocking then chains #2+ in background while the handler starts. Default: interleaved for >1 system, sequential for 1.
- `authSteps?: boolean` — default `true`. When `false`, the kernel does NOT auto-prepend `auth:<id>` step names from `systems`. Set to `false` for workflows that already declare their own auth step names (e.g. onboarding's `crm-auth`, `ucpath-auth`).
- `tiling: "auto" | "single" | "side-by-side"` — CDP-based window tiling.
- `batch?: { mode: "sequential" | "pool", poolSize?, betweenItems?, preEmitPending? }` — plumbed by `runWorkflowBatch`. `pool` mode uses `runWorkflowPool` (each worker gets its own Session — one Duo per worker).
- `detailFields: Array<{ key, label } | string>` — dashboard detail panel. Keys must be populated by `ctx.updateData(...)` before the handler returns, or a `log.warn` fires.
- `getName(data) / getId(data)` — optional resolvers for the dashboard's row label + id.

The `ctx` object passed to your handler:

- `page(id)` — returns the Playwright Page for system `id`, awaiting that system's auth-ready promise first.
- `step(name, fn)` — emits `running`, runs `fn`, catches errors (screenshots every page, emits `failed`, rethrows).
- `markStep(name)` — announce-only; no body, no error handling.
- `parallel({ a: () => ..., b: () => ... })` — `Promise.allSettled` shape (each key gets a `PromiseSettledResult`).
- `parallelAll(...)` — `Promise.all` shape (fail-fast, unwrapped values).
- `retry(fn, { attempts, backoffMs })` — linear-backoff retry (default 3 attempts).
- `updateData(patch)` — merges into the tracker entry's `data` field.
- `screenshot({ kind, label })` — capture all open browser pages, emit a `screenshot` tracker event, and return the capture record. `kind` is `"form"` | `"error"` | `"manual"`. Use for post-submit audit screenshots in handlers (`"form"`); `"error"` is reserved for the kernel's failure-catch path.
- `session`, `log`, `isBatch`, `runId` — escape hatches.

Side-effect-free work can be memoized via `stepCacheGet`/`stepCacheSet` (from `src/core/step-cache.ts`, pattern-twin of `idempotency.ts`). Handlers call these inline at step start/end; default 2h TTL; 7-day disk prune. Storage at `.tracker/step-cache/{workflow}-{itemId}/{stepName}.json`. Onboarding's `extraction` step is the canonical caller.

Run modes: `runWorkflow(wf, data)` for a single item; `runWorkflowBatch(wf, items)` for sequential batch (with optional `onPreEmitPending` for dashboard pre-emit); `runWorkflowPool(wf, items)` for N-worker pool (N Sessions, each with its own Duo). Each per-item path is wrapped in `withLogContext` + `withTrackedWorkflow`, so you never call those directly from a handler.

Escape hatches: `ctx.session.page(id)` / `ctx.session.newWindow(id)` expose the underlying Session. Use them only when the kernel's declarative shape doesn't express what you need.

## Environment

Copy `.env.example` → `.env` and set:
- `UCPATH_USER_ID` — UCSD SSO username
- `UCPATH_PASSWORD` — UCSD SSO password

Duo MFA is manual — the automation pauses and polls until you approve on your phone.

## Configuration

`src/config.ts` centralizes URLs, PATHS (user-agnostic via `homedir()`), TIMEOUTS, SCREEN dimensions, and ANNUAL_DATES (update each fiscal year). Workflow-specific configs in `src/workflows/*/config.ts` re-export or narrow.

## Gotchas

PeopleSoft and UKG quirks bite every session. Keep these in mind:

- **UCPath iframe** — all content lives in iframe `#main_target_win0` (not `#ptifrmtgtframe`). Access via `getContentFrame(page)` in `src/systems/ucpath/navigate.ts`.
- **UCPath Smart HR subdomain** — use `ucphrprdpub.universityofcalifornia.edu`, not `ucpath.` — the `ucpath.` subdomain re-triggers SSO.
- **PeopleSoft modal mask** (`#pt_modalMask`) — a transparent overlay that intercepts every click. Dismiss via `dismissPeopleSoftModalMask(page)` (in `src/systems/common/`) before each click, especially between tab switches.
- **PeopleSoft grid index mutation** — grid inputs (phone, email, comp rate) use IDs like `HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0`. The `$N` suffix changes after page refreshes (e.g. position-number fill reshuffles indices). Always use `input[id="..."]` (not just `[id="..."]`), and register selectors with 5-deep `.or()` fallback chains in `src/systems/<system>/selectors.ts`.
- **HR Tasks sidebar overlay** intercepts clicks on iframe buttons. Collapse it via the "Navigation Area" button before interacting with transaction forms.
- **PeopleSoft dropdowns trigger page refreshes** — always `waitForTimeout()` after `selectOption()` before filling the next field.
- **Comp Rate Code / Compensation Rate** — select by accessible name (`getByRole("textbox", { name: "Comp Rate Code" })`) then press Tab to blur and trigger validation. Compensation Frequency must be explicitly filled `"H"` if empty. (Comp Rate Code is `UCHRLY`, not `HCHRLY`.)
- **Visit all 4 UCPath Smart HR tabs before Save** — Save stays disabled until Personal Data → Job Data → Earns Dist → Employee Experience have all been visited. After filling Initiator Comments on the last tab, re-click Personal Data before Save.
- **Expected Job End Date for dining hires** — constant `06/30/2026`. Update annually in `src/config.ts` (`ANNUAL_DATES.jobEndDate`) or override via `ANNUAL_DATES_END` env var. `src/workflows/onboarding/config.ts` re-exports it as `JOB_END_DATE`.
- **Person Org Summary single-result redirect** — when search returns exactly 1 match, PeopleSoft skips the grid and jumps straight to the detail page. Automation must detect both paths.
- **Name search fallbacks** — `"Last, First Middle"` may not match. Try full → first-only → middle-only. Watch for spelling variants and legal vs preferred names.
- **Duo MFA sequencing** — simultaneous Duo prompts error. The kernel serializes per-system auth via `authChain`; don't roll your own.
- **UKG widgetFrame id drifts** — use `getGeniesIframe(page)` with its 4-level frame fallback (direct ID → query selector → `page.frames()` scan → full page reload, up to 15 retries).
- **Kuali date inputs sometimes ignore `fill()`** — read back and retry with `type()` (character-by-character) if mismatch. See `src/systems/kuali/navigate.ts`.

Per-system gotchas live in `src/systems/<system>/CLAUDE.md`. Per-workflow gotchas live in `src/workflows/<name>/CLAUDE.md`.

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
- **`src/systems/<sys>/common-intents.txt`** — hand-curated 5-10 typical intents per system. The `npm run new:workflow --systems X` scaffolder reads these and seeds the generated workflow's CLAUDE.md with example `selector:search` invocations.

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

`npm run dashboard` starts the SSE backend (`:3838`) + Vite dev server (`:5173`). Open http://localhost:5173.

Workflows emit JSONL entries via the kernel's `withTrackedWorkflow` wrapping; the SSE server reads `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` + `*-logs.jsonl`, enriches entries with `firstLogTs`/`lastLogTs`/`lastLogMessage`, and streams to the React SPA. The dashboard reads all UI metadata (label, steps, systems, detailFields) from the server-side registry populated by `defineWorkflow` / `defineDashboardMetadata` — no frontend edits needed when you add a workflow.

Current step tracking per workflow:

| Workflow | Steps |
|---|---|
| onboarding | crm-auth → extraction → pdf-download → ucpath-auth → person-search → i9-creation → transaction |
| separations | auth:kuali → auth:old-kronos → auth:new-kronos → auth:ucpath → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization |
| eid-lookup | searching (+ cross-verification in CRM mode) — one row per name via shared-context-pool |
| kronos-reports | searching → extracting → downloading |
| work-study | ucpath-auth → transaction |
| emergency-contact | navigation → fill-form → save |

As of 2026-04-18, the dashboard is **observation-only**. The previous "⚡ RUN" drawer + `RunnerLauncher` button + `SchemaForm` + `runner-recents` localStorage helper + the backend `buildSpawnHandler`/`buildCancelHandler`/`buildActiveRunsHandler`/`buildWorkflowSchemaHandler` factories + the child-process registry were all removed. Workflows are launched via the npm scripts above (or whatever replacement launcher the user wires up later — out of scope for this pass). Live session monitoring (`SessionPanel`), selector-warning aggregation (`SelectorWarningsPanel`), screenshot browsing (`ScreenshotsPanel` — replaced the inline `FailureDrillDown` on 2026-04-21), step-timing chips (`StepPipeline`), and cross-workflow search (`SearchBar`) all keep working — they read kernel-emitted events from `src/tracker/jsonl.ts`, independent of any launcher.

Implementation details live in `src/dashboard/CLAUDE.md` (frontend) and `src/tracker/CLAUDE.md` (backend).

## Pending follow-ups (deferred)

These items appear in plans/improvements docs but were not shipped in 2026-04-18's selector-intelligence + runner-removal pass. They'll be picked up in a later session.

- **Stats panel + run-diff frontend.** ~357 lines of backend handler scaffolding (`buildStatsHandler`, `buildDiffHandler`, types) sit uncommitted in `src/tracker/dashboard.ts`. No tests, no frontend, no route registration. Decide: commit + open frontend tickets, or `git checkout -- src/tracker/dashboard.ts` to discard. Note that `computeStepDurations` is committed and powers the StepPipeline timing chips already — discarding the scaffolding would NOT regress those.
- **Replacement workflow launcher.** Out of scope for this pass; user will wire something else where ⚡ RUN used to be. The `TopBar`'s `rightSlot` prop is preserved for that future mount.
- **Bundle size code-split** (handoff §1.8). Bundle is 906.74 KB after runner removal (down from 940.65 KB).
- **ESLint rule for selectors** (handoff §8.3). The `tests/unit/systems/inline-selectors.test.ts` guard still enforces "no inline selectors outside `selectors.ts`" — promotion to ESLint is editor-time-feedback only.
- **Step-cache shipped 2026-04-18; kernel-level resume deferred indefinitely.** `src/core/step-cache.ts` is the primitive; onboarding's `extraction` + `pdf-download` opt in. Saves ~2–3 min on onboarding retry-after-failure. A full kernel `Ctx.step(name, fn, { resumable: true })` opt-in + `npm run resume <runId>` CLI was explicitly scoped out because onboarding's handler holds state in local closures (`let data: EmployeeData | null`) — kernel-level step-skip would require a ~100-line handler restructure for no additional user-visible savings. Design doc: `docs/superpowers/specs/2026-04-18-step-cache-design.md`.
- **Audit log** (improvements §7.1). Append-only hash-chained log of every run + transaction.
- **Quarterly selector verified-date lint** (improvements §6.1). All current dates are within 33 days; this is preventative, not urgent.
- **Migration of `cleanTrackerMain` export → internal.** Audit flagged as exported but unused outside its own module; left alone (low impact).

See `docs/handoff-2026-04-18.md` (uncommitted; in working tree) for the full pre-existing pending-task list with priority ratings.

## Continuous improvement

After every error fix, selector re-map, or new pattern: update the relevant CLAUDE.md. These files are the only memory between sessions — keep them accurate. Add notes to `## Lessons Learned` in the module/workflow you touched; bump `// verified` dates in `selectors.ts` when you re-map a selector; keep gotchas current.

## claude-mem — reflexive memory search

claude-mem is installed and auto-captures observations from every session, but it does NOT auto-query. Before any non-trivial task — planning, refactoring, implementing a new workflow/selector/system, debugging a recurring or non-obvious issue, or answering "have we seen this before" / "how did we handle X" / "what's the status of Y" — run `/mem-search "<task keywords>"` as one of the first actions to surface prior-session context. Skip only for trivial one-liners, reading a single known file, or unambiguous step-by-step instructions. If the search returns nothing useful, proceed normally — don't stall.

## Playwright-cli — selector discovery

`playwright-cli` (install/update: `npm install -g @playwright/cli@latest`) opens headed browsers and dumps accessibility snapshots with ref IDs for every element. Use it before writing any new selector. Core loop:

```bash
playwright-cli -s=mysession open --headed "https://example.com"
playwright-cli -s=mysession snapshot                 # accessibility tree with refs
playwright-cli -s=mysession fill e34 'value'         # by ref ID
playwright-cli -s=mysession click e40
playwright-cli -s=mysession screenshot
playwright-cli -s=mysession close                    # or close-all / kill-all
```

Snapshot refs: `e40` = main page, `f2e1` = element inside iframe #2. For hidden-but-present elements, use `eval` with JS `.click()` instead. `playwright-cli --help` for the full list.

After mapping, add the selector to the relevant `src/systems/<system>/selectors.ts` with today's `// verified` date.

## Obsolete patterns (institutional memory)

These patterns existed pre-kernel and are intentionally removed. Do not reintroduce them:

- **`WorkflowSession.create()`** — pre-kernel shared-auth abstraction. Replaced by `Session.launch()` inside `src/core/`. Workflows access it only as an escape hatch via `ctx.session`.
- **Inline `withTrackedWorkflow` / `withLogContext`** — handlers now wrap nothing; the kernel wraps each item automatically. No remaining in-repo callers — all 6 workflows delegate to the kernel's per-item wrapping.
- **Inline `launchBrowser` from handlers** — kernel owns browser lifecycle. Use `ctx.page(id)`.
- **Hand-rolled auth-ready promises** — `authChain: "interleaved"` in the kernel does this. Older docs showed ~140 lines of promise-chain recipes; they are obsolete.
- **`WF_CONFIG` in the frontend** — deleted in subsystem D. Dashboard UI metadata is now server-side in the kernel registry.
- **`markStaleRunningEntries`** — removed; caused false "Process interrupted" failures. Replaced by a SIGINT handler in `withTrackedWorkflow`.
- **Per-workflow Excel tracker as primary observability** — dashboard JSONL is the source of truth. Existing xlsx writers (`updateWorkStudyTracker`, onboarding's + old-kronos-reports' trackers, etc.) are retained for historical use and are Excel-only (they no longer emit tracker events). Eid-lookup's xlsx tracker was removed entirely on 2026-04-21 — JSONL + dashboard cover it.
- **Raw `page.locator("...")` calls in system `.ts` files** — all selectors go through `src/systems/<system>/selectors.ts`. The inline-selectors test guard enforces this.
