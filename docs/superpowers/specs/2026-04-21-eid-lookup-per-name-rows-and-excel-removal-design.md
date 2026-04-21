# Shared-Context Pool Mode + EID Lookup Per-Name Rows + Excel Removal

**Date:** 2026-04-21
**Scope:** Kernel batch-mode addition + `eid-lookup` workflow rewrite + Excel tracker removal
**Status:** Design — pending implementation plan

## Problem

`src/workflows/eid-lookup/` emits ONE JSONL tracker row per CLI invocation, even when given N names. The dashboard shows one aggregate row (e.g. `searchName: "Amine, Karen, Lopez, Giselle A, Nacionales, Sofia Isabel G"` for a 3-name run) instead of three per-name rows.

This is documented as "Acceptable regression" in `src/workflows/eid-lookup/CLAUDE.md`. The cause: the workflow's handler uses `runWorkerPool` (a utility helper from `src/utils/worker-pool.ts`) inside `ctx.step("searching", ...)` to fan out names across N tabs in a single shared `BrowserContext`. That gives the right browser topology (1 Duo, N tabs) but the wrong dashboard topology (`runWorkflow` wraps the entire run, so there's only one `withTrackedWorkflow` envelope).

The kernel's existing batch modes don't fit:
- `runWorkflowBatch` sequential → one item at a time, no parallelism.
- `runWorkflowPool` → N workers but EACH worker calls `Session.launch` with its own browser and its own Duo auth. Re-triggering Duo per worker is a hard no.

Secondary goal: remove the workflow's Excel tracker (`eid-lookup-tracker.xlsx`, `src/workflows/eid-lookup/tracker.ts`). JSONL + dashboard are the only observability surface going forward. This deletes ~80 lines of mutex plumbing and async-serialization glue that only exists because xlsx is not append-safe.

## Goals

1. One JSONL row per name (per-name status, step timing, per-name result fields in the detail panel).
2. Preserve today's "1 Duo per system, N tabs per system in a shared `BrowserContext`" semantics. Must NOT regress to per-worker browsers or per-worker Duo prompts.
3. Excel tracker removed entirely. No `tracker.ts`, no `.xlsx`, no `updateEidTracker` callers anywhere in `src/`.
4. Both workflow variants (`eidLookupWorkflow`, `eidLookupCrmWorkflow`) converted.
5. Dashboard detail panel shows the searched name + resolved EmplID + department + job title (+ CRM match in CRM-on mode).

## Non-goals

- Changing the search logic (`searchByName`, `parseNameInput`, `searchCrmByName`).
- Changing the CLI surface (`tsx src/cli.ts eid-lookup <names...> [--workers N] [--no-crm] [--dry-run]` stays identical).
- Extending the new kernel mode beyond eid-lookup in this pass (no other workflow adopts it here).
- Modifying xlsx trackers in other workflows (onboarding, work-study, kronos-reports keep theirs per the grandfather clause in `src/workflows/CLAUDE.md`).

## Architecture

### New kernel mode: `shared-context-pool`

Add a third value to `BatchConfig.mode`: `"shared-context-pool"` (alongside `"sequential"` and `"pool"`).

```ts
// src/core/types.ts
export interface BatchConfig {
  mode: 'sequential' | 'pool' | 'shared-context-pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}
```

`runWorkflowBatch` grows a third dispatch branch:

```ts
// src/core/workflow.ts (sketch)
if (batch?.mode === 'pool') return runWorkflowPool(wf, items, opts)
if (batch?.mode === 'shared-context-pool') return runWorkflowSharedContextPool(wf, items, opts)
// ...sequential path
```

New file `src/core/shared-context-pool.ts` exporting `runWorkflowSharedContextPool<TData, TSteps>(wf, items, opts)`. Shape:

1. Validate all items upfront (Zod).
2. Pre-generate `itemId` + `runId` per item (using `opts.deriveItemId ?? deriveItemId`).
3. If `batch.preEmitPending && opts.onPreEmitPending`, emit `pending` rows upfront (pairing item↔runId). Same pattern as `runWorkflowPool`.
4. Launch ONE parent `Session` via `Session.launch(wf.config.systems, { authChain, tiling, launchFn, observer? })`. This runs auth ONCE for each system (1 Duo per system regardless of worker count).
   - Observer handling: the existing `buildSessionObserver` emits `running` for `auth:<id>` step names. Since `shared-context-pool` workflows use `authSteps: false` and emit items through `runOneItem` (which has its own observer path via `withTrackedWorkflow`), the parent `Session.launch` is called WITHOUT a per-item observer. Auth `running/failed` events land on no tracker entry — acceptable because those aren't per-item events. If an auth fails, `Session.launch` throws and the whole batch aborts before any item emits `running`.
