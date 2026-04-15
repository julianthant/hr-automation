# Workflow Kernel — Architecture Design

**Date:** 2026-04-15
**Status:** Draft — pending user review
**Scope:** Workflow kernel (Priority B) + directory structure (Priority E). Selector registry (A), dashboard richness leveling (D), and CLAUDE.md convention enforcement (C) are deferred to follow-up specs.

## Summary

Introduce a declarative workflow kernel (`src/core/`) that owns browser launch, auth orchestration, dashboard event emission, batch/pool execution, and error/cleanup wiring. Each workflow becomes a `defineWorkflow(config)` call with a `handler` function that contains only business logic. All 6 existing workflows migrate to this kernel, one at a time. Workflow-specific helpers currently in `src/utils/` move into their owning workflow directory. Per-system modules (`ucpath`, `kuali`, `crm`, etc.) get regrouped under `src/systems/`.

## Motivation

Evidence from a codebase survey showed:

1. **`WorkflowSession` class exists in `src/browser/session.ts` but zero workflows use it.** Every workflow calls `launchBrowser()` directly with a different pattern — per-page (onboarding), tiled (separations), worker-pooled (kronos-reports, eid-lookup), reused-across-batch (emergency-contact).
2. **Auth-ready promise chains are copy-pasted across multi-system workflows.** Separations has ~50 lines of `.catch(() => {}).then(...)` plumbing.
3. **Dashboard `WF_CONFIG` in `src/dashboard/components/types.ts` drifts from workflow code.** Step names live in two places; keeping them in sync is manual.
4. **Four files exceed 500 lines** (`ucpath/transaction.ts` 657, `eid-lookup/search.ts` 638, `separations/workflow.ts` 523, `old-kronos/navigate.ts` 514), mostly because lifecycle/orchestration code lives next to business logic.
5. **`src/utils/` has become a dumping ground** (`roster-verify.ts` and `sharepoint-download.ts` are emergency-contact-specific).
6. **Error handling is inconsistent.** Only onboarding has retries. Separations swallows phase failures silently. Others crash on flakes.
7. **Dashboard event richness varies.** Onboarding emits 7 steps + 5 `updateData` calls; work-study emits 2 + minimal. Users feel this as an "empty" dashboard for some workflows.

The kernel eliminates items 1–4 and 6 directly. Items 5 and 7 are addressed by the directory moves in this spec and by the follow-up "dashboard richness" spec respectively.

## Non-goals

- Rewriting per-system navigation modules (UCPath, Kuali, Kronos, CRM) — those stay intact, just relocated.
- Changing the CLI surface — `npm run separation <docId>` still works the same.
- Replacing Playwright or Zod.
- Replacing the dashboard frontend stack.
- A general-purpose workflow orchestration framework. The kernel is opinionated to this codebase's exact shape.

## Architecture

### Layer responsibilities

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| **Workflows** | `src/workflows/<name>/` | Zod schema, `defineWorkflow` config, `handler` business logic, workflow-specific helpers |
| **Core (kernel)** | `src/core/` | `defineWorkflow`, `runWorkflow`, `Session`, `Stepper`, `BatchRunner`, `Registry` |
| **Systems** | `src/systems/<system>/` | Per-external-system navigation and interaction (UCPath, Kuali, Kronos, CRM, I9) |
| **Auth** | `src/auth/` | Login flows (UCPath SSO, CRM, Kuali, I9, UKG, WFD), Duo queue, SSO credential fill |
| **Browser** | `src/browser/` | Low-level Playwright launch + tiling math (consumed by Core) |
| **Tracker** | `src/tracker/` | JSONL write, SSE API, Excel export |
| **Dashboard** | `src/dashboard/` | React SPA |
| **Utils** | `src/utils/` | Generic stateless helpers (`log`, `env`, `errors`, `screenshot`, `worker-pool`) |

### Target directory shape

