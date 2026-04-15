# Workflow Kernel Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `src/core/` workflow kernel end-to-end: types, registry, Session, Stepper, defineWorkflow, runWorkflow, sequential batch, pool batch, page-health relocation, dashboard `/api/workflows` endpoint, frontend `WorkflowsProvider`, and delete unused `WorkflowSession` class. Scope ends when a mock workflow runs end-to-end and emits correct tracker events. Migration of real workflows is deferred to subsequent incremental plans.

**Architecture:** Declarative workflow API — `defineWorkflow({name, systems, steps, schema, handler})` returns a registered workflow. `runWorkflow(wf, data)` constructs a Session (launching browsers + interleaved auth), a Stepper (tracker emission), and invokes handler with a typed `ctx`. All decisions and rationale live in `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md` — read that before starting.

**Tech Stack:** TypeScript strict, Playwright, Zod, Node built-in `--test` runner, React 19 for dashboard.

**Spec reference:** `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md` (authoritative; do not redesign).

---

## File Structure

**Created:**
- `src/core/types.ts` — all shared interfaces (SystemConfig, BatchConfig, WorkflowConfig, Ctx, WorkflowMetadata)
- `src/core/registry.ts` — module-level workflow registry for dashboard
- `src/core/session.ts` — Session class: browsers, auth chain, tiling, lifecycle
- `src/core/stepper.ts` — Stepper class: ctx.step/parallel/updateData implementation
- `src/core/workflow.ts` — defineWorkflow, runWorkflow, runWorkflowBatch
- `src/core/pool.ts` — worker-per-browser pool runner
- `src/core/page-health.ts` — moved from `src/utils/page-health.ts`
- `src/core/index.ts` — barrel export
- `tests/unit/core/registry.test.ts`
- `tests/unit/core/session.test.ts`
- `tests/unit/core/stepper.test.ts`
- `tests/unit/core/workflow.test.ts`
- `tests/unit/core/batch.test.ts`
- `tests/unit/core/pool.test.ts`
- `tests/integration/core/mock-workflow.test.ts`
- `src/dashboard/workflows-context.tsx` — React Context provider + `useWorkflows()` hook

**Modified:**
- `src/tracker/dashboard.ts` — add `GET /api/workflows` route
- `src/dashboard/main.tsx` (or app root) — wrap tree in `WorkflowsProvider`
- `src/dashboard/components/types.ts` — delete static `WF_CONFIG`, export types only
- `src/dashboard/components/QueuePanel.tsx` + `LogPanel.tsx` + workflow dropdown component — switch to `useWorkflows()`

**Deleted:**
- `src/browser/session.ts` (unused `WorkflowSession` class)
- `src/utils/page-health.ts` (moved to core)

**Untouched (confirm none of these change):**
- `src/auth/*` — login functions reused as-is
- `src/browser/launch.ts`, `src/browser/tiling.ts` — consumed by Session, no changes
- `src/tracker/jsonl.ts` — `withTrackedWorkflow` and `withLogContext` reused as-is
- `src/utils/log.ts`, `errors.ts`, `worker-pool.ts`, `screenshot.ts`, `env.ts` — reused

---

## Task 0: Read the spec and scaffold the directory

**Files:**
- Create: `src/core/index.ts`
- Read: `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md`

- [ ] **Step 0.1: Read the spec end-to-end.** Do not skim. Every design decision referenced in later tasks comes from this doc.

- [ ] **Step 0.2: Create `src/core/index.ts` with a placeholder export.**

```ts
// src/core/index.ts
// Barrel export — individual modules populate as tasks complete.
export {}
```

- [ ] **Step 0.3: Verify typecheck passes.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 0.4: Commit.**

```bash
git add src/core/index.ts
git commit -m "feat(core): scaffold src/core/ directory"
```

---

## Task 1: Shared types

**Files:**
- Create: `src/core/types.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 1.1: Write `src/core/types.ts`.**

```ts
// src/core/types.ts
import type { Page } from 'playwright'
import type { ZodType } from 'zod'
import type { log } from '../utils/log.js'

export interface SystemConfig {
  id: string
  login: (page: Page, instance?: string) => Promise<void>
  sessionDir?: string
  resetUrl?: string
}

export interface BatchConfig {
  mode: 'sequential' | 'pool'
  poolSize?: number
  betweenItems?: Array<'health-check' | 'reset-browsers' | 'navigate-home'>
  preEmitPending?: boolean
}

export interface WorkflowConfig<TData, TSteps extends readonly string[]> {
  name: string
  version?: string
  systems: SystemConfig[]
  steps: TSteps
  schema: ZodType<TData>
  tiling?: 'auto' | 'single' | 'side-by-side'
  authChain?: 'sequential' | 'interleaved'
  batch?: BatchConfig
  detailFields?: Array<keyof TData & string>
  handler: (ctx: Ctx<TSteps, TData>, data: TData) => Promise<void>
}

export interface Ctx<TSteps extends readonly string[], TData> {
  page(id: string): Promise<Page>
  step<R>(name: TSteps[number], fn: () => Promise<R>): Promise<R>
  parallel<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }>
  updateData(patch: Partial<TData> & Record<string, unknown>): void
  session: SessionHandle
  log: typeof log
  isBatch: boolean
  runId: string
}

// Subset of Session exposed to handlers — full Session kept internal.
export interface SessionHandle {
  page(id: string): Promise<Page>
  newWindow(id: string): Promise<Page>
  closeWindow(id: string): Promise<void>
}

export interface WorkflowMetadata {
  name: string
  steps: readonly string[]
  systems: string[]
  detailFields: string[]
}

export interface RegisteredWorkflow<TData, TSteps extends readonly string[]> {
  config: WorkflowConfig<TData, TSteps>
  metadata: WorkflowMetadata
}

export interface BatchResult {
  total: number
  succeeded: number
  failed: number
  errors: Array<{ item: unknown; error: string }>
}

export interface RunOpts {
  itemId?: string
  preAssignedRunId?: string
  launchFn?: (opts: {
    system: SystemConfig
    tileIndex: number
    tileCount: number
    tiling: 'auto' | 'single' | 'side-by-side'
  }) => Promise<{ page: import('playwright').Page; context: import('playwright').BrowserContext; browser: import('playwright').Browser }>
  trackerStub?: boolean
  onPreEmitPending?: (item: unknown) => void
}
```

RunOpts is declared in `types.ts` (not `workflow.ts`) so `pool.ts` can import it without a circular dependency on `workflow.ts`.

- [ ] **Step 1.2: Update `src/core/index.ts` to re-export types.**

```ts
// src/core/index.ts
export type * from './types.js'
```

- [ ] **Step 1.3: Verify typecheck passes.**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 1.4: Commit.**

```bash
git add src/core/types.ts src/core/index.ts
git commit -m "feat(core): add shared types for workflow kernel"
```

---

## Task 2: Registry

**Files:**
- Create: `src/core/registry.ts`
- Test: `tests/unit/core/registry.test.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 2.1: Write the failing test.**

