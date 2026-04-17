import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflowBatch } from '../../../src/core/workflow.js'
import { DEFAULT_DIR } from '../../../src/tracker/jsonl.js'

function fakeSlot() {
  return {
    page: { goto: async () => {}, isClosed: () => false, bringToFront: async () => {} } as unknown as import('playwright').Page,
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

test('runWorkflowBatch (preEmitPending): emits pending for all items with a pre-assigned runId', async () => {
  const pendingEmissions: Array<{ id: string; runId: string }> = []
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
      onPreEmitPending: (item, runId) =>
        pendingEmissions.push({ id: (item as { id: string }).id, runId }),
    },
  )
  assert.deepEqual(
    pendingEmissions.map((e) => e.id),
    ['1', '2', '3'],
  )
  // Each pre-emission must carry a non-empty runId string so callers can
  // write the initial `pending` row with the same runId the handler will use.
  for (const emission of pendingEmissions) {
    assert.ok(emission.runId && typeof emission.runId === 'string', 'runId must be provided')
  }
  // All three runIds should be distinct.
  const unique = new Set(pendingEmissions.map((e) => e.runId))
  assert.equal(unique.size, 3, 'runIds must be unique per item')
})

test('runWorkflowBatch sequential emits per-item tracker entries', async (t) => {
  const wfName = `batch-tracker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  t.after(() => cleanupWorkflow(wfName))

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ k: z.string() }),
    batch: { mode: 'sequential' },
    handler: async (ctx) => {
      await ctx.step('only', async () => {})
    },
  })

  const result = await runWorkflowBatch(
    wf,
    [{ k: 'a' }, { k: 'b' }],
    { launchFn: () => Promise.resolve(fakeSlot()) },
  )
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 0)

  const entries = readTrackerEntries(wfName)
  // Each item gets pending, at least one running (step emit), and a done.
  // 2 items × (pending + running + done) = 6 minimum.
  assert.ok(entries.length >= 6, `expected ≥6 tracker entries, got ${entries.length}`)
  assert.ok(entries.some((e) => e.status === 'pending'), 'missing pending status')
  assert.ok(entries.some((e) => e.status === 'running'), 'missing running status')
  assert.ok(entries.some((e) => e.status === 'done'), 'missing done status')

  // Each distinct runId must have pending + done entries paired.
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

test('runWorkflowBatch sequential emits per-item failed tracker entry and continues', async (t) => {
  const wfName = `batch-tracker-fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  t.after(() => cleanupWorkflow(wfName))

  const wf = defineWorkflow({
    name: wfName,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ ok: z.boolean() }),
    batch: { mode: 'sequential' },
    handler: async (ctx, data) => {
      await ctx.step('only', async () => {
        if (!data.ok) throw new Error('deliberate')
      })
    },
  })

  const result = await runWorkflowBatch(
    wf,
    [{ ok: true }, { ok: false }, { ok: true }],
    { launchFn: () => Promise.resolve(fakeSlot()) },
  )
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)

  const entries = readTrackerEntries(wfName)
  assert.ok(entries.some((e) => e.status === 'failed'), 'expected a failed entry')
  assert.ok(entries.some((e) => e.status === 'done'), 'expected a done entry (loop continued)')
})