```
src/
  core/                         NEW
    workflow.ts                   defineWorkflow, runWorkflow entry points
    session.ts                    Session class: browsers + auth chain + tiling
    stepper.ts                    ctx.step implementation
    batch.ts                      sequential batch runner
    pool.ts                       worker-pool batch runner
    registry.ts                   module-level workflow registry for dashboard
    page-health.ts                moved from utils/
    types.ts                      shared types (Ctx, WorkflowConfig, SystemConfig)
  systems/                      RENAMED from per-system top-level dirs
    ucpath/
    kuali/
    crm/
    old-kronos/
    new-kronos/
    i9/
  workflows/
    onboarding/
    separations/
    emergency-contact/
      roster-verify.ts              moved from utils/
      sharepoint-download.ts        moved from utils/
    eid-lookup/
    old-kronos-reports/
    work-study/
  auth/                         unchanged
  browser/
    launch.ts                     kept — consumed by core/session.ts
    tiling.ts                     kept — consumed by core/session.ts
    session.ts                    DELETED — unused WorkflowSession class
  tracker/                      unchanged
  dashboard/                    minor: WF_CONFIG becomes runtime fetch
  utils/                        trimmed to generic helpers only
  cli.ts                        imports each workflow module (triggers registry)
  config.ts                     unchanged
  scripts/                      unchanged
```

## Kernel contract

### Workflow definition

```ts
// src/core/types.ts
interface SystemConfig {
  id: string                                                    // 'ucpath' | 'kuali' | ...
  login: (page: Page, instance?: string) => Promise<void>       // existing login fn
  sessionDir?: string                                           // persistent (Kronos)
  resetUrl?: string                                             // navigated to between batch items
}

interface BatchConfig {
  mode: 'sequential' | 'pool'
  poolSize?: number                                             // pool mode only
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean                                      // emit all items as pending upfront
}

interface WorkflowConfig<TData, TSteps extends readonly string[]> {
  name: string                                                  // 'separations'
  version?: string                                              // for tracker schema migrations
  systems: SystemConfig[]
  steps: TSteps                                                 // as const tuple — type source of truth
  schema: ZodType<TData>
  tiling?: 'auto' | 'single' | 'side-by-side'                   // window layout
  authChain?: 'sequential' | 'interleaved'                      // default interleaved if systems.length > 1
  batch?: BatchConfig
  detailFields?: (keyof TData)[]                                // what shows in dashboard detail panel
  handler: (ctx: Ctx<TSteps, TData>, data: TData) => Promise<void>
}
```

### Context (`ctx`)

```ts
interface Ctx<TSteps extends readonly string[], TData> {
  /**
   * Returns the authed Page for the given system.
   * On first call, awaits that system's auth-ready promise.
   * Subsequent calls resolve immediately. Idempotent.
   * Parallelism preserved by calling inside each parallel task separately.
   */
  page(id: SystemConfig['id']): Promise<Page>

  /**
   * Wrap a step. Emits tracker 'running' with step name on entry.
   * Catches errors, calls classifyError(), emits 'failed' with step, re-throws.
   * Step name is constrained to TSteps[number] at compile time.
   */
  step<R>(name: TSteps[number], fn: () => Promise<R>): Promise<R>

  /**
   * Run tasks in parallel. Object-keyed for named destructuring.
   * Returns PromiseSettledResult per task — caller decides how to react.
   * Each task's page() call awaits its own system's auth independently.
   */
  parallel<T extends Record<string, () => Promise<unknown>>>(
    tasks: T
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }>

  /**
   * Enrich the tracker entry for this item (name, IDs, dates).
   * Merged shallowly. Fields listed in detailFields appear in the dashboard detail panel.
   */
  updateData(patch: Partial<TData & Record<string, unknown>>): void

  /**
   * Escape hatch: access the underlying Session for newWindow, closeWindow, etc.
   * Rarely needed — most workflows only use page() / step() / parallel().
   */
  session: Session

  /** Structured logger, already context-injected with workflow + itemId + runId. */
  log: typeof log

  /** True when invoked via runWorkflowBatch or runWorkflowPool. */
  isBatch: boolean

  /** Current tracker run ID (for manual emissions). */
  runId: string
}
```