```ts
// tests/unit/core/registry.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register, getAll, clear, getByName } from '../../../src/core/registry.js'

test('registry: register and retrieve metadata', () => {
  clear()
  register({ name: 'wf-a', steps: ['s1', 's2'], systems: ['ucpath'], detailFields: ['emplId'] })
  const all = getAll()
  assert.equal(all.length, 1)
  assert.equal(all[0].name, 'wf-a')
})

test('registry: register same name twice replaces', () => {
  clear()
  register({ name: 'wf-a', steps: ['s1'], systems: [], detailFields: [] })
  register({ name: 'wf-a', steps: ['s1', 's2'], systems: [], detailFields: [] })
  assert.equal(getAll().length, 1)
  assert.deepEqual(getByName('wf-a')?.steps, ['s1', 's2'])
})

test('registry: getByName returns undefined for unknown', () => {
  clear()
  assert.equal(getByName('unknown'), undefined)
})

test('registry: clear empties the store', () => {
  register({ name: 'wf-a', steps: ['s1'], systems: [], detailFields: [] })
  clear()
  assert.equal(getAll().length, 0)
})
```

- [ ] **Step 2.2: Run test to verify it fails.**

Run: `npm test -- tests/unit/core/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Implement `src/core/registry.ts`.**

```ts
// src/core/registry.ts
import type { WorkflowMetadata } from './types.js'

const registry = new Map<string, WorkflowMetadata>()

export function register(metadata: WorkflowMetadata): void {
  registry.set(metadata.name, metadata)
}

export function getAll(): WorkflowMetadata[] {
  return [...registry.values()]
}

export function getByName(name: string): WorkflowMetadata | undefined {
  return registry.get(name)
}

export function clear(): void {
  registry.clear()
}
```

- [ ] **Step 2.4: Add to barrel export.**

```ts
// src/core/index.ts
export type * from './types.js'
export { register, getAll, getByName, clear } from './registry.js'
```

- [ ] **Step 2.5: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/registry.test.ts`
Expected: PASS (4/4).

- [ ] **Step 2.6: Commit.**

```bash
git add src/core/registry.ts src/core/index.ts tests/unit/core/registry.test.ts
git commit -m "feat(core): add workflow metadata registry"
```

---

## Task 3: Session skeleton — state + constructor

**Files:**
- Create: `src/core/session.ts`
- Test: `tests/unit/core/session.test.ts`

- [ ] **Step 3.1: Write the failing test for session construction + state.**

```ts
// tests/unit/core/session.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../../../src/core/session.js'
import type { SystemConfig } from '../../../src/core/types.js'

// Mock login that never calls real Playwright.
const makeSystem = (id: string, loginFn?: () => Promise<void>): SystemConfig => ({
  id,
  login: async () => { await (loginFn ?? (() => Promise.resolve()))() },
})

test('session: construct with no systems is legal', () => {
  const s = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() })
  assert.equal(s.systemIds().length, 0)
})

test('session: systemIds returns declared ids in order', () => {
  const systems = [makeSystem('ucpath'), makeSystem('kuali')]
  const s = Session.forTesting({ systems, browsers: new Map(), readyPromises: new Map() })
  assert.deepEqual(s.systemIds(), ['ucpath', 'kuali'])
})
```

- [ ] **Step 3.2: Run test; expect FAIL (module missing).**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: FAIL.

- [ ] **Step 3.3: Implement minimal Session with `forTesting` hook.**

```ts
// src/core/session.ts
import type { Page, Browser, BrowserContext } from 'playwright'
import type { SystemConfig } from './types.js'

interface SystemSlot {
  page: Page
  browser: Browser
  context: BrowserContext
}

interface SessionState {
  systems: SystemConfig[]
  browsers: Map<string, SystemSlot>
  readyPromises: Map<string, Promise<void>>
}

export class Session {
  private constructor(private state: SessionState) {}

  /** Test-only factory to construct a Session with pre-built state. */
  static forTesting(state: SessionState): Session {
    return new Session(state)
  }

  systemIds(): string[] {
    return this.state.systems.map((s) => s.id)
  }
}
```

- [ ] **Step 3.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: PASS (2/2).

- [ ] **Step 3.5: Commit.**

```bash
git add src/core/session.ts tests/unit/core/session.test.ts
git commit -m "feat(core): add Session class skeleton with test factory"
```

---

## Task 4: Session.page() — lazy accessor with ready promise

**Files:**
- Modify: `src/core/session.ts`
- Modify: `tests/unit/core/session.test.ts`

- [ ] **Step 4.1: Write the failing test.**

```ts
// Add to tests/unit/core/session.test.ts

test('session.page: awaits ready promise, then returns cached page', async () => {
  const fakePage = { __marker: 'fake-page' } as unknown as import('playwright').Page
  let resolveReady: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })

  const s = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map([['ucpath', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['ucpath', ready]]),
  })

  let pageResolved = false
  const pagePromise = s.page('ucpath').then((p) => { pageResolved = true; return p })

  // Before ready resolves, page() should be pending.
  await Promise.resolve()
  assert.equal(pageResolved, false)

  resolveReady!()
  const page = await pagePromise
  assert.equal(pageResolved, true)
  assert.strictEqual(page, fakePage)
})

test('session.page: unknown id throws', async () => {
  const s = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() })
  await assert.rejects(() => s.page('nope'), /unknown system/i)
})
```

- [ ] **Step 4.2: Run tests; expect FAIL.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: 2 new tests FAIL (method missing).

- [ ] **Step 4.3: Add `page()` method.**

```ts
// In src/core/session.ts, inside the Session class:

async page(id: string): Promise<Page> {
  const ready = this.state.readyPromises.get(id)
  if (!ready) throw new Error(`unknown system: ${id}`)
  await ready
  const slot = this.state.browsers.get(id)
  if (!slot) throw new Error(`no browser for system: ${id}`)
  return slot.page
}
```

- [ ] **Step 4.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: PASS (4/4).

- [ ] **Step 4.5: Commit.**

```bash
git add src/core/session.ts tests/unit/core/session.test.ts
git commit -m "feat(core): add Session.page() lazy accessor"
```

---

## Task 5: Session.launch — auth chain (sequential mode)

**Files:**
- Modify: `src/core/session.ts`
- Modify: `tests/unit/core/session.test.ts`

- [ ] **Step 5.1: Write the failing test.**

```ts
// Add to tests/unit/core/session.test.ts

test('session.launch (sequential): awaits each login in order', async () => {
  const order: string[] = []
  const makeSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(id)
    },
  })

  const s = await Session.launch(
    [makeSys('a'), makeSys('b'), makeSys('c')],
    { authChain: 'sequential', launchFn: fakeLaunch },
  )
  assert.deepEqual(order, ['a', 'b', 'c'])
  await s.close()
})

// Fake launch helper used in tests — returns a stub Page/Browser/Context.
function fakeLaunch() {
  const page = { close: async () => {} } as unknown as import('playwright').Page
  const context = { close: async () => {} } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return Promise.resolve({ page, context, browser })
}
```

- [ ] **Step 5.2: Run test; expect FAIL.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: FAIL — `Session.launch` is undefined.

- [ ] **Step 5.3: Implement `Session.launch` with `launchFn` injection point.**