5. Build N per-worker `Session` views. Each view holds its own pages-per-system (opened lazily from the parent's `BrowserContext`).
6. Worker loop: each worker pulls from the shared queue and calls `runOneItem({ session: workerSession, ... })` with the existing envelope (`withTrackedWorkflow` → `Stepper` → `Ctx` → handler).
7. On worker end: close all per-worker pages (not contexts/browsers). On batch end: parent `session.close()` closes contexts and browsers exactly once.

```ts
// src/core/shared-context-pool.ts (sketch)
export async function runWorkflowSharedContextPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = opts.poolSize ?? wf.config.batch?.poolSize ?? 4
  // validate + pre-generate perItem (itemId, runId) + optional preEmitPending
  // ...

  const parent = await Session.launch(wf.config.systems, {
    authChain: wf.config.authChain,
    tiling: wf.config.tiling,
    launchFn: opts.launchFn,
  })

  const queue = [...perItem]
  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  async function worker(): Promise<void> {
    const workerSession = await Session.forWorker(parent, wf.config.systems.map(s => s.id))
    try {
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) break
        const r = await runOneItem({
          wf, session: workerSession,
          item: next.item, itemId: next.itemId, runId: next.runId,
          trackerStub: opts.trackerStub, trackerDir: opts.trackerDir,
          callerPreEmits,
        })
        if (r.ok) result.succeeded++
        else { result.failed++; result.errors.push({ item: next.item, error: r.error }) }
      }
    } finally {
      await workerSession.closeWorkerPages()
    }
  }

  try {
    const workerCount = Math.min(poolSize, items.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    await parent.close()
  }
  return result
}
```

### `Session.forWorker(parent, systemIds)`

New public static factory on `Session`. Mirrors `Session.forTesting` in that it exposes the private constructor via a named factory. Implementation:

1. For each `systemId` in the list, locate the parent's `SystemSlot` for that system.
2. Open a NEW page on that system's existing `BrowserContext`: `const page = await slot.context.newPage()`.
3. Build a per-worker `SystemSlot { page, context: slot.context, browser: null }`. `browser: null` is the explicit signal to `Session.close` that this slot does not own the browser lifetime.
4. Construct a `SessionState { systems: parent.state.systems, browsers: <new map of per-worker slots>, readyPromises: <pre-resolved per system> }`.
5. Return the new `Session`.

Add a sibling method `Session.closeWorkerPages()` that iterates the per-worker slots and `page.close()`s each (no context close, no browser close). The existing `Session.close` already handles `browser: null` safely (`if (slot.browser) await slot.browser.close()`), so if a worker session is closed through `.close()` instead of `.closeWorkerPages()` nothing breaks; the new method just makes intent explicit.

Edge cases:
- `parent.state.browsers` lookup returns undefined (system not launched yet in interleaved mode) → `await parent.state.readyPromises.get(id)` first. Safer: have `forWorker` not pre-open pages; let `session.page(id)` open the page lazily on first handler access. This matches interleaved auth semantics (worker doesn't block on unreached systems).
- Concurrent `context.newPage()` from N workers — Playwright supports this natively.

Concretely the "lazy page-per-system-per-worker" shape:

```ts
// src/core/session.ts (sketch — new method)
static async forWorker(parent: Session, systemIds: string[]): Promise<Session> {
  const browsers = new Map<string, SystemSlot>()
  const readyPromises = new Map<string, Promise<void>>()
  for (const id of systemIds) {
    readyPromises.set(id, parent.state.readyPromises.get(id) ?? Promise.resolve())
  }
  // Use a Proxy-less approach: seed map with "lazy" slots that open page on first access.
  // Simpler: override page() on the worker Session. But since we can't subclass without
  // more invasive changes, go the explicit route: expose a `Session.forWorker` that
  // returns a Session with a populated-on-first-call map.
  const session = new Session({ systems: parent.state.systems, browsers, readyPromises })
  session.parent = parent  // stash parent ref for lazy page opens
  return session
}

async page(id: string): Promise<Page> {
  const ready = this.state.readyPromises.get(id)
  if (!ready) throw new Error(`unknown system: ${id}`)
  await ready
  let slot = this.state.browsers.get(id)
  if (!slot && this.parent) {
    // Lazy worker path: open a page on the parent's context for this system
    const parentSlot = this.parent.state.browsers.get(id)
    if (!parentSlot) throw new Error(`no parent browser for system: ${id}`)
    const page = await parentSlot.context.newPage()
    slot = { page, context: parentSlot.context, browser: null }
    this.state.browsers.set(id, slot)
  }
  if (!slot) throw new Error(`no browser for system: ${id}`)
  return slot.page
}
```

(Implementation will clean this up — the sketch above is for design clarity.)

### Type plumbing

- `BatchConfig.mode` literal union gains `"shared-context-pool"`. No runtime change to readers that don't know about it, but TypeScript callers with `batch: { mode: ... }` need this widened literal.
- `runWorkflowBatch` dispatch is a single extra `if`.
- `src/core/index.ts` exports `runWorkflowSharedContextPool`.

### eid-lookup workflow rewrite

#### Schema (per-item shape)

```ts
// src/workflows/eid-lookup/schema.ts
export const EidLookupItemSchema = z.object({ name: z.string().min(1) })
export type EidLookupItem = z.infer<typeof EidLookupItemSchema>
```

Old batch-shape schemas (`EidLookupInputSchema { names, workers }`) stay exported for CLI-adapter use only.

#### Workflow definition

Two `defineWorkflow` variants share one handler body:

```ts
const stepsNoCrm = ["searching"] as const
const stepsCrm   = ["searching", "cross-verification"] as const

const sharedDetailFields = [
  { key: "searchName", label: "Search" },
  { key: "emplId",     label: "EID" },
  { key: "department", label: "Dept" },
  { key: "jobTitle",   label: "Title" },
  // CRM-on adds:
  { key: "crmMatch",   label: "CRM Match" },
]

export const eidLookupWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [{ id: "ucpath", login: wrapLogin(loginToUCPath) }],
  authSteps: false,
  steps: stepsNoCrm,
  schema: EidLookupItemSchema,
  authChain: "sequential",
  tiling: "single",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: sharedDetailFields,
  getName: (d) => d.searchName ?? "",
  getId:   (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx, input) => {
    ctx.updateData({ searchName: input.name })
    await ctx.step("searching", async () => {
      const page = await ctx.page("ucpath")
      const result = await searchByName(page, input.name)
      if (result.sdcmpResults.length === 0) {
        ctx.updateData({ emplId: "Not found" })
        return
      }
      const first = result.sdcmpResults[0]
      ctx.updateData({
        emplId: first.emplId,
        department: first.department ?? "",
        jobTitle: first.jobCodeDescription ?? "",
      })
    })
  },
})
```

CRM-on variant adds `{ id: "crm", login: wrapLogin(loginToACTCrm) }` to `systems`, `stepsCrm` to steps, and a `ctx.step("cross-verification", ...)` call in the handler that:
- Opens `await ctx.page("crm")` (first call allocates a per-worker CRM tab from the shared context).
- `searchCrmByName(crmPage, lastName, first)` + `datesWithinDays(...)`.
- `ctx.updateData({ crmMatch: "direct" | "date" | "none" })`.

Multi-result SDCMP hits for one name: flattened — only the first SDCMP result drives detail fields; the full list lives in the step's log output (same `log.success(...)` calls as today). If we discover we need the full list in the dashboard, we add a `results` text blob field later.

#### CLI adapter

```ts
// src/workflows/eid-lookup/workflow.ts — runEidLookup
export async function runEidLookup(names: string[], options: EidLookupOptions = {}) {
  if (names.length === 0) { log.error(...); process.exit(1) }
  const useCrm = options.useCrm !== false
  const workers = options.workers ?? Math.min(names.length, 4)

  if (options.dryRun) { /* unchanged */ return }

  // Dedupe duplicate names — shared-context-pool derives itemId from name.
  const seen = new Set<string>()
  const items: EidLookupItem[] = []
  for (const n of names) {
    if (seen.has(n)) { log.warn(`Duplicate name skipped: "${n}"`); continue }
    seen.add(n); items.push({ name: n })
  }

  const wf = useCrm ? eidLookupCrmWorkflow : eidLookupWorkflow
  const now = new Date().toISOString()

  const result = await runWorkflowBatch(wf, items, {
    poolSize: workers,
    deriveItemId: (item) => (item as EidLookupItem).name,
    onPreEmitPending: (item, runId) => {
      const n = (item as EidLookupItem).name
      trackEvent({
        workflow: "eid-lookup", timestamp: now, id: n, runId,
        status: "pending",
        data: { searchName: n, __name: n, __id: n },
      })
    },
  })

  log.success(`EID lookup: ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`)
}
```

#### Excel removal

- Delete `src/workflows/eid-lookup/tracker.ts`.
- Delete `src/workflows/eid-lookup/eid-lookup-tracker.xlsx`.
- Remove `updateEidTracker` from `src/workflows/eid-lookup/index.ts` barrel.
- Remove `Mutex`, `lockedUpdateEidTracker`, `runSearchingPhase` from `workflow.ts`.
- Remove `async-mutex` import from `workflow.ts` (not used elsewhere in eid-lookup; leave root dependency alone since other workflows use it).
- Remove mention of `updateEidTracker` from root `CLAUDE.md` "Obsolete patterns" xlsx list and EID Lookup data-flow diagram.
- Update `src/workflows/eid-lookup/CLAUDE.md`:
  - Remove the "Acceptable regression" H2 section entirely.
  - Rewrite the "Data Flow" block for per-name items.
  - Update "Files" table: remove `tracker.ts`, note the shared-context-pool mode.
  - Update "Kernel Config" table: new `batch` row, updated `steps` row, updated `detailFields`.
  - Replace the "Worker pool semantics" section with a shorter "Shared-context pool semantics" block.
  - Add a Lessons Learned entry dated 2026-04-21.
- `docs/architecture-deep-dive.md` already has uncommitted edits — reconcile with the new reality (no xlsx for eid-lookup).

### Dashboard / root CLAUDE.md

- Step tracking table: change `ucpath-auth → searching (+ crm-auth → cross-verification in CRM mode)` to `searching (+ cross-verification in CRM mode)` — per-item auth rows are gone.
- No frontend edits — dashboard reads step/label metadata from the server-side registry populated by `defineWorkflow`.

### Tests

#### `tests/unit/core/shared-context-pool.test.ts` (new)

Mirrors the shape of `tests/unit/core/pool.test.ts`:

1. **Single `launchFn` call across all workers.** `launchFn` injection counter = 1 regardless of N. Distinct from `runWorkflowPool` where `launchCalls === workerCount`.
2. **Per-item tracker rows emitted.** With a real `trackerDir`: 2 items × (pending + running + done) = ≥6 entries, distinct `runId`s per item.
3. **`preEmitPending` pairs item↔runId.** As in pool.test.ts.
4. **Per-worker page isolation.** Hand-rolled fake context with a `newPage` counter; two-item run on pool size 2 produces two distinct page identities, `newPage` called N times.
5. **`opts.poolSize` override wins over `batch.poolSize`.**
6. **`initialData` seeds per-item pending rows.**
7. **Parent `Session.close` called exactly once at batch end.** (Track `close` calls.)

#### `tests/unit/workflows/eid-lookup/workflow.test.ts` (new)

1. **Dedupe.** `runEidLookup(["a", "b", "a"])` yields 2 items + one warn log.
2. **Dry-run output.** Logs expected preview, no kernel call.
3. **CRM vs no-CRM routing.** `useCrm: false` uses `eidLookupWorkflow`; default uses `eidLookupCrmWorkflow`.
4. **`poolSize` forwarded** as `workers`.

#### Inline-selectors guard

Stays green — eid-lookup touches no selectors.

## Error handling

- Per-name search failure: `ctx.step("searching", ...)` rethrows → `runOneItem` catches → `failed` tracker row → worker loop continues to next queue item (existing `runOneItem` semantics — no new plumbing needed).
- Worker-page crashes mid-run: step throws on `context.newPage()` failure → same path as above. Other workers unaffected; the shared context stays intact.
- Parent auth failure: `Session.launch` throws → whole batch aborts; pending rows stay `pending` forever until they time out on the dashboard (pre-existing behavior for `Session.launch` failures — not changed here).
- Duplicate names in CLI input: deduped at adapter with a warn log.
- Ctrl+C: parent `Session.close` in the `finally` block ensures contexts close. SIGINT handling lives in `withTrackedWorkflow` per-item and is unchanged.

## Migration

Single commit strategy: kernel addition + workflow rewrite + Excel removal + doc updates together. Not a breaking change for any other workflow (new batch mode is additive; existing workflows don't use it).

## Verification

- `npm run typecheck:all` clean.
- `npm run test` green (existing suite + new shared-context-pool tests + new eid-lookup adapter tests).
- Dry-run: `./node_modules/.bin/tsx --env-file=.env src/cli.ts eid-lookup --dry-run "Name 1" "Name 2" "Name 3"` still prints 3 planned names.
- Inline-selectors guard green (`tests/unit/systems/inline-selectors.test.ts`).
- Grep verification: no `updateEidTracker` / `updateEidTrackerNotFound` / `eid-lookup-tracker.xlsx` references anywhere in `src/`.
- Live run deferred (UCPath/CRM Duo can't be approved this session).

## Open questions

None — all trade-offs pre-decided. If live run reveals that per-item CRM tabs trigger rate-limits, revert cross-verification to a post-pool pass (15-line change). That's a future-run concern, not a blocker for this design.
