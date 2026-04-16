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
    page: { isClosed: () => false, close: async () => {}, bringToFront: async () => {} } as unknown as import('playwright').Page,
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