```ts
// Add to src/core/session.ts

import { launchBrowser } from '../browser/launch.js'

export interface LaunchOpts {
  authChain?: 'sequential' | 'interleaved'
  tiling?: 'auto' | 'single' | 'side-by-side'
  /** Injection point for tests. */
  launchFn?: (opts: LaunchOneOpts) => Promise<SystemSlot>
}

interface LaunchOneOpts {
  system: SystemConfig
  tileIndex: number
  tileCount: number
  tiling: 'auto' | 'single' | 'side-by-side'
}

export class Session {
  // ... existing code ...

  static async launch(systems: SystemConfig[], opts: LaunchOpts = {}): Promise<Session> {
    const authChain = opts.authChain ?? (systems.length > 1 ? 'interleaved' : 'sequential')
    const tiling = opts.tiling ?? (systems.length > 1 ? 'auto' : 'single')
    const launchOne = opts.launchFn ?? defaultLaunchOne

    // Launch all browsers in parallel.
    const slots = await Promise.all(
      systems.map((s, i) =>
        launchOne({ system: s, tileIndex: i, tileCount: systems.length, tiling }),
      ),
    )
    const browsers = new Map<string, SystemSlot>()
    systems.forEach((s, i) => browsers.set(s.id, slots[i]))

    const readyPromises = new Map<string, Promise<void>>()

    if (authChain === 'sequential') {
      for (const s of systems) {
        const slot = browsers.get(s.id)!
        await s.login(slot.page)
      }
      systems.forEach((s) => readyPromises.set(s.id, Promise.resolve()))
    } else {
      // Interleaved: implemented in Task 6.
      throw new Error('interleaved auth not yet implemented')
    }

    return new Session({ systems, browsers, readyPromises })
  }

  async close(): Promise<void> {
    for (const slot of this.state.browsers.values()) {
      await slot.context.close()
      await slot.browser.close()
    }
  }
}

async function defaultLaunchOne(opts: LaunchOneOpts): Promise<SystemSlot> {
  const { browser, context, page } = await launchBrowser({ sessionDir: opts.system.sessionDir })
  return { page, context, browser }
}
```

- [ ] **Step 5.4: Run test; expect PASS.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: PASS.

- [ ] **Step 5.5: Commit.**

```bash
git add src/core/session.ts tests/unit/core/session.test.ts
git commit -m "feat(core): Session.launch with sequential auth chain"
```

---

## Task 6: Session.launch — interleaved auth chain

**Files:**
- Modify: `src/core/session.ts`
- Modify: `tests/unit/core/session.test.ts`

- [ ] **Step 6.1: Write the failing test.**

```ts
// Add to tests/unit/core/session.test.ts

test('session.launch (interleaved): first login blocks; subsequent logins resolve as chain progresses', async () => {
  const logins: Array<{ id: string; at: number }> = []
  let t = 0
  const mkSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      await new Promise((r) => setTimeout(r, 5))
      logins.push({ id, at: ++t })
    },
  })

  const systems = [mkSys('a'), mkSys('b'), mkSys('c')]
  const s = await Session.launch(systems, { authChain: 'interleaved', launchFn: fakeLaunch })

  // First system must be fully authed when launch returns.
  const pageA = await s.page('a')
  assert.ok(pageA)
  // b and c may or may not be done yet — await them.
  await Promise.all([s.page('b'), s.page('c')])
  // Order of completion: a first, then b, then c.
  assert.equal(logins[0].id, 'a')
  assert.deepEqual(logins.map((l) => l.id), ['a', 'b', 'c'])
  await s.close()
})

test('session.launch (interleaved): failed auth on system N does not block system N+1', async () => {
  const completed: string[] = []
  const systems: SystemConfig[] = [
    { id: 'a', login: async () => { completed.push('a') } },
    { id: 'b', login: async () => { throw new Error('b login failed') } },
    { id: 'c', login: async () => { completed.push('c') } },
  ]
  const s = await Session.launch(systems, { authChain: 'interleaved', launchFn: fakeLaunch })

  await assert.rejects(() => s.page('b'), /b login failed/)
  // c should still resolve.
  const pageC = await s.page('c')
  assert.ok(pageC)
  assert.deepEqual(completed, ['a', 'c'])
  await s.close()
})
```

- [ ] **Step 6.2: Run tests; expect FAIL.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: FAIL with "interleaved auth not yet implemented".

- [ ] **Step 6.3: Implement interleaved auth chain.**

Replace the `throw new Error('interleaved auth not yet implemented')` block with:

```ts
} else {
  // Interleaved: auth system[0] blocking; chain the rest in background.
  const firstSlot = browsers.get(systems[0].id)!
  await systems[0].login(firstSlot.page)
  readyPromises.set(systems[0].id, Promise.resolve())

  let prev: Promise<void> = Promise.resolve()
  for (let i = 1; i < systems.length; i++) {
    const sys = systems[i]
    const slot = browsers.get(sys.id)!
    // Each chain step ignores predecessor failure so one bad auth doesn't block the next.
    const p = prev.catch(() => {}).then(() => sys.login(slot.page))
    // Prevent unhandled rejection warnings if nobody consumes this promise.
    p.catch(() => {})
    readyPromises.set(sys.id, p)
    prev = p
  }
}
```

- [ ] **Step 6.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: PASS.

- [ ] **Step 6.5: Commit.**

```bash
git add src/core/session.ts tests/unit/core/session.test.ts
git commit -m "feat(core): Session.launch with interleaved auth chain"
```

---

## Task 7: Session — reset, healthCheck, killChrome

**Files:**
- Modify: `src/core/session.ts`
- Modify: `tests/unit/core/session.test.ts`

- [ ] **Step 7.1: Write failing tests.**

```ts
// Add to tests/unit/core/session.test.ts

test('session.reset: navigates to resetUrl when configured', async () => {
  const urls: string[] = []
  const fakePage = {
    goto: async (url: string) => { urls.push(url) },
    close: async () => {},
  } as unknown as import('playwright').Page

  const s = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {}, resetUrl: 'https://ucpath/home' }],
    browsers: new Map([['ucpath', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  await s.reset('ucpath')
  assert.deepEqual(urls, ['https://ucpath/home'])
})

test('session.reset: no-op when resetUrl missing', async () => {
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: {} as import('playwright').Page, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  await assert.doesNotReject(() => s.reset('a'))
})

test('session.healthCheck: returns false if page is closed', async () => {
  const fakePage = { isClosed: () => true } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  assert.equal(await s.healthCheck('a'), false)
})
```

- [ ] **Step 7.2: Run tests; expect FAIL.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: FAIL (methods missing).

- [ ] **Step 7.3: Add `reset()`, `healthCheck()`, and `killChrome()` methods.**

```ts
// Add to Session class:

async reset(id: string): Promise<void> {
  const sys = this.state.systems.find((s) => s.id === id)
  if (!sys?.resetUrl) return
  const slot = this.state.browsers.get(id)
  if (!slot) return
  await slot.page.goto(sys.resetUrl)
}

async healthCheck(id: string): Promise<boolean> {
  const slot = this.state.browsers.get(id)
  if (!slot) return false
  try {
    if (slot.page.isClosed()) return false
    return true
  } catch {
    return false
  }
}

async killChrome(): Promise<void> {
  // SIGINT teardown — force-close all browsers without awaiting graceful shutdown.
  for (const slot of this.state.browsers.values()) {
    try { await slot.browser.close() } catch { /* ignore */ }
  }
}
```

