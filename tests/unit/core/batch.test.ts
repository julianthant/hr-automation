import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow, runWorkflowBatch } from '../../../src/core/workflow.js'

function fakeSlot() {
  return {
    page: { goto: async () => {}, isClosed: () => false, bringToFront: async () => {} } as unknown as import('playwright').Page,
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