### Entry points

```ts
// src/core/workflow.ts
function defineWorkflow<TData, TSteps extends readonly string[]>(
  cfg: WorkflowConfig<TData, TSteps>
): RegisteredWorkflow<TData, TSteps>

async function runWorkflow<TData, TSteps>(
  wf: RegisteredWorkflow<TData, TSteps>,
  data: TData
): Promise<void>

async function runWorkflowBatch<TData, TSteps>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts?: { dryRun?: boolean }
): Promise<BatchResult>

// Pool mode uses BatchConfig.mode === 'pool' on the workflow itself.
// runWorkflowBatch dispatches to sequential or pool based on that config.
```

### Responsibilities of the runner

When `runWorkflow(wf, data)` is called, in order:

1. Validate `data` via `wf.schema` — reject before launching anything.
2. Register the workflow in the runtime registry (idempotent — `defineWorkflow` also does this on import).
3. Wrap the entire call in `withTrackedWorkflow(wf.name, itemId, fn, { preAssignedRunId })`.
4. Wrap in `withLogContext(wf.name, itemId, fn)`.
5. Install SIGINT handler: sync-write `failed` tracker event + sync-write `failed` log line + kill Chrome + `process.exit(1)`.
6. Construct a `Session` with `wf.systems`, `wf.tiling`, `wf.authChain`. This launches browsers in parallel and starts the auth chain.
7. Construct `Ctx` with session, a `Stepper` bound to the tracker, the logger, and `runId`.
8. Invoke `wf.handler(ctx, data)`. User code runs.
9. On completion: emit `done` with final data.
10. On throw: classify error, emit `failed`, re-throw.
11. Regardless: run session cleanup (close browsers unless batch continues).

Batch mode (`runWorkflowBatch`) inserts steps 6–10 inside a for-loop over items, with steps 6 and 11 lifted outside the loop (browsers reused across items). Between items, `betweenItems` lifecycle hooks run. `preAssignedRunId` is generated per item upfront so the dashboard can show the full pending queue from the start.

Pool mode spawns N workers each running a trimmed copy of steps 6–11 against a subset of items. Auth happens per worker.

### Error semantics

- `ctx.step` catches, classifies via `classifyError()`, emits `failed` with `step: name`, re-throws.
- `ctx.parallel` returns `PromiseSettledResult` per task — caller inspects `.status` and handles the mix. One failure does not abort siblings.
- Handler throw → runner emits `failed` at workflow level → process exits non-zero.
- SIGINT → synchronous `failed` write → kill Chrome → `process.exit(1)`. This logic is centralized in the runner, not copy-pasted in each workflow.
- Per-step retries are not built into the kernel by default. Workflows that want retries wrap the inner function themselves (e.g. `ctx.step('transaction', () => retryStep(fn))`). Onboarding's existing `retryStep` helper stays.

## Session layer

```ts
// src/core/session.ts
class Session {
  static async launch(systems: SystemConfig[], opts: SessionOpts): Promise<Session>

  page(id: string): Promise<Page>        // awaits ready promise, cached

  async reset(id: string): Promise<void> // navigate to resetUrl, dismiss modals
  async healthCheck(id: string): Promise<boolean>

  async close(): Promise<void>
  async killChrome(): Promise<void>      // SIGINT teardown
}
```

### Auth chain orchestration

**Sequential (`authChain: 'sequential'`):** For each system in order, call `login(page)` and await. Used for single-system workflows.

**Interleaved (`authChain: 'interleaved'`):** Matches the pattern already documented in CLAUDE.md under "Multi-Browser Parallel Execution":