- [ ] **Step 7.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/session.test.ts`
Expected: PASS.

- [ ] **Step 7.5: Commit.**

```bash
git add src/core/session.ts tests/unit/core/session.test.ts
git commit -m "feat(core): Session.reset, healthCheck, killChrome"
```

---

## Task 8: Stepper — step() with tracker emission

**Files:**
- Create: `src/core/stepper.ts`
- Test: `tests/unit/core/stepper.test.ts`

- [ ] **Step 8.1: Write the failing test.**

```ts
// tests/unit/core/stepper.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Stepper } from '../../../src/core/stepper.js'

interface RecordedEvent { kind: 'step' | 'data' | 'done' | 'failed'; step?: string; data?: unknown; error?: string }

function mkStepper() {
  const events: RecordedEvent[] = []
  const stepper = new Stepper({
    workflow: 'wf',
    itemId: 'id-1',
    runId: 'run-1',
    emitStep: (name) => events.push({ kind: 'step', step: name }),
    emitData: (data) => events.push({ kind: 'data', data }),
    emitFailed: (step, error) => events.push({ kind: 'failed', step, error }),
  })
  return { stepper, events }
}

test('stepper.step: emits step on entry and returns result on success', async () => {
  const { stepper, events } = mkStepper()
  const result = await stepper.step('extraction', async () => 42)
  assert.equal(result, 42)
  assert.deepEqual(events, [{ kind: 'step', step: 'extraction' }])
})

test('stepper.step: emits failed on throw, rethrows', async () => {
  const { stepper, events } = mkStepper()
  await assert.rejects(
    () => stepper.step('extraction', async () => { throw new Error('boom') }),
    /boom/,
  )
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'step')
  assert.equal(events[1].kind, 'failed')
  assert.equal(events[1].step, 'extraction')
})

test('stepper.updateData: merges into pending data and emits', async () => {
  const { stepper, events } = mkStepper()
  stepper.updateData({ name: 'Alice' })
  stepper.updateData({ emplId: '123' })
  assert.equal(events.length, 2)
  assert.deepEqual(events[0].data, { name: 'Alice' })
  assert.deepEqual(events[1].data, { name: 'Alice', emplId: '123' })
})
```

- [ ] **Step 8.2: Run test; expect FAIL.**

Run: `npm test -- tests/unit/core/stepper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8.3: Implement Stepper.**

```ts
// src/core/stepper.ts
import { classifyError } from '../utils/errors.js'

export interface StepperOpts {
  workflow: string
  itemId: string
  runId: string
  emitStep: (name: string) => void
  emitData: (data: Record<string, unknown>) => void
  emitFailed: (step: string, error: string) => void
}

export class Stepper {
  private data: Record<string, unknown> = {}
  private currentStep: string | null = null

  constructor(private opts: StepperOpts) {}

  async step<R>(name: string, fn: () => Promise<R>): Promise<R> {
    this.currentStep = name
    this.opts.emitStep(name)
    try {
      return await fn()
    } catch (err) {
      const classified = classifyError(err)
      this.opts.emitFailed(name, classified)
      throw err
    }
  }

  updateData(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch }
    this.opts.emitData({ ...this.data })
  }

  getData(): Record<string, unknown> {
    return { ...this.data }
  }

  getCurrentStep(): string | null {
    return this.currentStep
  }
}
```

- [ ] **Step 8.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/stepper.test.ts`
Expected: PASS.

- [ ] **Step 8.5: Commit.**

```bash
git add src/core/stepper.ts tests/unit/core/stepper.test.ts
git commit -m "feat(core): Stepper with step/updateData and error classification"
```

---

## Task 9: Stepper — parallel() helper

**Files:**
- Modify: `src/core/stepper.ts`
- Modify: `tests/unit/core/stepper.test.ts`

- [ ] **Step 9.1: Write failing tests.**

```ts
// Add to tests/unit/core/stepper.test.ts

test('stepper.parallel: returns PromiseSettledResult per key', async () => {
  const { stepper } = mkStepper()
  const result = await stepper.parallel({
    a: async () => 1,
    b: async () => { throw new Error('b failed') },
    c: async () => 3,
  })
  assert.equal(result.a.status, 'fulfilled')
  assert.equal(result.b.status, 'rejected')
  assert.equal(result.c.status, 'fulfilled')
  assert.equal((result.a as PromiseFulfilledResult<number>).value, 1)
  assert.equal((result.c as PromiseFulfilledResult<number>).value, 3)
})

test('stepper.parallel: empty object returns empty object', async () => {
  const { stepper } = mkStepper()
  const result = await stepper.parallel({})
  assert.deepEqual(result, {})
})
```

- [ ] **Step 9.2: Run tests; expect FAIL.**

Run: `npm test -- tests/unit/core/stepper.test.ts`
Expected: FAIL — parallel missing.

- [ ] **Step 9.3: Add `parallel()` to Stepper.**

```ts
// Add to Stepper class:

async parallel<T extends Record<string, () => Promise<unknown>>>(
  tasks: T,
): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }> {
  const entries = Object.entries(tasks) as Array<[keyof T, () => Promise<unknown>]>
  const settled = await Promise.allSettled(entries.map(([, fn]) => fn()))
  const result = {} as { [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }
  entries.forEach(([key], i) => {
    ;(result as Record<string, unknown>)[key as string] = settled[i]
  })
  return result
}
```

- [ ] **Step 9.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/stepper.test.ts`
Expected: PASS.

- [ ] **Step 9.5: Commit.**

```bash
git add src/core/stepper.ts tests/unit/core/stepper.test.ts
git commit -m "feat(core): Stepper.parallel returns PromiseSettledResult per key"
```

---

## Task 10: defineWorkflow — registration on import

**Files:**
- Create: `src/core/workflow.ts`
- Test: `tests/unit/core/workflow.test.ts`
- Modify: `src/core/index.ts`

- [ ] **Step 10.1: Write the failing test.**

```ts
// tests/unit/core/workflow.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { getAll, getByName, clear } from '../../../src/core/registry.js'

test('defineWorkflow: registers metadata on construction', () => {
  clear()
  const wf = defineWorkflow({
    name: 'test-wf',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['a', 'b', 'c'] as const,
    schema: z.object({ x: z.string() }),
    detailFields: ['x'],
    handler: async () => {},
  })
  const meta = getByName('test-wf')
  assert.ok(meta)
  assert.deepEqual(meta.steps, ['a', 'b', 'c'])
  assert.deepEqual(meta.systems, ['ucpath'])
  assert.deepEqual(meta.detailFields, ['x'])
  assert.equal(wf.metadata.name, 'test-wf')
})

test('defineWorkflow: step tuple is typed — typo would be a compile error', () => {
  // This test exists to document the intent; the actual check happens at compile time.
  const wf = defineWorkflow({
    name: 'typed-steps',
    systems: [],
    steps: ['only-step'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      // @ts-expect-error — 'typo' is not in steps
      await ctx.step('typo', async () => {})
      // legal:
      await ctx.step('only-step', async () => {})
    },
  })
  assert.equal(wf.config.name, 'typed-steps')
})
```

- [ ] **Step 10.2: Run test; expect FAIL.**

Run: `npm test -- tests/unit/core/workflow.test.ts`
Expected: FAIL — defineWorkflow missing.

- [ ] **Step 10.3: Implement defineWorkflow.**

```ts
// src/core/workflow.ts
import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata } from './types.js'
import { register } from './registry.js'

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const metadata: WorkflowMetadata = {
    name: config.name,
    steps: config.steps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []) as string[],
  }
  register(metadata)
  return { config, metadata }
}
```

- [ ] **Step 10.4: Re-export from barrel.**

```ts
// src/core/index.ts
export type * from './types.js'
export { register, getAll, getByName, clear } from './registry.js'
export { defineWorkflow } from './workflow.js'
```

- [ ] **Step 10.5: Run tests; expect PASS.**

Run: `npm run typecheck && npm test -- tests/unit/core/workflow.test.ts`
Expected: typecheck clean, PASS.

- [ ] **Step 10.6: Commit.**

```bash
git add src/core/workflow.ts src/core/index.ts tests/unit/core/workflow.test.ts
git commit -m "feat(core): defineWorkflow registers metadata with typed steps"
```

---

## Task 11: runWorkflow — single-item execution

**Files:**
- Modify: `src/core/workflow.ts`
- Modify: `tests/unit/core/workflow.test.ts`

- [ ] **Step 11.1: Write the failing test.**

```ts
// Add to tests/unit/core/workflow.test.ts
import { runWorkflow } from '../../../src/core/workflow.js'
import type { SystemConfig } from '../../../src/core/types.js'

test('runWorkflow: validates data against schema before launching', async () => {
  const wf = defineWorkflow({
    name: 'validate-test',
    systems: [],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    handler: async () => {},
  })
  // @ts-expect-error — deliberately wrong type to test runtime validation
  await assert.rejects(() => runWorkflow(wf, { n: 'not-a-number' }), /validation/i)
})

test('runWorkflow: invokes handler with ctx.step typed to step names', async () => {
  const emitted: string[] = []
  const wf = defineWorkflow({
    name: 'run-test',
    systems: [],
    steps: ['one'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      await ctx.step('one', async () => { emitted.push('one-ran') })
    },
  })
  // Inject a no-op launch + tracker for testing.
  await runWorkflow(wf, {}, {
    launchFn: () => Promise.resolve({
      page: {} as import('playwright').Page,
      context: { close: async () => {} } as never,
      browser: { close: async () => {} } as never,
    }),
    trackerStub: true,
  })
  assert.deepEqual(emitted, ['one-ran'])
})
```

- [ ] **Step 11.2: Run tests; expect FAIL.**

Run: `npm test -- tests/unit/core/workflow.test.ts`
Expected: FAIL — runWorkflow missing.

- [ ] **Step 11.3: Implement runWorkflow with tracker integration.**

```ts
// Add to src/core/workflow.ts
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { withTrackedWorkflow } from '../tracker/jsonl.js'
import { withLogContext, log } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'
import type { Ctx, RunOpts, RegisteredWorkflow, BatchResult } from './types.js'
import { randomUUID } from 'node:crypto'
// RunOpts moved to types.ts — see Task 1.

export async function runWorkflow<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  data: TData,
  opts: RunOpts = {},
): Promise<void> {
  // 1. Validate data.
  wf.config.schema.parse(data)

  const itemId = opts.itemId ?? (data as { emplId?: string; docId?: string; email?: string }).emplId
    ?? (data as { docId?: string }).docId
    ?? (data as { email?: string }).email
    ?? randomUUID()

  const run = async (setStep: (s: string) => void, updateData: (d: Record<string, unknown>) => void): Promise<void> => {
    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      tiling: wf.config.tiling,
      launchFn: opts.launchFn,
    })

    const runId = opts.preAssignedRunId ?? randomUUID()
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId,
      runId,
      emitStep: setStep,
      emitData: updateData,
      emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
    })

    const ctx: Ctx<TSteps, TData> = {
      page: (id) => session.page(id),
      step: (name, fn) => stepper.step(name as string, fn),
      parallel: (tasks) => stepper.parallel(tasks),
      updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
      session: {
        page: (id) => session.page(id),
        newWindow: async () => { throw new Error('newWindow not yet implemented') },
        closeWindow: async () => { throw new Error('closeWindow not yet implemented') },
      },
      log,
      isBatch: false,
      runId,
    }

    try {
      await wf.config.handler(ctx, data)
    } finally {
      await session.close()
    }
  }

  if (opts.trackerStub) {
    // Test path: bypass withTrackedWorkflow/withLogContext.
    await run(() => {}, () => {})
    return
  }

  await withLogContext(wf.config.name, String(itemId), async () => {
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      async ({ setStep, updateData }) => run(setStep, updateData),
      { preAssignedRunId: opts.preAssignedRunId },
    )
  })
}
```

- [ ] **Step 11.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/workflow.test.ts`
Expected: PASS.

- [ ] **Step 11.5: Commit.**

```bash
git add src/core/workflow.ts tests/unit/core/workflow.test.ts
git commit -m "feat(core): runWorkflow wires Session + Stepper + tracker"
```

---

## Task 12: SIGINT handler

**Files:**
- Modify: `src/core/workflow.ts`
- Modify: `tests/unit/core/workflow.test.ts`

- [ ] **Step 12.1: Write the failing test.**

```ts
// Add to tests/unit/core/workflow.test.ts

test('runWorkflow: installs SIGINT handler and removes it on completion', async () => {
  const before = process.listeners('SIGINT').length
  const wf = defineWorkflow({
    name: 'sigint-test',
    systems: [],
    steps: ['s1'] as const,
    schema: z.object({}),
    handler: async () => {},
  })
  await runWorkflow(wf, {}, {
    launchFn: () => Promise.resolve({
      page: {} as import('playwright').Page,
      context: { close: async () => {} } as never,
      browser: { close: async () => {} } as never,
    }),
    trackerStub: true,
  })
  const after = process.listeners('SIGINT').length
  assert.equal(after, before, 'SIGINT handler should be removed after run completes')
})
```

- [ ] **Step 12.2: Run test; expect FAIL** (no handler install yet, so test still passes — intentionally skip this if it's a noop, or strengthen to check that a handler IS installed during run).

Actually, strengthen the test:

```ts
test('runWorkflow: installs SIGINT handler during handler execution', async () => {
  let observed: number | null = null
  const wf = defineWorkflow({
    name: 'sigint-observe',
    systems: [],
    steps: ['s1'] as const,
    schema: z.object({}),
    handler: async () => {
      observed = process.listeners('SIGINT').length
    },
  })
  const before = process.listeners('SIGINT').length
  await runWorkflow(wf, {}, {
    launchFn: () => Promise.resolve({
      page: {} as import('playwright').Page,
      context: { close: async () => {} } as never,
      browser: { close: async () => {} } as never,
    }),
    trackerStub: true,
  })
  assert.equal(observed, before + 1, 'handler should see a new SIGINT listener installed')
  assert.equal(process.listeners('SIGINT').length, before, 'listener should be removed after')
})
```

Run: `npm test -- tests/unit/core/workflow.test.ts`
Expected: FAIL (no install).

- [ ] **Step 12.3: Add SIGINT handler install/uninstall in runWorkflow.**

Wrap the `try/finally` block in `run()`:

```ts
// In runWorkflow, replace the try/finally with:
const sigintHandler = async () => {
  try {
    setStep(`${stepper.getCurrentStep() ?? 'sigint'}:failed:interrupted`)
    await session.killChrome()
  } finally {
    process.exit(1)
  }
}
process.on('SIGINT', sigintHandler)

try {
  await wf.config.handler(ctx, data)
} finally {
  process.off('SIGINT', sigintHandler)
  await session.close()
}
```

- [ ] **Step 12.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/workflow.test.ts`
Expected: PASS.

- [ ] **Step 12.5: Commit.**

```bash
git add src/core/workflow.ts tests/unit/core/workflow.test.ts
git commit -m "feat(core): runWorkflow installs SIGINT handler for clean teardown"
```

---

## Task 13: runWorkflowBatch — sequential mode

**Files:**
- Modify: `src/core/workflow.ts`
- Test: `tests/unit/core/batch.test.ts`

- [ ] **Step 13.1: Write the failing test.**

```ts
// tests/unit/core/batch.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow, runWorkflowBatch } from '../../../src/core/workflow.js'

function fakeSlot() {
  return {
    page: { goto: async () => {}, isClosed: () => false } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

test('runWorkflowBatch (sequential): processes items in order, browsers reused', async () => {
  const processed: string[] = []
  let launchCalls = 0

  const wf = defineWorkflow({
    name: 'batch-seq',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ name: z.string() }),
    batch: { mode: 'sequential' },
    handler: async (ctx, data) => {
      processed.push(data.name)
      await ctx.step('s1', async () => {})
    },
  })

  const result = await runWorkflowBatch(
    wf,
    [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
    {
      launchFn: () => { launchCalls++; return Promise.resolve(fakeSlot()) },
      trackerStub: true,
    },
  )

  assert.deepEqual(processed, ['a', 'b', 'c'])
  assert.equal(launchCalls, 1, 'browser should launch once and be reused')
  assert.equal(result.total, 3)
  assert.equal(result.succeeded, 3)
  assert.equal(result.failed, 0)
})

test('runWorkflowBatch (sequential): continues after one item fails', async () => {
  const wf = defineWorkflow({
    name: 'batch-fail',
    systems: [],
    steps: ['s1'] as const,
    schema: z.object({ ok: z.boolean() }),
    batch: { mode: 'sequential' },
    handler: async (_ctx, data) => {
      if (!data.ok) throw new Error('deliberate')
    },
  })
  const result = await runWorkflowBatch(
    wf,
    [{ ok: true }, { ok: false }, { ok: true }],
    { launchFn: () => Promise.resolve(fakeSlot()), trackerStub: true },
  )
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.errors[0].error, 'deliberate')
})
```

- [ ] **Step 13.2: Run test; expect FAIL.**

Run: `npm test -- tests/unit/core/batch.test.ts`
Expected: FAIL — runWorkflowBatch missing.

- [ ] **Step 13.3: Implement runWorkflowBatch sequential path.**

```ts
// Add to src/core/workflow.ts

export async function runWorkflowBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts & { dryRun?: boolean } = {},
): Promise<BatchResult> {
  const batch = wf.config.batch
  if (batch?.mode === 'pool') {
    // Delegated to Task 15.
    return runWorkflowPool(wf, items, opts)
  }

  // Sequential.
  // Validate all items upfront — reject before launching anything.
  items.forEach((item) => wf.config.schema.parse(item))

  const session = await Session.launch(wf.config.systems, {
    authChain: wf.config.authChain,
    tiling: wf.config.tiling,
    launchFn: opts.launchFn,
  })

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const itemId = String(randomUUID())
      const runId = randomUUID()
      const stepper = new Stepper({
        workflow: wf.config.name,
        itemId,
        runId,
        emitStep: () => {},
        emitData: () => {},
        emitFailed: () => {},
      })
      const ctx: Ctx<TSteps, TData> = {
        page: (id) => session.page(id),
        step: (name, fn) => stepper.step(name as string, fn),
        parallel: (tasks) => stepper.parallel(tasks),
        updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
        session: { page: (id) => session.page(id), newWindow: async () => { throw new Error('x') }, closeWindow: async () => {} },
        log,
        isBatch: true,
        runId,
      }
      try {
        // Between-items hooks, skipped on first iteration.
        if (i > 0 && batch?.betweenItems) {
          for (const hook of batch.betweenItems) {
            if (hook === 'reset-browsers' || hook === 'navigate-home') {
              for (const s of wf.config.systems) await session.reset(s.id)
            } else if (hook === 'health-check') {
              for (const s of wf.config.systems) {
                if (!(await session.healthCheck(s.id))) throw new Error(`health-check failed for ${s.id}`)
              }
            }
          }
        }
        await wf.config.handler(ctx, item)
        result.succeeded++
      } catch (err) {
        result.failed++
        result.errors.push({ item, error: classifyError(err) })
      }
    }
  } finally {
    await session.close()
  }
  return result
}
```

- [ ] **Step 13.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/batch.test.ts`
Expected: PASS.

- [ ] **Step 13.5: Commit.**

```bash
git add src/core/workflow.ts tests/unit/core/batch.test.ts
git commit -m "feat(core): runWorkflowBatch sequential mode with betweenItems hooks"
```

---

## Task 14: preEmitPending logic

**Files:**
- Modify: `src/core/workflow.ts`
- Modify: `tests/unit/core/batch.test.ts`

- [ ] **Step 14.1: Write the failing test.**

```ts
// Add to tests/unit/core/batch.test.ts

test('runWorkflowBatch (preEmitPending): emits pending for all items before handler starts', async () => {
  const pendingEmissions: string[] = []
  const wf = defineWorkflow({
    name: 'batch-pre',
    systems: [],
    steps: ['s1'] as const,
    schema: z.object({ id: z.string() }),
    batch: { mode: 'sequential', preEmitPending: true },
    handler: async () => {},
  })
  await runWorkflowBatch(
    wf,
    [{ id: '1' }, { id: '2' }, { id: '3' }],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerStub: true,
      onPreEmitPending: (item) => pendingEmissions.push((item as { id: string }).id),
    },
  )
  assert.deepEqual(pendingEmissions, ['1', '2', '3'])
})
```

- [ ] **Step 14.2: Run test; expect FAIL** (option missing).

Run: `npm test -- tests/unit/core/batch.test.ts`
Expected: FAIL.

- [ ] **Step 14.3: Invoke `onPreEmitPending` before launching session.**

`RunOpts.onPreEmitPending` is already declared in `src/core/types.ts` (see Task 1). This step only adds the invocation in `runWorkflowBatch`.

```ts
// In runWorkflowBatch, after schema validation, before session launch:
if (wf.config.batch?.preEmitPending && opts.onPreEmitPending) {
  for (const item of items) opts.onPreEmitPending(item)
}
```

- [ ] **Step 14.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/batch.test.ts`
Expected: PASS.

