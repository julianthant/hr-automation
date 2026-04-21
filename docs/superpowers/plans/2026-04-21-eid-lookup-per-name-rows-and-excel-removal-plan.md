# EID Lookup Per-Name Rows + Shared-Context Pool + Excel Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one JSONL row per searched name in eid-lookup by adding a kernel `shared-context-pool` batch mode, rewriting the eid-lookup handler to process one name per kernel item, and removing the workflow's xlsx tracker entirely.

**Architecture:** Four phases in order. Phase A extends the kernel: new `batch.mode: "shared-context-pool"`, `Session.forWorker` + lazy per-worker pages, `runWorkflowSharedContextPool` reusing `runOneItem`. Phase B rewrites eid-lookup around `TData = { name: string }` with both CRM-off and CRM-on variants sharing one handler body. Phase C removes the xlsx tracker (file, module, barrel export, callers, grep references). Phase D updates the workflow + root CLAUDE.md + the architecture deep-dive.

**Tech Stack:** TypeScript, Node 24, Playwright, Vitest (via `node:test`), Zod v4 (separations) / Zod v3 (eid-lookup — keep existing `zod` import), `defineWorkflow` kernel in `src/core/`.

**Reference spec:** `docs/superpowers/specs/2026-04-21-eid-lookup-per-name-rows-and-excel-removal-design.md` — read before starting a phase.

---

## File Structure

### Created
- `src/core/shared-context-pool.ts` — new `runWorkflowSharedContextPool` (A.3)
- `tests/unit/core/shared-context-pool.test.ts` — kernel mode tests (A.1, A.2, A.3 partials)
- `tests/unit/workflows/eid-lookup/workflow.test.ts` — CLI adapter tests (B.4)

### Modified
- `src/core/types.ts` — `BatchConfig.mode` adds `"shared-context-pool"` (A.1)
- `src/core/session.ts` — new `forWorker` factory, `parent` private field, lazy `page` branch, `closeWorkerPages` method (A.2)
- `src/core/workflow.ts` — `runWorkflowBatch` dispatches new mode (A.3)
- `src/core/index.ts` — export `runWorkflowSharedContextPool` (A.3)
- `src/workflows/eid-lookup/schema.ts` — add `EidLookupItemSchema` (B.1)
- `src/workflows/eid-lookup/workflow.ts` — rewrite: single-name handler, CLI adapter dedupes and dispatches batch, drop mutex + `runSearchingPhase` + Excel calls (B.2, B.3, C.2)
- `src/workflows/eid-lookup/index.ts` — drop `updateEidTracker` export (C.1)
- `src/workflows/eid-lookup/CLAUDE.md` — rewrite data flow, drop "Acceptable regression", update Files/Kernel Config/Gotchas, new Lesson Learned (D.1)
- `CLAUDE.md` (root) — step tracking table row, obsolete patterns xlsx list, EID lookup data flow block (D.2)
- `docs/architecture-deep-dive.md` — reconcile uncommitted edits with new reality (D.3)

### Deleted
- `src/workflows/eid-lookup/tracker.ts` (C.1)
- `src/workflows/eid-lookup/eid-lookup-tracker.xlsx` (C.1)

### Kept unchanged (validate with greps)
- `src/workflows/eid-lookup/search.ts`, `crm-search.ts` — kernel-agnostic search logic, no edits
- Other workflows' `tracker.ts` files (grandfather clause)
- `tests/unit/systems/inline-selectors.test.ts` — must stay green

---

## Phase A — Kernel: shared-context pool mode

### Task A.1: Widen `BatchConfig.mode` with `"shared-context-pool"`

**Files:**
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write the failing test** — `tests/unit/core/shared-context-pool.test.ts` (create file)

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'

