import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { runWorkflowPool } from '../../../src/core/pool.js'

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
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