- [ ] **Step 14.5: Commit.**

```bash
git add src/core/workflow.ts tests/unit/core/batch.test.ts
git commit -m "feat(core): preEmitPending invokes callback for each item upfront"
```

---

## Task 15: runWorkflowPool — worker-per-browser

**Files:**
- Create: `src/core/pool.ts`
- Test: `tests/unit/core/pool.test.ts`
- Modify: `src/core/workflow.ts`

- [ ] **Step 15.1: Write the failing test.**

```ts
// tests/unit/core/pool.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { runWorkflowPool } from '../../../src/core/pool.js'

function fakeSlot() {
  return {
    page: {} as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

test('runWorkflowPool: distributes items across N workers, each with own Session', async () => {
  const workerUsed: string[] = []
  let launchCalls = 0
  const wf = defineWorkflow({
    name: 'pool-test',
    systems: [{ id: 'ukg', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    batch: { mode: 'pool', poolSize: 2 },
    handler: async (ctx, data) => {
      await ctx.step('s1', async () => {
        workerUsed.push(`n=${data.n}`)
        await new Promise((r) => setTimeout(r, 5))
      })
    },
  })
  const result = await runWorkflowPool(
    wf,
    [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
    { launchFn: () => { launchCalls++; return Promise.resolve(fakeSlot()) }, trackerStub: true },
  )
  assert.equal(result.total, 4)
  assert.equal(result.succeeded, 4)
  assert.equal(launchCalls, 2, 'should launch once per worker')
})
```