test('BatchConfig.mode accepts "shared-context-pool" literal', () => {
  // Type-level: this must compile. Runtime assertion is trivial — the compile-gate is the test.
  const wf = defineWorkflow({
    name: 'scp-type-probe',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    handler: async () => {},
  })
  assert.equal(wf.config.batch?.mode, 'shared-context-pool')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run typecheck:all 2>&1 | grep shared-context-pool`
Expected: TS error on `'shared-context-pool'` literal not assignable to `'sequential' | 'pool'`.

- [ ] **Step 3: Widen the union**

In `src/core/types.ts`, change:

```ts
export interface BatchConfig {
  mode: 'sequential' | 'pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}
```

to:

```ts
export interface BatchConfig {
  mode: 'sequential' | 'pool' | 'shared-context-pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck:all` → clean.
Run: `./node_modules/.bin/tsx --test tests/unit/core/shared-context-pool.test.ts`
Expected: the type-probe test passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts tests/unit/core/shared-context-pool.test.ts
git commit -m "feat(core): add 'shared-context-pool' to BatchConfig.mode"
```

---

### Task A.2: `Session.forWorker` + lazy per-worker page allocation + `closeWorkerPages`

**Files:**
- Modify: `src/core/session.ts`
- Test: `tests/unit/core/shared-context-pool.test.ts` (add to existing file)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/core/shared-context-pool.test.ts`:

```ts
import { Session } from '../../../src/core/session.js'

function fakeContext() {
  const pages: Array<{ closed: boolean; id: number }> = []
  let nextId = 1
  return {
    newPage: async () => {
      const p = { closed: false, id: nextId++, isClosed: () => p.closed, close: async () => { p.closed = true } } as any
      pages.push(p)
      return p
    },
    close: async () => {},
    _pages: pages,
  }
}

test('Session.forWorker creates a Session that lazily opens a page on first page(id) call', async () => {
  const ctx = fakeContext()
  const parentPage = { bringToFront: async () => {}, close: async () => {} } as any
  const parent = Session.forTesting({
    systems: [{ id: 'sys', login: async () => {} }] as any,
    browsers: new Map([['sys', { page: parentPage, browser: null as any, context: ctx as any }]]),
    readyPromises: new Map([['sys', Promise.resolve()]]),
  })
  const worker = Session.forWorker(parent)
  assert.equal(ctx._pages.length, 0, 'forWorker must not open pages eagerly')
  const p1 = await worker.page('sys')
  assert.equal(ctx._pages.length, 1, 'first page(id) opens one page')
  const p2 = await worker.page('sys')
  assert.strictEqual(p1, p2, 'repeated page(id) returns the cached page')
})

test('Session.forWorker: different worker sessions get distinct pages from shared context', async () => {
  const ctx = fakeContext()
  const parent = Session.forTesting({
    systems: [{ id: 'sys', login: async () => {} }] as any,
    browsers: new Map([['sys', { page: {} as any, browser: null as any, context: ctx as any }]]),
    readyPromises: new Map([['sys', Promise.resolve()]]),
  })
  const w1 = Session.forWorker(parent)
  const w2 = Session.forWorker(parent)
  const p1 = await w1.page('sys')
  const p2 = await w2.page('sys')
  assert.notStrictEqual(p1, p2, 'distinct worker pages')
  assert.equal(ctx._pages.length, 2)
})

test('Session.closeWorkerPages closes only the worker-opened pages', async () => {
  const ctx = fakeContext()
  const parent = Session.forTesting({
    systems: [{ id: 'sys', login: async () => {} }] as any,
    browsers: new Map([['sys', { page: {} as any, browser: null as any, context: ctx as any }]]),
    readyPromises: new Map([['sys', Promise.resolve()]]),
  })
  const worker = Session.forWorker(parent)
  const p = await worker.page('sys') as any
  await worker.closeWorkerPages()
  assert.equal(p.closed, true)
})

test('Session.forWorker throws on unknown system ids', async () => {
  const ctx = fakeContext()
  const parent = Session.forTesting({
    systems: [{ id: 'sys', login: async () => {} }] as any,
    browsers: new Map([['sys', { page: {} as any, browser: null as any, context: ctx as any }]]),
    readyPromises: new Map([['sys', Promise.resolve()]]),
  })
  const worker = Session.forWorker(parent)
  await assert.rejects(() => worker.page('nope'), /unknown system/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/tsx --test tests/unit/core/shared-context-pool.test.ts`
Expected: FAIL — `Session.forWorker is not a function` / `worker.closeWorkerPages is not a function`.

- [ ] **Step 3: Implement in `src/core/session.ts`**

Inside the `Session` class, add a private `parent` field and a static factory + `closeWorkerPages` method, and widen `page(id)` with a lazy-worker branch.

At the top of the class declaration, near `private constructor`, add:

```ts
private parent: Session | null = null
```

Add the static factory (after `forTesting`):

```ts
/**
 * Build a per-worker Session view on top of an already-launched parent.
 * Pages are allocated lazily on first `page(id)` call — each worker gets
 * its own Playwright Page opened against the parent's per-system
 * BrowserContext. `browser: null` on each worker slot signals that the
 * worker does not own the browser lifetime; `close()` won't double-close.
 * Use `closeWorkerPages()` in the worker's `finally` block.
 */
static forWorker(parent: Session): Session {
  const browsers = new Map<string, SystemSlot>()
  const readyPromises = new Map(parent.state.readyPromises)
  const session = new Session({ systems: parent.state.systems, browsers, readyPromises })
  session.parent = parent
  return session
}
```

Replace the existing `async page(id: string)` method with:

```ts
async page(id: string): Promise<Page> {
  const ready = this.state.readyPromises.get(id)
  if (!ready) throw new Error(`unknown system: ${id}`)
  await ready
  let slot = this.state.browsers.get(id)
  if (!slot && this.parent) {
    const parentSlot = this.parent.state.browsers.get(id)
    if (!parentSlot) throw new Error(`no browser for system: ${id}`)
    const page = await parentSlot.context.newPage()
    slot = { page, context: parentSlot.context, browser: null }
    this.state.browsers.set(id, slot)
  }
  if (!slot) throw new Error(`no browser for system: ${id}`)
  return slot.page
}
```

Add a sibling method right after `close()`:

```ts
/**
 * Close every page this worker-session opened (from Session.forWorker).
 * Contexts and browsers belong to the parent — left untouched.
 * Best-effort: a close failure on one page never blocks the siblings.
 */
async closeWorkerPages(): Promise<void> {
  for (const slot of this.state.browsers.values()) {
    try {
      if (!slot.page.isClosed()) await slot.page.close()
    } catch { /* best-effort */ }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./node_modules/.bin/tsx --test tests/unit/core/shared-context-pool.test.ts`
Expected: all four new tests + the Task A.1 test pass.
Run: `npm run typecheck:all` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/session.ts tests/unit/core/shared-context-pool.test.ts
git commit -m "feat(core): Session.forWorker + lazy per-worker pages + closeWorkerPages"
```

---

### Task A.3: `runWorkflowSharedContextPool` + `runWorkflowBatch` dispatch + export

**Files:**
- Create: `src/core/shared-context-pool.ts`
- Modify: `src/core/workflow.ts`, `src/core/index.ts`
- Test: `tests/unit/core/shared-context-pool.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/core/shared-context-pool.test.ts`:

```ts
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorkflowBatch } from '../../../src/core/workflow.js'
import { runWorkflowSharedContextPool } from '../../../src/core/shared-context-pool.js'

function readTrackerEntries(dir: string, workflow: string): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(dir, `${workflow}-${today}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function cleanupDir(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

function sharedContextLaunchFn() {
  let launchCalls = 0
  const pagesOpened: any[] = []
  const sharedCtx = {
    newPage: async () => {
      const p = {
        id: pagesOpened.length + 1,
        closed: false,
        isClosed() { return this.closed },
        async close() { this.closed = true },
        async bringToFront() {},
      } as any
      pagesOpened.push(p)
      return p
    },
    close: async () => {},
  }
  const fn = () => {
    launchCalls++
    return Promise.resolve({
      page: { bringToFront: async () => {}, close: async () => {} } as any,
      context: sharedCtx as any,
      browser: { close: async () => {} } as any,
    })
  }
  return { fn, get launchCalls() { return launchCalls }, pagesOpened }
}

test('runWorkflowSharedContextPool: one launchFn call regardless of worker count', async () => {
  const instr = sharedContextLaunchFn()
  const wf = defineWorkflow({
    name: 'scp-one-launch',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 3 },
    handler: async (ctx) => { await ctx.step('s1', async () => { await ctx.page('sys') }) },
  })
  const items = Array.from({ length: 6 }, (_, i) => ({ n: i }))
  const result = await runWorkflowSharedContextPool(wf, items, {
    launchFn: instr.fn, trackerStub: true,
  })
  assert.equal(result.succeeded, 6)
  assert.equal(instr.launchCalls, 1, 'parent Session launches once for the whole pool')
})

test('runWorkflowSharedContextPool: N items produce N distinct tracker runIds', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'scp-tracker-'))
  const instr = sharedContextLaunchFn()
  const wfName = `scp-rows-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    handler: async (ctx) => { await ctx.step('only', async () => { await ctx.page('sys') }) },
  })
  const result = await runWorkflowSharedContextPool(wf, [{ k: 'a' }, { k: 'b' }, { k: 'c' }], {
    launchFn: instr.fn, trackerDir: tmp,
  })
  assert.equal(result.succeeded, 3)
  const entries = readTrackerEntries(tmp, wfName)
  const runIds = new Set(entries.map((e) => e.runId as string))
  assert.equal(runIds.size, 3, 'one runId per item')
  const pending = entries.filter((e) => e.status === 'pending')
  const done = entries.filter((e) => e.status === 'done')
  assert.equal(pending.length, 3)
  assert.equal(done.length, 3)
  cleanupDir(tmp)
})

