import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { runWorkflowPool } from '../../../src/core/pool.js'

const fakeLaunch = () => Promise.resolve({
  page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
  context: { close: async () => {} } as never,
  browser: { close: async () => {} } as never,
})

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

function readTrackerEntries(dir: string, workflow: string): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(dir, `${workflow}-${today}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function cleanupDir(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
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

test('runWorkflowPool emits per-item tracker entries', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'pool-tracker-'))
  t.after(() => cleanupDir(tmp))
  const wfName = `pool-tracker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    batch: { mode: 'pool', poolSize: 2 },
    handler: async (ctx) => {
      await ctx.step('only', async () => {})
    },
  })

  const result = await runWorkflowPool(
    wf,
    [{ k: 'a' }, { k: 'b' }],
    { launchFn: () => Promise.resolve(fakeSlot()), trackerDir: tmp },
  )
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)

  const entries = readTrackerEntries(tmp, wfName)
  // 2 items × (pending + running + done) = 6 minimum.
  assert.ok(entries.length >= 6, `expected ≥6 tracker entries, got ${entries.length}`)
  assert.ok(entries.some((e) => e.status === 'pending'), 'missing pending status')
  assert.ok(entries.some((e) => e.status === 'running'), 'missing running status')
  assert.ok(entries.some((e) => e.status === 'done'), 'missing done status')

  const byRun = new Map<string, Set<string>>()
  for (const e of entries) {
    const rid = e.runId as string
    if (!byRun.has(rid)) byRun.set(rid, new Set())
    byRun.get(rid)!.add(e.status as string)
  }
  assert.equal(byRun.size, 2, 'expected 2 distinct runIds')
  for (const statuses of byRun.values()) {
    assert.ok(statuses.has('pending'), 'run missing pending')
    assert.ok(statuses.has('done'), 'run missing done')
  }
})

test('runWorkflowPool preEmitPending pairs item with runId', async () => {
  const pendingEmissions: Array<{ k: string; runId: string }> = []
  const wf = defineWorkflow({
    name: 'pool-pre',
    systems: [],
    steps: ['s1'] as const,
    schema: z.object({ k: z.string() }),
    batch: { mode: 'pool', poolSize: 2, preEmitPending: true },
    handler: async () => {},
  })
  await runWorkflowPool(
    wf,
    [{ k: 'a' }, { k: 'b' }, { k: 'c' }],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerStub: true,
      onPreEmitPending: (item, runId) =>
        pendingEmissions.push({ k: (item as { k: string }).k, runId }),
    },
  )
  assert.deepEqual(pendingEmissions.map((e) => e.k), ['a', 'b', 'c'])
  const unique = new Set(pendingEmissions.map((e) => e.runId))
  assert.equal(unique.size, 3, 'runIds must be unique per item')
})