- [ ] **Step 15.2: Run test; expect FAIL.**

Run: `npm test -- tests/unit/core/pool.test.ts`
Expected: FAIL.

- [ ] **Step 15.3: Implement runWorkflowPool.**

```ts
// src/core/pool.ts
import type { RegisteredWorkflow, BatchResult, Ctx, RunOpts } from './types.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { log } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'
import { randomUUID } from 'node:crypto'

export async function runWorkflowPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = wf.config.batch?.poolSize ?? 4
  const queue = [...items]
  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  // Validate all items upfront.
  items.forEach((item) => wf.config.schema.parse(item))

  if (wf.config.batch?.preEmitPending && opts.onPreEmitPending) {
    for (const item of items) opts.onPreEmitPending(item)
  }

  async function worker(): Promise<void> {
    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      tiling: wf.config.tiling,
      launchFn: opts.launchFn,
    })
    try {
      while (queue.length > 0) {
        const item = queue.shift()
        if (item === undefined) break
        const runId = randomUUID()
        const stepper = new Stepper({
          workflow: wf.config.name, itemId: randomUUID(), runId,
          emitStep: () => {}, emitData: () => {}, emitFailed: () => {},
        })
        const ctx: Ctx<TSteps, TData> = {
          page: (id) => session.page(id),
          step: (name, fn) => stepper.step(name as string, fn),
          parallel: (tasks) => stepper.parallel(tasks),
          updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
          session: { page: (id) => session.page(id), newWindow: async () => { throw new Error('x') }, closeWindow: async () => {} },
          log, isBatch: true, runId,
        }
        try {
          await wf.config.handler(ctx, item)
          result.succeeded++
        } catch (err) {
          result.failed++
          result.errors.push({ item, error: classifyError(err) })
        }
      }
    } finally {
      await session.close()
    }
  }

  await Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, () => worker()))
  return result
}
```

- [ ] **Step 15.4: Run tests; expect PASS.**

Run: `npm test -- tests/unit/core/pool.test.ts`
Expected: PASS.

- [ ] **Step 15.5: Commit.**

```bash
git add src/core/pool.ts tests/unit/core/pool.test.ts
git commit -m "feat(core): runWorkflowPool for worker-per-browser batch mode"
```

---

## Task 16: Barrel export + circular-import cleanup

**Files:**
- Modify: `src/core/index.ts`

- [ ] **Step 16.1: Update barrel to export full public API.**

```ts
// src/core/index.ts
export type * from './types.js'
export { register, getAll, getByName, clear } from './registry.js'
export { defineWorkflow, runWorkflow, runWorkflowBatch } from './workflow.js'
export { runWorkflowPool } from './pool.js'
export { Session } from './session.js'
export { Stepper } from './stepper.js'
```

- [ ] **Step 16.2: Run full test suite + typecheck.**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 16.3: Commit.**

```bash
git add src/core/index.ts
git commit -m "feat(core): export full public API from barrel"
```

---

## Task 17: Move page-health.ts from utils to core

**Files:**
- Move: `src/utils/page-health.ts` → `src/core/page-health.ts`
- Modify: all importers

- [ ] **Step 17.1: Find all current importers.**

Run: `grep -rn "from ['\"].*utils/page-health" src/ tests/`
Record output — you'll update each one.

- [ ] **Step 17.2: Move with git mv to preserve history.**

```bash
git mv src/utils/page-health.ts src/core/page-health.ts
```

- [ ] **Step 17.3: Update each importer's path.**

For each file listed in Step 17.1, change `../utils/page-health` → `../core/page-health` (adjust relative depth as needed).

- [ ] **Step 17.4: Add to barrel.**

```ts
// Append to src/core/index.ts
export * from './page-health.js'
```

- [ ] **Step 17.5: Typecheck + test.**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 17.6: Commit.**

```bash
git add -A
git commit -m "refactor(core): move page-health from utils to core"
```

---

## Task 18: Delete unused WorkflowSession class

**Files:**
- Delete: `src/browser/session.ts`
- Verify: zero importers

- [ ] **Step 18.1: Confirm zero importers.**

Run: `grep -rn "browser/session" src/ tests/`
Expected: no results (or only the file itself).

If any importers exist, STOP and investigate — the spec claimed zero usage but verify in situ.

- [ ] **Step 18.2: Delete the file.**

```bash
git rm src/browser/session.ts
```

- [ ] **Step 18.3: Update `src/browser/CLAUDE.md`** (if it references the deleted class).

Find: any mention of `WorkflowSession` or `session.ts`
Remove those sections, or add a note that the class was removed in favor of `src/core/Session`.

- [ ] **Step 18.4: Typecheck + test.**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 18.5: Commit.**

```bash
git add -A
git commit -m "refactor(browser): remove unused WorkflowSession class"
```

---

## Task 19: SSE endpoint `GET /api/workflows`

**Files:**
- Modify: `src/tracker/dashboard.ts`
- Test: `tests/unit/tracker/workflows-endpoint.test.ts`

- [ ] **Step 19.1: Find the existing route registration code.**

Run: `grep -n "app\.\(get\|use\)\|router" src/tracker/dashboard.ts`
Read the file to understand the server framework in use.

- [ ] **Step 19.2: Write the failing test.**

```ts
// tests/unit/tracker/workflows-endpoint.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { clear } from '../../../src/core/registry.js'
import { buildWorkflowsHandler } from '../../../src/tracker/dashboard.js'

test('GET /api/workflows returns registered metadata', () => {
  clear()
  defineWorkflow({
    name: 'wf-a',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['s1', 's2'] as const,
    schema: z.object({}),
    detailFields: [],
    handler: async () => {},
  })
  const handler = buildWorkflowsHandler()
  const result = handler()
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'wf-a')
  assert.deepEqual(result[0].steps, ['s1', 's2'])
})
```

- [ ] **Step 19.3: Run test; expect FAIL.**

Run: `npm test -- tests/unit/tracker/workflows-endpoint.test.ts`
Expected: FAIL.

- [ ] **Step 19.4: Export `buildWorkflowsHandler` + register route.**

In `src/tracker/dashboard.ts`:

```ts
import { getAll as getAllWorkflows } from '../core/registry.js'

export function buildWorkflowsHandler() {
  return () => getAllWorkflows()
}

// Inside the route setup (adjust to actual framework — likely express):
app.get('/api/workflows', (_req, res) => res.json(buildWorkflowsHandler()()))
```