test('runWorkflowSharedContextPool: preEmitPending pairs item with runId', async () => {
  const instr = sharedContextLaunchFn()
  const pendingEmissions: Array<{ k: string; runId: string }> = []
  const wf = defineWorkflow({
    name: 'scp-preEmit',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ k: z.string() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 2, preEmitPending: true },
    handler: async (ctx) => { await ctx.step('s1', async () => { await ctx.page('sys') }) },
  })
  await runWorkflowSharedContextPool(wf, [{ k: 'a' }, { k: 'b' }, { k: 'c' }], {
    launchFn: instr.fn, trackerStub: true,
    onPreEmitPending: (item, runId) =>
      pendingEmissions.push({ k: (item as { k: string }).k, runId }),
  })
  assert.deepEqual(pendingEmissions.map((e) => e.k), ['a', 'b', 'c'])
  assert.equal(new Set(pendingEmissions.map((e) => e.runId)).size, 3)
})

test('runWorkflowSharedContextPool: each worker gets distinct pages from shared context', async () => {
  const instr = sharedContextLaunchFn()
  const pageIdsSeen: number[] = []
  const wf = defineWorkflow({
    name: 'scp-distinct',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 3 },
    handler: async (ctx) => {
      await ctx.step('s1', async () => {
        const p = await ctx.page('sys') as any
        pageIdsSeen.push(p.id)
        await new Promise((r) => setTimeout(r, 5))
      })
    },
  })
  const items = Array.from({ length: 6 }, (_, i) => ({ n: i }))
  await runWorkflowSharedContextPool(wf, items, { launchFn: instr.fn, trackerStub: true })
  assert.ok(instr.pagesOpened.length >= 3, 'at least N worker pages opened')
  assert.ok(instr.pagesOpened.length <= 6, 'at most one page per item worst case')
})

test('runWorkflowSharedContextPool: opts.poolSize overrides batch.poolSize', async () => {
  const instr = sharedContextLaunchFn()
  let maxConcurrent = 0
  let current = 0
  const wf = defineWorkflow({
    name: 'scp-poolSize-override',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    handler: async (ctx) => {
      await ctx.step('s1', async () => {
        current++; maxConcurrent = Math.max(maxConcurrent, current)
        await new Promise((r) => setTimeout(r, 10))
        current--
      })
    },
  })
  await runWorkflowSharedContextPool(wf, Array.from({ length: 10 }, (_, i) => ({ n: i })), {
    launchFn: instr.fn, trackerStub: true, poolSize: 5,
  })
  assert.ok(maxConcurrent >= 3, `expected >=3 concurrent workers with poolSize=5, got ${maxConcurrent}`)
  assert.ok(maxConcurrent <= 5)
})

test('runWorkflowBatch dispatches shared-context-pool mode', async () => {
  const instr = sharedContextLaunchFn()
  const wf = defineWorkflow({
    name: 'scp-dispatch',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    handler: async (ctx) => { await ctx.step('s1', async () => { await ctx.page('sys') }) },
  })
  const result = await runWorkflowBatch(wf, [{ n: 1 }, { n: 2 }, { n: 3 }], {
    launchFn: instr.fn, trackerStub: true,
  })
  assert.equal(result.succeeded, 3)
  assert.equal(instr.launchCalls, 1)
})

test('runWorkflowSharedContextPool: handler throws → item fails, batch continues', async () => {
  const instr = sharedContextLaunchFn()
  const wf = defineWorkflow({
    name: 'scp-partial-fail',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ k: z.string() }),
    authSteps: false,
    batch: { mode: 'shared-context-pool', poolSize: 2 },
    handler: async (ctx, input) => {
      await ctx.step('s1', async () => {
        if (input.k === 'bad') throw new Error('nope')
        await ctx.page('sys')
      })
    },
  })
  const result = await runWorkflowSharedContextPool(
    wf,
    [{ k: 'a' }, { k: 'bad' }, { k: 'c' }],
    { launchFn: instr.fn, trackerStub: true },
  )
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./node_modules/.bin/tsx --test tests/unit/core/shared-context-pool.test.ts`
Expected: FAIL — cannot import `runWorkflowSharedContextPool` from `src/core/shared-context-pool.js`.

- [ ] **Step 3: Create `src/core/shared-context-pool.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { deriveItemId, runOneItem } from './workflow.js'

interface PoolItem<TData> {
  item: TData
  itemId: string
  runId: string
}

/**
 * Run N workflow items concurrently against a SINGLE authenticated Session:
 * one browser + context per system (one Duo per system), N per-worker Pages
 * spawned lazily from each system's BrowserContext. Each item gets its own
 * `withTrackedWorkflow` envelope via the shared `runOneItem`, so the dashboard
 * shows one row per item with its own step timing.
 *
 * Use when parallelism is desired but launching per-worker Sessions would
 * re-trigger Duo on every worker (e.g. eid-lookup's N-tab fan-out from one
 * UCPath auth).
 */
