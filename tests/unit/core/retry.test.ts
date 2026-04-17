import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'

const mockLaunchFn = () =>
  Promise.resolve({
    page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  })

test('ctx.retry returns result on first success', async () => {
  let attempts = 0
  const wf = defineWorkflow({
    name: 'retry-first-success',
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      await ctx.step('only', async () => {
        const v = await ctx.retry(
          async () => {
            attempts++
            return 'ok'
          },
          { attempts: 5, backoffMs: 0 },
        )
        assert.equal(v, 'ok')
      })
    },
  })
  await runWorkflow(wf, {}, { launchFn: mockLaunchFn, trackerStub: true })
  assert.equal(attempts, 1)
})

test('ctx.retry retries until success, then returns', async () => {
  let attempts = 0
  const wf = defineWorkflow({
    name: 'retry-until-success',
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      await ctx.step('only', async () => {
        const v = await ctx.retry(
          async () => {
            attempts++
            if (attempts < 3) throw new Error('flake')
            return 'ok'
          },
          { attempts: 5, backoffMs: 0 },
        )
        assert.equal(v, 'ok')
      })
    },
  })
  await runWorkflow(wf, {}, { launchFn: mockLaunchFn, trackerStub: true })
  assert.equal(attempts, 3)
})

test('ctx.retry throws after exhausting attempts', async () => {
  let attempts = 0
  const wf = defineWorkflow({
    name: 'retry-exhaust',
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      await ctx.step('only', async () => {
        await assert.rejects(
          ctx.retry(
            async () => {
              attempts++
              throw new Error('nope')
            },
            { attempts: 3, backoffMs: 0 },
          ),
          /nope/,
        )
      })
    },
  })
  await runWorkflow(wf, {}, { launchFn: mockLaunchFn, trackerStub: true })
  assert.equal(attempts, 3)
})

test('ctx.retry calls onAttempt for each failure', async () => {
  const callbackErrs: Array<{ attempt: number; msg: string }> = []
  const wf = defineWorkflow({
    name: 'retry-callback',
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      await ctx.step('only', async () => {
        await assert.rejects(
          ctx.retry(
            async () => {
              throw new Error('boom')
            },
            {
              attempts: 3,
              backoffMs: 0,
              onAttempt: (n, err) => {
                callbackErrs.push({ attempt: n, msg: (err as Error).message })
              },
            },
          ),
          /boom/,
        )
      })
    },
  })
  await runWorkflow(wf, {}, { launchFn: mockLaunchFn, trackerStub: true })
  assert.deepEqual(callbackErrs, [
    { attempt: 1, msg: 'boom' },
    { attempt: 2, msg: 'boom' },
    { attempt: 3, msg: 'boom' },
  ])
})

test('ctx.retry respects backoffMs between attempts', async () => {
  let attempts = 0
  const timestamps: number[] = []
  const wf = defineWorkflow({
    name: 'retry-backoff',
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({}),
    handler: async (ctx) => {
      await ctx.step('only', async () => {
        await ctx.retry(
          async () => {
            timestamps.push(Date.now())
            attempts++
            if (attempts < 3) throw new Error('flake')
            return 'ok'
          },
          { attempts: 5, backoffMs: 10 },
        )
      })
    },
  })
  const start = Date.now()
  await runWorkflow(wf, {}, { launchFn: mockLaunchFn, trackerStub: true })
  const total = Date.now() - start
  assert.equal(attempts, 3)
  // Linear backoff: wait 10ms after attempt 1, 20ms after attempt 2 → total ≥ 30ms
  assert.ok(total >= 30, `expected at least 30ms delay across backoffs, got ${total}ms`)
})
