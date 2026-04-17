import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { runWorkflowPool } from '../../../src/core/pool.js'
import { DEFAULT_DIR } from '../../../src/tracker/jsonl.js'

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  }
}

function readTrackerEntries(workflow: string): Array<Record<string, unknown>> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(DEFAULT_DIR, `${workflow}-${today}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function cleanupWorkflow(workflow: string) {
  const today = new Date().toISOString().slice(0, 10)
  for (const suffix of [`.jsonl`, `-logs.jsonl`]) {
    const path = join(DEFAULT_DIR, `${workflow}-${today}${suffix}`)
    if (existsSync(path)) rmSync(path)
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

test('runWorkflowPool emits per-item tracker entries', async (t) => {
  const wfName = `pool-tracker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  t.after(() => cleanupWorkflow(wfName))

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
    { launchFn: () => Promise.resolve(fakeSlot()) },
  )
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)

  const entries = readTrackerEntries(wfName)
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