export async function runWorkflowSharedContextPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = opts.poolSize ?? wf.config.batch?.poolSize ?? 4

  // 1. Validate all items upfront.
  items.forEach((item) => {
    try {
      wf.config.schema.parse(item)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // 2. Pre-generate itemId + runId per item (matches runWorkflowPool).
  const itemIdFn = opts.deriveItemId ?? ((item: unknown) => deriveItemId(item, randomUUID()))
  const perItem: PoolItem<TData>[] = items.map((item) => ({
    item,
    itemId: itemIdFn(item),
    runId: randomUUID(),
  }))

  // 3. Optional upfront pending emit (paired runIds).
  const callerPreEmits = Boolean(wf.config.batch?.preEmitPending && opts.onPreEmitPending)
  if (callerPreEmits) {
    for (const { item, runId } of perItem) opts.onPreEmitPending!(item, runId)
  }

  // 4. Launch ONE parent Session. 1 auth per system.
  const parent = await Session.launch(wf.config.systems, {
    authChain: wf.config.authChain,
    tiling: wf.config.tiling,
    launchFn: opts.launchFn,
  })

  const queue: PoolItem<TData>[] = [...perItem]
  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  async function worker(): Promise<void> {
    const session = Session.forWorker(parent)
    try {
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) break
        const { item, itemId, runId } = next
        const r = await runOneItem({
          wf, session, item, itemId, runId,
          trackerStub: opts.trackerStub,
          trackerDir: opts.trackerDir,
          callerPreEmits,
        })
        if (r.ok) result.succeeded++
        else { result.failed++; result.errors.push({ item, error: r.error }) }
      }
    } finally {
      await session.closeWorkerPages()
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

- [ ] **Step 4: Wire the dispatch in `runWorkflowBatch`**

In `src/core/workflow.ts`, change the first lines of `runWorkflowBatch`:

```ts
export async function runWorkflowBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts & { dryRun?: boolean } = {},
): Promise<BatchResult> {
  const batch = wf.config.batch
  if (batch?.mode === 'pool') {
    return runWorkflowPool(wf, items, opts)
  }
  if (batch?.mode === 'shared-context-pool') {
    return runWorkflowSharedContextPool(wf, items, opts)
  }
  // ... existing sequential path
```

Add the import at the top of `src/core/workflow.ts`:

```ts
import { runWorkflowSharedContextPool } from './shared-context-pool.js'
```

- [ ] **Step 5: Export from `src/core/index.ts`**

In `src/core/index.ts`, change:

```ts
export { runWorkflowPool } from './pool.js'
```

to:

```ts
export { runWorkflowPool } from './pool.js'
export { runWorkflowSharedContextPool } from './shared-context-pool.js'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `./node_modules/.bin/tsx --test tests/unit/core/shared-context-pool.test.ts`
Expected: all tests pass.
Run: `npm run typecheck:all` → clean.
Run: `npm run test` → all existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/core/shared-context-pool.ts src/core/workflow.ts src/core/index.ts tests/unit/core/shared-context-pool.test.ts
git commit -m "feat(core): runWorkflowSharedContextPool batch mode

One Session.launch for the whole pool (1 Duo per system); N workers
share the system's BrowserContext with lazy per-worker page allocation.
Per-item tracker rows via the shared runOneItem envelope."
```

---

## Phase B — eid-lookup workflow rewrite

### Task B.1: Add `EidLookupItemSchema` + keep batch-shape schemas

**Files:**
- Modify: `src/workflows/eid-lookup/schema.ts`

- [ ] **Step 1: Write the failing assertion** (inline into task B.4's test file, but let the typecheck be the first gate)

This task is a simple add-new-export. Test is deferred to B.4; for now the gate is typecheck success after B.2 consumes the new schema.

- [ ] **Step 2: Add the new schema + type**

In `src/workflows/eid-lookup/schema.ts`, append:

```ts
/** Per-item shape for the shared-context-pool batch mode (one name per kernel item). */
export const EidLookupItemSchema = z.object({
  name: z.string().min(1),
});

export type EidLookupItem = z.infer<typeof EidLookupItemSchema>;
```

Keep the existing `EidLookupInputSchema { names, workers }` alias and `EidLookupCrmInputSchema` untouched — they stay exported for CLI-adapter backward compatibility.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:all` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/eid-lookup/schema.ts
git commit -m "feat(eid-lookup): add EidLookupItemSchema for per-name batch items"
```

---

### Task B.2: Rewrite `workflow.ts` — per-name handler + both CRM variants + CLI adapter

**Files:**
- Modify: `src/workflows/eid-lookup/workflow.ts`

- [ ] **Step 1: Replace file contents entirely**

Overwrite `src/workflows/eid-lookup/workflow.ts` with:

```ts
/**
 * EID Lookup workflow: search employees by name in parallel tabs.
 *
 * Kernel-based (shared-context-pool mode). Each CLI invocation launches one
 * UCPath browser (+ CRM browser in CRM mode), authenticates once per system,
 * then fans out N names across N tabs in each shared BrowserContext. Each
 * name is a separate kernel item so the dashboard shows one row per name.
 */

import { defineWorkflow, runWorkflowBatch } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../auth/login.js";
import { searchByName, parseNameInput, type EidResult } from "./search.js";
import { searchCrmByName, datesWithinDays } from "./crm-search.js";
import {
  EidLookupItemSchema,
  type EidLookupItem,
} from "./schema.js";

export interface EidLookupOptions {
  /** Number of parallel browser tabs. Default: min(names.length, 4). */
  workers?: number;
  /** Whether to run CRM cross-verification. Default: true. */
  useCrm?: boolean;
  /** Preview the planned name list without launching a browser. */
  dryRun?: boolean;
}

export interface LookupResult {
  name: string;
  found: boolean;
  sdcmpResults: EidResult[];
  error?: string;
}

const stepsNoCrm = ["searching"] as const;
const stepsCrm = ["searching", "cross-verification"] as const;

const sharedDetailFields = [
  { key: "searchName", label: "Search" },
  { key: "emplId", label: "EID" },
  { key: "department", label: "Dept" },
  { key: "jobTitle", label: "Title" },
] as const;

const crmDetailFields = [
  ...sharedDetailFields,
  { key: "crmMatch", label: "CRM Match" },
] as const;

/**
 * Perform the UCPath SDCMP/HDH search for one name and stamp the result
 * fields onto the tracker entry's data. Returns the raw results so the
 * CRM step can cross-reference them.
 */
async function searchingStep(
  ctx: import("../../core/types.js").Ctx<readonly string[], EidLookupItem>,
  input: EidLookupItem,
): Promise<EidResult[]> {
  const page = await ctx.page("ucpath");
  const result = await searchByName(page, input.name);
  if (result.sdcmpResults.length === 0) {
    log.step(`No SDCMP results for "${input.name}"`);
    ctx.updateData({ emplId: "Not found" });
    return [];
  }
  const first = result.sdcmpResults[0];
  log.success(
    `Found ${result.sdcmpResults.length} result(s) for "${input.name}": EID ${first.emplId} | ${first.department ?? "?"} | ${first.jobCodeDescription}`,
  );
  ctx.updateData({
    emplId: first.emplId,
    department: first.department ?? "",
    jobTitle: first.jobCodeDescription ?? "",
  });
  return result.sdcmpResults;
}

/**
 * Cross-verify one name against CRM. Emits crmMatch as one of:
 *  - "direct" — UCPath EID matched a CRM record's UCPath EID
 *  - "date"   — UCPath effective date matched a CRM firstDayOfService (±7d)
 *  - "none"   — CRM returned records but none matched
 *  - ""       — CRM returned no records for this name
 */
async function crossVerificationStep(
  ctx: import("../../core/types.js").Ctx<readonly string[], EidLookupItem>,
  input: EidLookupItem,
  sdcmp: EidResult[],
): Promise<void> {
  const crmPage = await ctx.page("crm");

  let parsed: ReturnType<typeof parseNameInput>;
  try {
    parsed = parseNameInput(input.name);
  } catch (err) {
    log.error(`CRM cross-verify: invalid name "${input.name}" — ${errorMessage(err)}`);
    ctx.updateData({ crmMatch: "" });
    return;
  }

  let crmRecords: Awaited<ReturnType<typeof searchCrmByName>> = [];
  try {
    crmRecords = await searchCrmByName(crmPage, parsed.lastName, parsed.first);
  } catch (err) {
    log.error(`CRM cross-verify: search failed for "${input.name}" — ${errorMessage(err)}`);
    ctx.updateData({ crmMatch: "" });
    return;
  }

  if (crmRecords.length === 0) {
    log.step(`CRM: no records for "${input.name}"`);
    ctx.updateData({ crmMatch: "" });
    return;
  }

  for (const crec of crmRecords) {
    if (crec.ucpathEmployeeId) {
      const match = sdcmp.find((r) => r.emplId === crec.ucpathEmployeeId);
      if (match) {
        log.success(`Direct EID match: ${match.emplId} — ${match.department}`);
        ctx.updateData({ crmMatch: "direct" });
        return;
      }
    }
  }

  for (const crec of crmRecords) {
    const crmDate = crec.firstDayOfService;
    if (!crmDate) continue;
    for (const ucRec of sdcmp) {
      const ucDate = ucRec.effectiveDate;
      if (!ucDate) continue;
      if (datesWithinDays(crmDate, ucDate, 7)) {
        log.success(`Date match: CRM "${crmDate}" ≈ UCPath "${ucDate}" → EID ${ucRec.emplId}`);
        ctx.updateData({ crmMatch: "date" });
        return;
      }
    }
  }

  ctx.updateData({ crmMatch: "none" });
}

/**
 * No-CRM kernel definition. One UCPath system, one step per item.
 * Each item = one searched name; shared-context-pool fans out N tabs
 * against a single UCPath browser + Duo auth.
 */
export const eidLookupWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: stepsNoCrm,
  schema: EidLookupItemSchema,
  tiling: "single",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [...sharedDetailFields],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx, input) => {
    ctx.updateData({ searchName: input.name });
    await ctx.step("searching", async () => {
      await searchingStep(ctx, input);
    });
  },
});

/**
 * CRM-on kernel definition. Two systems (UCPath + CRM), two handler steps.
 * Each item = one searched name with its own UCPath tab AND its own CRM tab.
 * Sequential auth chain — Duo ×1 UCPath then ×1 CRM, once for the whole pool.
 */
export const eidLookupCrmWorkflow = defineWorkflow({
  name: "eid-lookup",
  label: "EID Lookup",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
    {
      id: "crm",
      login: async (page, instance) => {
        const ok = await loginToACTCrm(page, instance);
        if (!ok) throw new Error("CRM authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: stepsCrm,
  schema: EidLookupItemSchema,
  tiling: "auto",
  authChain: "sequential",
  batch: { mode: "shared-context-pool", poolSize: 4, preEmitPending: true },
  detailFields: [...crmDetailFields],
  getName: (d) => d.searchName ?? "",
  getId: (d) => d.searchName ?? "",
  initialData: (input) => ({ searchName: input.name }),
  handler: async (ctx, input) => {
    ctx.updateData({ searchName: input.name });
    const sdcmp = await ctx.step("searching", async () => searchingStep(ctx, input));
    await ctx.step("cross-verification", async () => {
      await crossVerificationStep(ctx, input, sdcmp);
    });
  },
});

/**
 * Dedupe preserving first-seen order. Duplicate names collide on the
 * name-derived itemId (`deriveItemId: item => item.name`); dedupe at
 * the CLI boundary so the kernel never sees two items with the same id.
 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (seen.has(n)) {
      log.warn(`Duplicate name skipped: "${n}"`);
      continue;
    }
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * CLI adapter for `tsx src/cli.ts eid-lookup <names...>`.
 *
 *   1. Validate inputs (>=1 name).
 *   2. Dry-run short-circuit: log the planned name list + CRM mode, exit 0
 *      without launching a browser.
 *   3. Dedupe duplicate names (warn + drop).
 *   4. Pick the right workflow definition based on `useCrm`.
 *   5. Delegate to runWorkflowBatch (shared-context-pool mode).
 */
export async function runEidLookup(
  names: string[],
  options: EidLookupOptions = {},
): Promise<void> {
  if (names.length === 0) {
    log.error("eid-lookup requires at least one name");
    process.exit(1);
  }
  const useCrm = options.useCrm !== false;
  const workers = options.workers ?? Math.min(names.length, 4);

  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    log.step(`CRM cross-verification: ${useCrm ? "ON" : "OFF"}`);
    log.step(`Workers: ${workers}`);
    log.step(`Names (${names.length}):`);
    for (const n of names) log.step(`  - ${n}`);
    log.success("Dry run complete — no browser launched, no UCPath/CRM contact made");
    return;
  }

  const uniqueNames = dedupeNames(names);
  const items: EidLookupItem[] = uniqueNames.map((name) => ({ name }));
  const wf = useCrm ? eidLookupCrmWorkflow : eidLookupWorkflow;
  const now = new Date().toISOString();

  try {
    const result = await runWorkflowBatch(wf, items, {
      poolSize: workers,
      deriveItemId: (item) => (item as EidLookupItem).name,
      onPreEmitPending: (item, runId) => {
        const n = (item as EidLookupItem).name;
        trackEvent({
          workflow: "eid-lookup",
          timestamp: now,
          id: n,
          runId,
          status: "pending",
          data: { searchName: n, __name: n, __id: n },
        });
      },
    });
    log.success(
      `EID lookup complete: ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`,
    );
  } catch (err) {
    log.error(`EID lookup failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck:all`
Expected: clean. If there's a complaint about `import("../../core/types.js").Ctx<readonly string[], EidLookupItem>`, narrow it to `Ctx<typeof stepsNoCrm | typeof stepsCrm, EidLookupItem>` or just `any` — the helpers are internal.

- [ ] **Step 3: Run existing tests (should still pass)**

Run: `npm run test`
Expected: all existing tests green (we haven't touched the barrel yet; Excel removal is a later task).

Note: `src/workflows/eid-lookup/index.ts` still exports `updateEidTracker` at this point. That export will be dropped in C.1. If the barrel breaks typecheck because `tracker.ts` isn't yet deleted, that's fine — it still exists.

- [ ] **Step 4: Commit**

```bash
git add src/workflows/eid-lookup/workflow.ts
git commit -m "feat(eid-lookup): rewrite handler for per-name shared-context-pool items

- TData = { name: string }; one kernel item per name.
- Both CRM-off (searching) and CRM-on (searching + cross-verification)
  variants share one handler body.
- CLI adapter dedupes duplicate names and forwards workers as poolSize.
- Cross-verification is per-item (own CRM tab per worker).
- Excel tracker calls removed from handler (tracker.ts deleted in Phase C)."
```

---

### Task B.3: Update `src/cli.ts` if needed

**Files:**
- Modify: `src/cli.ts` (only if the eid-lookup subcommand references the old schema)

- [ ] **Step 1: Inspect current wiring**

Run: `grep -n 'eid-lookup\|runEidLookup\|EidLookupInput' src/cli.ts`
Expected: only the Commander subcommand definition that calls `runEidLookup(names, { workers, useCrm, dryRun })`. If the subcommand's option parsing matches the existing `EidLookupOptions` shape, no edit needed.

- [ ] **Step 2: If nothing to change, skip the commit**

No file touched = no commit. Proceed to B.4.

---

### Task B.4: CLI adapter tests

**Files:**
- Create: `tests/unit/workflows/eid-lookup/workflow.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeNames } from '../../../../src/workflows/eid-lookup/workflow.js'
import { EidLookupItemSchema } from '../../../../src/workflows/eid-lookup/schema.js'

test('EidLookupItemSchema accepts { name: string }', () => {
  const parsed = EidLookupItemSchema.parse({ name: 'Doe, Jane' })
  assert.equal(parsed.name, 'Doe, Jane')
})

test('EidLookupItemSchema rejects empty string', () => {
  assert.throws(() => EidLookupItemSchema.parse({ name: '' }))
})

test('dedupeNames preserves first-seen order and drops duplicates', () => {
  const out = dedupeNames(['a', 'b', 'a', 'c', 'b'])
  assert.deepEqual(out, ['a', 'b', 'c'])
})

test('dedupeNames on all-unique list is identity', () => {
  const input = ['x', 'y', 'z']
  assert.deepEqual(dedupeNames(input), input)
})

test('dedupeNames on empty array returns empty array', () => {
  assert.deepEqual(dedupeNames([]), [])
})
```

- [ ] **Step 2: Run tests**

Run: `./node_modules/.bin/tsx --test tests/unit/workflows/eid-lookup/workflow.test.ts`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/workflows/eid-lookup/workflow.test.ts
git commit -m "test(eid-lookup): cover per-item schema + dedupeNames"
```

---

## Phase C — Excel removal

### Task C.1: Delete `tracker.ts`, `eid-lookup-tracker.xlsx`, and the barrel export

**Files:**
- Delete: `src/workflows/eid-lookup/tracker.ts`
- Delete: `src/workflows/eid-lookup/eid-lookup-tracker.xlsx`
- Modify: `src/workflows/eid-lookup/index.ts`

- [ ] **Step 1: Drop the `updateEidTracker` barrel export**

In `src/workflows/eid-lookup/index.ts`, change:

```ts
export { searchByName, parseNameInput, type EidResult, type EidSearchResult } from "./search.js";
export { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";
export { updateEidTracker } from "./tracker.js";
export {
  runEidLookup,
  eidLookupWorkflow,
  eidLookupCrmWorkflow,
  type EidLookupOptions,
  type LookupResult,
} from "./workflow.js";
export {
  EidLookupInputSchema,
  EidLookupCrmInputSchema,
  type EidLookupInput,
  type EidLookupCrmInput,
} from "./schema.js";
```

to:

```ts
export { searchByName, parseNameInput, type EidResult, type EidSearchResult } from "./search.js";
export { searchCrmByName, datesWithinDays, type CrmRecord } from "./crm-search.js";
export {
  runEidLookup,
  eidLookupWorkflow,
  eidLookupCrmWorkflow,
  dedupeNames,
  type EidLookupOptions,
  type LookupResult,
} from "./workflow.js";
export {
  EidLookupInputSchema,
  EidLookupCrmInputSchema,
  EidLookupItemSchema,
  type EidLookupInput,
  type EidLookupCrmInput,
  type EidLookupItem,
} from "./schema.js";
```

- [ ] **Step 2: Delete the files**

```bash
rm src/workflows/eid-lookup/tracker.ts
rm src/workflows/eid-lookup/eid-lookup-tracker.xlsx
```

- [ ] **Step 3: Verify no references remain**

Run: `grep -rn 'updateEidTracker\|eid-lookup-tracker\|eid-lookup/tracker' src/ tests/`
Expected: empty output.

Run: `npm run typecheck:all`
Expected: clean (workflow.ts doesn't import tracker.ts anymore after B.2; if any stragglers typecheck flags them, fix inline).

Run: `npm run test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add -A src/workflows/eid-lookup/
git commit -m "chore(eid-lookup): delete xlsx tracker

Removes tracker.ts, eid-lookup-tracker.xlsx, and the updateEidTracker
barrel export. JSONL + dashboard are the only observability for
eid-lookup going forward (per-name rows via shared-context-pool)."
```

---

### Task C.2: Remove `updateEidTracker` mention from root `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Fix the "Obsolete patterns" line**

In `CLAUDE.md`, find the line:

```md
- **Per-workflow Excel tracker as primary observability** — dashboard JSONL is the source of truth. Existing xlsx writers (`updateEidTracker`, `updateWorkStudyTracker`, etc.) are retained for historical use and are Excel-only (they no longer emit tracker events).
```

Change to:

```md
- **Per-workflow Excel tracker as primary observability** — dashboard JSONL is the source of truth. Existing xlsx writers (`updateWorkStudyTracker`, onboarding's + old-kronos-reports' trackers, etc.) are retained for historical use and are Excel-only (they no longer emit tracker events). Eid-lookup's xlsx tracker was removed entirely on 2026-04-21 — JSONL + dashboard cover it.
```

- [ ] **Step 2: Update the "EID lookup (kernel)" data flow diagram**

Find:

```md
**EID lookup (kernel)**
```
Names → Person Org Summary (UCPath, N tabs) → SDCMP/HDH filter
  → Excel tracker | optional CRM cross-verify
```
```

Replace the contents inside the code fence with:

```md
**EID lookup (kernel)**
```
Names → (shared-context pool, N tabs) → Person Org Summary (UCPath)
  → SDCMP/HDH filter → per-name dashboard row
  [optional] → CRM search + hire-date / EID cross-verify
```
```

- [ ] **Step 3: Update the step tracking table**

Find:

```md
| eid-lookup | ucpath-auth → searching (+ crm-auth → cross-verification in CRM mode) |
```

Change to:

```md
| eid-lookup | searching (+ cross-verification in CRM mode) |
```

(Auth steps no longer emit per-item: one-time auth for the whole pool, so item rows start at `searching`.)

- [ ] **Step 4: Verify no other references**

Run: `grep -n 'updateEidTracker\|eid-lookup-tracker' CLAUDE.md`
Expected: empty.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update root CLAUDE.md for eid-lookup per-name rows + xlsx removal"
```

---

## Phase D — Documentation

### Task D.1: Rewrite `src/workflows/eid-lookup/CLAUDE.md`

**Files:**
- Modify: `src/workflows/eid-lookup/CLAUDE.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `src/workflows/eid-lookup/CLAUDE.md` with:

```md
# EID Lookup Workflow

Searches UCPath Person Organizational Summary for employees by name, filters for SDCMP business unit and Housing/Dining/Hospitality departments, with optional CRM cross-verification.

**Kernel-based (shared-context-pool mode).** Two `defineWorkflow` definitions in `workflow.ts`:
- `eidLookupWorkflow` (no-CRM): 1 system (UCPath), 1 handler step per item (`searching`)
- `eidLookupCrmWorkflow` (CRM-on): 2 systems (UCPath + CRM, sequential auth), 2 handler steps per item (`searching` → `cross-verification`)

Both share one handler body. Each CLI invocation runs N names as N kernel items concurrently: one browser per system + one Duo per system for the whole pool, N per-worker tabs spawned lazily from each system's shared BrowserContext. Each name produces its own `pending → running → done/failed` tracker row in the dashboard with per-step timing.

## Selector intelligence

This workflow touches two systems: **ucpath**, **crm** (CRM only in `--crm` mode).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`, `"crm name search"`, `"sdcmp filter"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Files

- `schema.ts` — Zod schemas. `EidLookupItemSchema` = per-kernel-item shape (`{ name }`); `EidLookupInputSchema` / `EidLookupCrmInputSchema` = CLI-boundary batch shape (`{ names, workers }`).
- `search.ts` — Multi-strategy name search (`searchByName`, `parseNameInput`): "Last, First Middle" → tries full → first → middle, drills into SDCMP results, filters by HDH keywords. Kernel-agnostic.
- `crm-search.ts` — CRM cross-verification helpers (`searchCrmByName`, `datesWithinDays`): last/first name search, extracts PPS ID + UCPath EID + hire date + dept, ±7 day date matching. Kernel-agnostic.
- `workflow.ts` — Kernel definitions (`eidLookupWorkflow`, `eidLookupCrmWorkflow`) + shared step helpers (`searchingStep`, `crossVerificationStep`) + CLI adapter (`runEidLookup`) + `dedupeNames` helper. Dry-run branch bypasses the kernel.
- `index.ts` — Barrel exports.

No `tracker.ts` — dashboard JSONL only. The xlsx tracker was removed on 2026-04-21 (see Lessons Learned).

## Kernel Config

| Field | `eidLookupWorkflow` | `eidLookupCrmWorkflow` |
|-------|---------------------|------------------------|
| `systems` | `[ucpath]` | `[ucpath, crm]` |
| `steps` | `["searching"]` | `["searching", "cross-verification"]` |
| `schema` | `EidLookupItemSchema` | `EidLookupItemSchema` |
| `authSteps` | `false` | `false` |
| `authChain` | `"sequential"` | `"sequential"` |
| `tiling` | `"single"` | `"auto"` |
| `batch` | `{ mode: "shared-context-pool", poolSize: 4, preEmitPending: true }` | same |
| `detailFields` | `searchName, emplId, department, jobTitle` | `+ crmMatch` |
| `getName` / `getId` | `d.searchName` | `d.searchName` |
| `initialData` | `{ searchName: input.name }` | same |

## Data Flow

```
CLI: tsx src/cli.ts eid-lookup "Last, First Middle" [...] [--no-crm] [--workers N] [--dry-run]
  → runEidLookup (CLI adapter)
    → if --dry-run: log planned name list + CRM mode, exit 0 (no browser)
    → dedupeNames: drop + warn on exact duplicates
    → names.map(n => ({ name: n }))  → kernel items
    → onPreEmitPending: trackEvent("pending") per item with searchName seeded
    → runWorkflowBatch(wf, items, { poolSize: workers, deriveItemId, onPreEmitPending })
      → Dispatch to runWorkflowSharedContextPool
        → Session.launch([ucpath(, crm)]) ONCE: 1-2 browsers, Duo ×1 or ×2
        → N workers, each a Session.forWorker view of the parent:
          - Lazy per-worker Page opens on first ctx.page(id) from shared context
          - runOneItem wraps each item in withTrackedWorkflow
          - handler: updateData({ searchName }); step("searching", ...)
                     [CRM mode] step("cross-verification", ...)
          - step failures become per-item `failed` tracker rows; batch continues
        → Worker teardown: closeWorkerPages (no context/browser close)
      → Parent session.close: close contexts + browsers exactly once
    → Final log: "N/M succeeded, K failed"
```

## Shared-context pool semantics

- N workers (`--workers`, default `min(names.length, 4)`) share per-system `BrowserContext`s. Each worker opens its own Page on first `ctx.page(id)` call (lazy allocation).
- Queue-based distribution inside `runWorkflowSharedContextPool` — workers pull items from a shared queue until empty.
- Per-name failures become `failed` tracker rows via `runOneItem`'s catch; the worker continues to the next queue item (no duplicated error logging — kernel owns the failure path).
- Duplicate names in the CLI input are deduped at the adapter level (warn + drop). Duplicate-name requests would collide on the name-derived `itemId` and confuse the dashboard.
- JSONL writes (kernel-owned `trackEvent`) need no coordination — `appendFileSync` is atomic per-line.

## Dashboard integration

- Workflow name: `eid-lookup`
- Steps (per-item): `["searching"]` no-CRM / `["searching", "cross-verification"]` CRM mode.
  - One-time auth runs BEFORE the pool starts and does NOT emit per-item auth rows.
- Detail fields: `searchName, emplId, department, jobTitle` (+ `crmMatch` in CRM mode).
- Item ID on the dashboard = the searched name (deduped). `__name` / `__id` seeded on the initial pending row via `onPreEmitPending` so the row reads correctly before `searching` runs.

## Name Search Strategy

1. Try full name: `lastName, firstName middleName`
2. If no SDCMP results: try `lastName, firstName` (drop middle)
3. If still nothing: try `lastName, middleName` (middle as first)

## Gotchas

- PeopleSoft search results table ID: `tdgbrPTS_CFG_CL_STD_RSL$0`
- Valid data rows must have exactly 9 cells with numeric Empl ID (5+ digits) in first cell
- Drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact
- Assignment table scan: finds first row with 12+ cells where cell[3] matches business unit pattern (4-5 uppercase chars + optional digit) and cell[6] is department description
- "View All" button may need re-clicking after drill-in if results are paginated (rowIndex > 10)
- CRM search uses different strategy: last name first, then first name
- CRM date matching uses ±7 day tolerance for hire date comparison
- Each worker gets its own UCPath tab AND its own CRM tab — concurrent CRM name searches on separate pages. If ACT CRM ever rate-limits, the revert is to collapse `cross-verification` into a post-pool pass (separate step list, single CRM page).
- Browsers kept open for inspection (no automatic close past `parent.close()` at end)
- Only the FIRST SDCMP result per name stamps the detail fields; the full result list lives in the step log output. Multi-result names are rare (one employee ≈ one SDCMP record).

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-21: Shared-context-pool + xlsx removal.** Replaced the handler-side `runWorkerPool` with the kernel's new `batch.mode: "shared-context-pool"`. TData is now `{ name: string }` — one kernel item per name, one dashboard row per name, same "1 Duo per system, N tabs" browser topology. CRM cross-verification moved inside the per-item handler (was a post-pool pass). Excel tracker (`tracker.ts` + `eid-lookup-tracker.xlsx`) fully removed — JSONL + dashboard are the only observability. `async-mutex` use dropped with the xlsx writes. Kernel addition: `Session.forWorker(parent)` + lazy `page(id)` branch + `closeWorkerPages()`. **Live run pending user verification** — UCPath + CRM Duo can't be approved this session; dry-run + unit tests validate this migration.
- **2026-04-17: Migrated to kernel (historical).** First kernel cut used `runWorkerPool` inside `ctx.step("searching", ...)` as a helper. One workflow run per CLI invocation; per-name JSONL rows were the "Acceptable regression" closed by the 2026-04-21 change. Left here to explain why `search.ts` / `crm-search.ts` are kernel-agnostic helpers (they were authored before the kernel existed and survive the 2026-04-21 rewrite untouched).
```

- [ ] **Step 2: Commit**

```bash
git add src/workflows/eid-lookup/CLAUDE.md
git commit -m "docs(eid-lookup): rewrite CLAUDE.md for shared-context-pool + xlsx removal"
```

---

### Task D.2: Reconcile `docs/architecture-deep-dive.md`

**Files:**
- Modify: `docs/architecture-deep-dive.md`

- [ ] **Step 1: Inspect existing diff**

Run: `git diff docs/architecture-deep-dive.md | head -80`
Expected: gemini's uncommitted changes from prior sessions.

- [ ] **Step 2: Grep for eid-lookup + excel mentions**

Run: `grep -n 'eid-lookup\|EID Lookup\|eid-lookup-tracker\|updateEidTracker' docs/architecture-deep-dive.md`

For each hit:
- If it references "one row per invocation" or "Acceptable regression" or the Excel tracker: update to "one row per name (shared-context-pool)" and remove Excel mentions.
- If it references the kernel batch modes, add `shared-context-pool` to the list of modes.

Make inline edits. Keep the rest of gemini's diff intact.

- [ ] **Step 3: Verify**

Run: `grep -n 'Acceptable regression\|updateEidTracker\|eid-lookup-tracker' docs/architecture-deep-dive.md`
Expected: empty.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture-deep-dive.md
git commit -m "docs(architecture): reconcile deep-dive with per-name eid-lookup"
```

---

## Final verification

- [ ] **Step 1: Type + lint + test green**

```bash
npm run typecheck:all
npm run test
```

Expected: both pass, no new failures.

- [ ] **Step 2: Dry-run 3-name smoke test**

```bash
./node_modules/.bin/tsx --env-file=.env src/cli.ts eid-lookup --dry-run "Name 1" "Name 2" "Name 3"
```

Expected output contains:
```
=== DRY RUN MODE ===
CRM cross-verification: ON
Workers: 3
Names (3):
  - Name 1
  - Name 2
  - Name 3
Dry run complete — no browser launched, no UCPath/CRM contact made
```

- [ ] **Step 3: Grep audits**

```bash
# No xlsx imports remain in eid-lookup
grep -rn 'xlsx\|exceljs\|appendRow' src/workflows/eid-lookup/
# expected: empty

# No updateEidTracker / updateEidTrackerNotFound / eid-lookup-tracker.xlsx references anywhere in src/
grep -rn 'updateEidTracker\|updateEidTrackerNotFound\|eid-lookup-tracker' src/
# expected: empty

# tracker.ts removed
ls src/workflows/eid-lookup/tracker.ts
# expected: "No such file or directory"
```

- [ ] **Step 4: Inline-selectors guard still green**

```bash
./node_modules/.bin/tsx --test tests/unit/systems/inline-selectors.test.ts
```

Expected: pass.

- [ ] **Step 5: Final commit (if anything left)**

Run: `git status`
Expected: clean working tree. If the dry-run or audits exposed a gap, fix + commit inline.

---

## Rollback notes

If any phase fails in a way that requires rollback:

- **Phase A only**: kernel addition is additive; reverting the commits in A.1–A.3 leaves everything else untouched.
- **Phase A + B**: the eid-lookup rewrite depends on A. Revert B.2 alone to restore the old handler IF A was committed; old handler used `runWorkerPool` which still lives at `src/utils/worker-pool.ts`.
- **Phase C**: Excel removal is pure deletion. Restore from git: `git checkout HEAD~N -- src/workflows/eid-lookup/tracker.ts src/workflows/eid-lookup/eid-lookup-tracker.xlsx` then re-add the barrel export.
- **Phase D**: docs-only, revert freely.

CRM concurrent-tab risk: if live run shows rate-limit issues, collapse `cross-verification` back to a post-pool pass by (1) removing the `ctx.step("cross-verification", ...)` call from the CRM handler, (2) deleting it from the `stepsCrm` tuple, (3) writing a post-pool pass inside `runEidLookup` that opens a single CRM page on `parent` (non-worker Session) and iterates results serially. ~15 lines, no kernel changes.