- [ ] **Step 19.5: Run test; expect PASS.**

Run: `npm test -- tests/unit/tracker/workflows-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 19.6: Commit.**

```bash
git add src/tracker/dashboard.ts tests/unit/tracker/workflows-endpoint.test.ts
git commit -m "feat(tracker): expose GET /api/workflows from registry"
```

---

## Task 20: Frontend WorkflowsProvider + useWorkflows()

**Files:**
- Create: `src/dashboard/workflows-context.tsx`
- Modify: `src/dashboard/main.tsx` (or app root)

- [ ] **Step 20.1: Locate the app root.**

Run: `grep -rn "ReactDOM\.createRoot\|createRoot" src/dashboard/`
Note the file — that's where the provider wraps.

- [ ] **Step 20.2: Create the context module.**

```tsx
// src/dashboard/workflows-context.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export interface WorkflowMetadata {
  name: string
  steps: string[]
  systems: string[]
  detailFields: string[]
}

const WorkflowsContext = createContext<WorkflowMetadata[] | null>(null)

export function WorkflowsProvider({ children }: { children: ReactNode }) {
  const [workflows, setWorkflows] = useState<WorkflowMetadata[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/workflows')
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(setWorkflows)
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <div>Failed to load workflow config: {error}</div>
  if (!workflows) return <div>Loading…</div>
  return <WorkflowsContext.Provider value={workflows}>{children}</WorkflowsContext.Provider>
}

export function useWorkflows(): WorkflowMetadata[] {
  const ctx = useContext(WorkflowsContext)
  if (!ctx) throw new Error('useWorkflows must be used inside WorkflowsProvider')
  return ctx
}

export function useWorkflow(name: string): WorkflowMetadata | undefined {
  return useWorkflows().find((w) => w.name === name)
}
```

- [ ] **Step 20.3: Wrap the app root in WorkflowsProvider.**

In `src/dashboard/main.tsx` (or equivalent):

```tsx
import { WorkflowsProvider } from './workflows-context'

// wrap:
<WorkflowsProvider>
  <App />
</WorkflowsProvider>
```

- [ ] **Step 20.4: Typecheck.**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 20.5: Commit.**

```bash
git add src/dashboard/workflows-context.tsx src/dashboard/main.tsx
git commit -m "feat(dashboard): add WorkflowsProvider that fetches /api/workflows"
```

---

## Task 21: Swap consumers from static WF_CONFIG to useWorkflows()

**Files:**
- Modify: `src/dashboard/components/types.ts`
- Modify: every component that imports `WF_CONFIG`

- [ ] **Step 21.1: Find every WF_CONFIG consumer.**

Run: `grep -rn "WF_CONFIG" src/dashboard/`
Record the list.

- [ ] **Step 21.2: For each consumer file, replace the import + usage.**

Example before:
```tsx
import { WF_CONFIG } from './types'
const steps = WF_CONFIG[workflow].steps
```

Example after:
```tsx
import { useWorkflow } from '../workflows-context'
const wf = useWorkflow(workflow)
const steps = wf?.steps ?? []
```

For non-component modules that can't use hooks (unlikely in the frontend, but check), push the lookup up to the caller component.

- [ ] **Step 21.3: Delete the static WF_CONFIG from `src/dashboard/components/types.ts`.**

Keep the TypeScript types (e.g. `WorkflowName`) — delete only the constant.

- [ ] **Step 21.4: Typecheck + dashboard build.**

Run: `npm run typecheck && npm run build:dashboard`
Expected: both clean.

- [ ] **Step 21.5: Commit.**

```bash
git add -A
git commit -m "refactor(dashboard): consume useWorkflows instead of static WF_CONFIG"
```

---

## Task 22: End-to-end integration test — mock workflow

**Files:**
- Create: `tests/integration/core/mock-workflow.test.ts`

- [ ] **Step 22.1: Write the integration test.**

```ts
// tests/integration/core/mock-workflow.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'

test('integration: mock workflow with 2 systems runs end-to-end', async () => {
  const events: string[] = []

  const wf = defineWorkflow({
    name: 'mock-e2e',
    systems: [
      { id: 'sysA', login: async () => { events.push('login-A') } },
      { id: 'sysB', login: async () => { events.push('login-B') } },
    ],
    steps: ['extract', 'submit'] as const,
    schema: z.object({ name: z.string() }),
    detailFields: ['name'],
    handler: async (ctx, data) => {
      await ctx.step('extract', async () => {
        ctx.updateData({ extractedAt: 'now' })
        events.push(`extract:${data.name}`)
      })
      await ctx.step('submit', async () => {
        const pageA = await ctx.page('sysA')
        const pageB = await ctx.page('sysB')
        events.push(`submit:${!!pageA}:${!!pageB}`)
      })
    },
  })

  const fakeSlot = () => ({
    page: { isClosed: () => false, close: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  })

  await runWorkflow(
    wf,
    { name: 'Alice' },
    { launchFn: () => Promise.resolve(fakeSlot()), trackerStub: true },
  )

  // Auth happened first (interleaved), then handler ran.
  assert.ok(events.indexOf('login-A') < events.indexOf('extract:Alice'))
  assert.ok(events.indexOf('login-B') < events.indexOf('submit:true:true'))
  assert.ok(events.includes('extract:Alice'))
  assert.ok(events.includes('submit:true:true'))
})
```

- [ ] **Step 22.2: Run the integration test.**

Run: `npm test -- tests/integration/core/mock-workflow.test.ts`
Expected: PASS.

- [ ] **Step 22.3: Commit.**

```bash
git add tests/integration/core/mock-workflow.test.ts
git commit -m "test(core): end-to-end integration test for kernel with mock workflow"
```

---

## Task 23: Full suite check + kernel-done tag

**Files:**
- None (validation only)

- [ ] **Step 23.1: Run the full suite.**

Run: `npm run typecheck && npm run typecheck:all && npm test && npm run build:dashboard`
Expected: all green.

- [ ] **Step 23.2: Inspect line counts.**

Run: `wc -l src/core/*.ts src/core/*.tsx 2>/dev/null`
Expected: total ≤ 800 lines. If over, flag to user — spec success criterion.

- [ ] **Step 23.3: Tag the commit.**

```bash
git tag kernel-build-complete
```

- [ ] **Step 23.4: Write the session checkpoint.**

Create `docs/superpowers/sessions/02-kernel-execution-checkpoint.md` summarizing:
- Tasks 0–23 complete
- What the next migration session should read first (this plan + the spec)
- Any gotchas discovered during the build
- Next step: migrate work-study (Session 2 continues, or the user ends the session and resumes later)

- [ ] **Step 23.5: Commit.**

```bash
git add docs/superpowers/sessions/02-kernel-execution-checkpoint.md
git commit -m "docs: kernel build complete — checkpoint before migrations"
```

---

## Scope boundary

This plan ends at Task 23. Workflow migrations (work-study, emergency-contact, eid-lookup, kronos-reports, onboarding, separations) are **not** in this plan — each will be planned and executed incrementally in subsequent sessions, because we want to learn from the first migration before committing to all six.

When Task 23 completes, pause. The user decides whether to continue into the first migration in the same literal conversation or start a fresh one. Either way, the next plan file to write is `docs/superpowers/plans/2026-XX-XX-migrate-work-study-plan.md`.