- Launch all browsers in parallel.
- Auth system[0] blocking (primary system's nav starts as soon as Duo clears).
- Auth system[1..N-1] chained in background — each chain step attaches `.catch(() => {})` so one failure doesn't block the next auth.
- Each system exposes a `readyPromise` on the session.
- `ctx.page(id)` awaits the ready promise for that id. First call blocks until auth; subsequent calls return immediately.

Here "blocking" means `await login(systems[0].page)` — the first login's Duo is resolved before subsequent logins are kicked off. Subsequent logins run concurrently (as background promises), not serially.

This means the user no longer writes any auth-ready plumbing. The separations workflow's 50 lines of `.then()`/`.catch()` chains disappear. Parallelism is preserved because each task inside `ctx.parallel` calls `await ctx.page(id)` separately and only blocks on its own system.

### `ctx.parallel` usage example

```ts
const results = await ctx.parallel({
  oldK: async () => searchOldKronos(await ctx.page('oldKronos'), eid),
  newK: async () => searchNewKronos(await ctx.page('newKronos'), eid),
  job:  async () => getJobSummary(await ctx.page('ucpath'), eid),
})

// Each value is PromiseSettledResult<T>. Caller decides how to react.
const oldKronosDates = results.oldK.status === 'fulfilled' ? results.oldK.value : null
const newKronosDates = results.newK.status === 'fulfilled' ? results.newK.value : null
const jobSummary     = results.job.status  === 'fulfilled' ? results.job.value  : null
// Fall back to Kuali dates when Kronos failed, etc.
```

### Tiling

`tiling: 'auto'` uses `computeTileLayout(index, systems.length)` to position windows. `'single'` skips tiling (single-system workflows). `'side-by-side'` forces 2-wide regardless of system count. Kept minimal — current `computeTileLayout` handles the cases we have.

### Persistent sessions

`sessionDir` is passed through to `launchBrowser()`. Session manages cleanup: on final `close()`, ephemeral contexts are closed; persistent session dirs are preserved on disk for reuse across runs.

## Batch layer

### Sequential batch (`mode: 'sequential'`)

Browsers launched once. For each item:
1. Run `betweenItems` hooks (skipped for first item).
2. Generate new `itemId` + `runId`.
3. Run the handler with fresh `Ctx` bound to this item.
4. Emit tracker `done` or `failed`.
5. Continue regardless of individual item outcome.

`betweenItems` hooks available:
- `'health-check'` — calls `session.healthCheck(id)` for each system; re-authenticates if unhealthy.
- `'reset-browsers'` — calls `session.reset(id)` for each system (navigate to `resetUrl`, dismiss modals).
- `'navigate-home'` — just `goto(resetUrl)` without modal cleanup.

Health check and reset are no-ops on first item / single-item mode. This replaces the scattered `if (existingWindows)` guards in current workflow code.

### Pool batch (`mode: 'pool'`)

Items are distributed across N workers. Each worker owns its own Session (independent browsers, independent auth). Workers pull from a shared queue. Matches current `runWorkerPool` semantics from `src/utils/worker-pool.ts` — that helper is wrapped by the kernel, not replaced.

Worker count from `BatchConfig.poolSize`. Override via CLI: `npm run kronos -- --workers 8`.

`preEmitPending: true` emits all items as `pending` tracker entries upfront so the dashboard shows the full queue before processing starts. Used by kronos-reports and emergency-contact.

### Page-per-worker pattern (escape hatch)

Eid-lookup pools parallel workers *within a single browser context* (each gets a new Page). This is not a kernel mode — it's a helper callable from inside the handler:

```ts
handler: async (ctx, data: { names: string[] }) => {
  const page = await ctx.page('ucpath')
  const context = page.context()
  await runWorkerPool(data.names, async (name, workerPage) => {
    return searchPersonOrgSummary(workerPage, name)
  }, {
    workers: 4,
    getPage: () => context.newPage(),
  })
}
```

Keeps the kernel surface clean. Eid-lookup's existing pool logic moves behind this helper with no semantic change.

## Dashboard integration

### Runtime registration

`defineWorkflow` registers itself in a module-level registry on import:

```ts
// src/core/registry.ts
const registry = new Map<string, WorkflowMetadata>()

export function register(metadata: WorkflowMetadata) {
  registry.set(metadata.name, metadata)
}

export function getAll(): WorkflowMetadata[] {
  return [...registry.values()]
}

interface WorkflowMetadata {
  name: string
  steps: readonly string[]
  systems: string[]
  detailFields: string[]
}
```

`src/cli.ts` imports each workflow module at the top (already does this for commander registration). Imports trigger `defineWorkflow`, which populates the registry. By the time the SSE server starts, the registry is complete.

### SSE endpoint

`src/tracker/dashboard.ts` exposes `GET /api/workflows`:

```json
[
  {
    "name": "separations",
    "steps": ["launching","authenticating","kuali-extraction","kronos-search","ucpath-job-summary","ucpath-transaction","kuali-finalization"],
    "systems": ["kuali","oldKronos","newKronos","ucpath"],
    "detailFields": ["firstName","lastName","emplId","docId"]
  },
  ...
]
```

### Frontend

`src/dashboard/components/types.ts` — replace static `WF_CONFIG` object with a one-shot fetch into a top-level React context (no new dependencies; TanStack Query is not in the stack):

```ts
// src/dashboard/workflows-context.tsx
const WorkflowsContext = createContext<WorkflowMetadata[] | null>(null)

export function WorkflowsProvider({ children }: { children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowMetadata[] | null>(null)
  useEffect(() => {
    fetch('/api/workflows').then(r => r.json()).then(setWorkflows)
  }, [])
  if (!workflows) return <Loading />
  return <WorkflowsContext.Provider value={workflows}>{children}</WorkflowsContext.Provider>
}

export function useWorkflows() {
  const ctx = useContext(WorkflowsContext)
  if (!ctx) throw new Error('useWorkflows must be inside WorkflowsProvider')
  return ctx
}
```

Consumers (`QueuePanel`, `LogPanel`, workflow dropdown) read via `useWorkflows()`. Provider mounts once at app root. Dashboard config never needs manual editing again.

### Event emission

`ctx.step(name, fn)` wraps execution:

1. At entry: emit `{status: 'running', step: name, runId, itemId, data, ts}`.
2. If `ctx.updateData(patch)` called inside `fn`: emit another `running` event with merged data.
3. On throw: classify error, emit `{status: 'failed', step: name, error: classifiedMsg, ...}`, re-throw.
4. On success: no event (next step's entry event, or workflow-level `done`, subsumes it).

Workflow-level `done` emission happens in the runner after `handler` resolves.

## Migration plan

### Order

1. **work-study** — 1 system, 2 steps. Proves basic kernel for trivial case.
2. **emergency-contact** — 1 system, batch mode, `preEmitPending`. Proves sequential batch.
3. **eid-lookup** — 1 system, page-per-worker pattern. Proves escape hatch helper.
4. **kronos-reports** — worker-per-browser pool, persistent `sessionDir`. Proves pool batch.
5. **onboarding** — 3 systems sequential, PDF download side effect, retries. Proves multi-system sequential.
6. **separations** — 4 systems, interleaved auth, phase parallelism, `betweenItems` hooks. Final boss.

### Per-workflow migration steps

1. Create `src/workflows/<name>/workflow.v2.ts` alongside the existing file. Keep both for one commit.
2. Implement using `defineWorkflow`. Reuse existing per-system helpers unchanged.
3. Dry-run once: `npm run <workflow>:dry` against a known input. Verify tracker events match.
4. Real run once with user watching. Verify dashboard shows correct steps and data.
5. Swap CLI entry to v2. Delete v1 file. Commit.
6. Update `src/workflows/<name>/CLAUDE.md` to describe the new structure.

### Directory moves

Per-system renames (`src/ucpath` → `src/systems/ucpath`, etc.) happen **with** the first workflow migration that uses that system:

- Work-study migration moves `src/ucpath` → `src/systems/ucpath`.
- Emergency-contact migration moves nothing new (ucpath already moved). Also moves `src/utils/roster-verify.ts` and `src/utils/sharepoint-download.ts` into `src/workflows/emergency-contact/`.
- Eid-lookup migration: no new moves.
- Kronos-reports migration moves `src/old-kronos` → `src/systems/old-kronos`.
- Onboarding migration moves `src/crm` → `src/systems/crm` and `src/i9` → `src/systems/i9`.
- Separations migration moves `src/kuali` → `src/systems/kuali` and `src/new-kronos` → `src/systems/new-kronos`.

Deletion of `src/browser/session.ts` (unused `WorkflowSession` class) happens with the first migration.

### Rollback criteria

If a migrated workflow fails a real run on input the old workflow handled correctly:
- Revert the migration commit.
- Investigate in isolation.
- Do not block other workflow migrations — each is independent.

Full rollback of the kernel itself requires reverting every migration commit. Git tags mark each successful migration (`kernel-migration-work-study`, etc.) for easy revert points.

### Validation criteria (per workflow)

- All steps declared in `steps: [...] as const` are emitted by handler.
- All fields declared in `detailFields` are populated via `updateData`.
- Dashboard shows correct step pipeline and detail fields without manual `types.ts` edits.
- Dry-run produces same tracker events as old implementation (fields may reorder — compare by key).
- Real run completes in comparable time (±15%).
- No `console.log` leaks, no raw `launchBrowser` calls in the workflow file.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Kernel abstraction proves wrong shape when we hit separations | Migrate separations LAST. If it fits poorly, revise the kernel before migration rather than forcing it. Work done on workflows 1–5 is not wasted — they use the kernel as-is. |
| Runtime registry race condition at dashboard startup | Registry populated synchronously at module import time. SSE server only starts after CLI module graph loads. If frontend fetches before server is ready, it gets the standard connection refused and retries. |
| Lazy `page()` accessor confuses users expecting synchronous access | API returns `Promise<Page>` explicitly. TypeScript's `no-floating-promises` + `await-thenable` lint rules (add to eslint config during kernel build) flag missing `await`. Without the lint rule, a forgotten `await` produces `TypeError: X.click is not a function` on the returned Promise — recognizable once seen, but worth the lint rule to catch at write time. |
| Directory renames create massive diffs | Do renames with `git mv` so history is preserved. Do one rename per commit so reviewers can isolate. |
| Existing tests (unit tests in repo) break during migration | Run `npm run typecheck` and `npm run test` after each migration step. Fix in the same commit. |
| Emergency-contact Add-New path (currently unimplemented) blocks migration | Migration preserves existing `NoExistingContactError` behavior. Add-New implementation is a separate task after migration. |

## Success criteria

When all six workflows are migrated:

- `src/core/` is ≤ 800 lines total.
- Each `src/workflows/<name>/workflow.ts` is ≤ 150 lines.
- No raw `launchBrowser()` call outside `src/core/`.
- No raw `withTrackedWorkflow()` call outside `src/core/`.
- No raw `setStep()` call outside `src/core/`.
- No `WF_CONFIG` constant in the frontend — all metadata fetched at runtime.
- `src/utils/` contains only generic helpers (log, env, errors, screenshot, worker-pool).
- Adding a new workflow requires: 1 new file in `src/workflows/<name>/`, 1 line in `cli.ts`. Nothing else.

## Follow-up specs (explicit out-of-scope)

Once the kernel lands, three follow-up specs address the remaining priorities:

1. **Selector registry (Priority A).** Move inline selectors into `src/systems/<system>/selectors.ts` with `.or()` fallback chains standardized. Build a tiny runtime helper for "try selector with N fallbacks, log which matched." Format: verified-date comments, system/page grouping.

2. **Dashboard richness leveling (Priority D).** Audit `updateData` calls across workflows. Set a minimum data contract (name, ID, start time, current action) enforced by the `detailFields` declaration in each workflow. Fill gaps where a workflow under-reports.

3. **CLAUDE.md convention enforcement (Priority C).** Update root `CLAUDE.md` and per-module `CLAUDE.md` files to reference the kernel as the only way to write workflows. Remove the "Multi-Browser Parallel Execution" section (now implicit in the kernel). Add a short "new workflow checklist" pointing at the `defineWorkflow` type signature.

Each follow-up is a ~1-day focused change, writable as its own spec + plan.