test('runWorkflowPool: opts.poolSize overrides wf.config.batch.poolSize', async () => {
  let launchCalls = 0
  const wf = defineWorkflow({
    name: 'pool-override',
    systems: [{ id: 'ukg', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    // Config default is 2 — runtime override below should bring this to 5.
    batch: { mode: 'pool', poolSize: 2 },
    handler: async (ctx) => {
      await ctx.step('s1', async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    },
  })
  const items = Array.from({ length: 10 }, (_, i) => ({ n: i }))
  const result = await runWorkflowPool(wf, items, {
    launchFn: () => { launchCalls++; return Promise.resolve(fakeSlot()) },
    trackerStub: true,
    poolSize: 5,
  })
  assert.equal(result.total, 10)
  assert.equal(result.succeeded, 10)
  assert.equal(launchCalls, 5, 'opts.poolSize (5) should win over wf.config.batch.poolSize (2)')
})

test('runWorkflowPool: initialData merges into each item pending entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hrauto-pool-init-'))

  const wf = defineWorkflow({
    name: 'test-pool-init',
    systems: [{ id: 'sys', login: async () => {} }],
    steps: ['go'] as const,
    schema: z.object({ n: z.number() }),
    tiling: 'single',
    authChain: 'sequential',
    batch: { mode: 'pool', poolSize: 2 },
    getName: (d) => d.label ?? '',
    getId: (d) => d.label ?? '',
    initialData: (input) => ({ label: `item-${input.n}` }),
    handler: async (ctx) => { ctx.markStep('go') },
  })

  await runWorkflowPool(wf, [{ n: 1 }, { n: 2 }], { launchFn: fakeLaunch, trackerDir: dir })

  const entryFiles = readdirSync(dir).filter((f) =>
    f.startsWith('test-pool-init-') && f.endsWith('.jsonl') && !f.endsWith('-logs.jsonl')
  )
  assert.ok(entryFiles.length > 0, 'tracker jsonl file exists')
  const lines = readFileSync(join(dir, entryFiles[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const pendings = lines.filter((l: any) => l.status === 'pending')
  assert.equal(pendings.length, 2, `expected 2 pending entries, got ${pendings.length}`)
  const labels = pendings.map((p: any) => p.data.label).sort()
  assert.deepEqual(labels, ['item-1', 'item-2'])
})

test('runWorkflowPool: falls back to wf.config.batch.poolSize when opts.poolSize is undefined', async () => {
  let launchCalls = 0
  const wf = defineWorkflow({
    name: 'pool-config-default',
    systems: [{ id: 'ukg', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ n: z.number() }),
    batch: { mode: 'pool', poolSize: 3 },
    handler: async (ctx) => {
      await ctx.step('s1', async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    },
  })
  const items = Array.from({ length: 8 }, (_, i) => ({ n: i }))
  const result = await runWorkflowPool(wf, items, {
    launchFn: () => { launchCalls++; return Promise.resolve(fakeSlot()) },
    trackerStub: true,
    // poolSize intentionally omitted — should fall back to config (3)
  })
  assert.equal(result.succeeded, 8)
  assert.equal(launchCalls, 3, 'should fall back to wf.config.batch.poolSize (3)')
})

test('runWorkflowPool: emits exactly one workflow_start + one workflow_end(done) per batch (across N workers)', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'pool-one-instance-'))
  t.after(() => cleanupDir(tmp))
  const wfName = `pool-oneinst-${Date.now()}`
  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({ k: z.string() }),
    batch: { mode: 'pool', poolSize: 2 },
    handler: async (ctx) => { await ctx.step('s1', async () => {}) },
  })

  await runWorkflowPool(
    wf,
    [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerDir: tmp,
      deriveItemId: (item: unknown) => (item as { k: string }).k,
    },
  )

  const sessPath = join(tmp, 'sessions.jsonl')
  assert.ok(existsSync(sessPath), 'sessions.jsonl written')
  const events = readFileSync(sessPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const starts = events.filter((e: any) => e.type === 'workflow_start')
  const ends = events.filter((e: any) => e.type === 'workflow_end')
  assert.equal(starts.length, 1, 'one workflow_start per batch')
  assert.equal(ends.length, 1, 'one workflow_end per batch')
  assert.equal(ends[0].finalStatus, 'done')

  // All items should share the same instance name.
  const entries = readTrackerEntries(tmp, wfName)
  const dones = entries.filter((e: any) => e.status === 'done')
  assert.equal(dones.length, 4, 'four done entries')
  const instance = (dones[0] as any).data.instance
  assert.ok(instance, 'instance stamped')
  assert.ok(
    dones.every((e: any) => e.data.instance === instance),
    'all items share pool instance',
  )

  // auth_start fires once per worker × system (each worker has its own Session
  // and authenticates independently) — but all attributed to the same instance.
  const authStarts = events.filter((e: any) => e.type === 'auth_start')
  // Pool size 2, 1 system → 2 auth_starts
  assert.equal(authStarts.length, 2, 'auth_start fires per worker (×1 system)')
  assert.ok(authStarts.every((e: any) => e.workflowInstance === instance), 'all auth_starts attribute to batch instance')
})
