import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runWorkflow } from '../../../src/core/workflow.js'
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
  await runWorkflow(wf, {}, {
    launchFn: () => Promise.resolve({
      page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
      context: { close: async () => {} } as never,
      browser: { close: async () => {} } as never,
    }),
    trackerStub: true,
  })
  assert.deepEqual(emitted, ['one-ran'])
})

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
      page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
      context: { close: async () => {} } as never,
      browser: { close: async () => {} } as never,
    }),
    trackerStub: true,
  })
  assert.equal(observed, before + 1, 'handler should see a new SIGINT listener installed')
  assert.equal(process.listeners('SIGINT').length, before, 'listener should be removed after')
})

test('runWorkflow: does NOT install SIGINT when trackerStub is false (tracker owns it)', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'sigint-dedup-'))
  t.after(() => {
    try { rmSync(tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  const name = `sigint-dedup-${Date.now()}`
  let observed: number | null = null
  const wf = defineWorkflow({
    name,
    systems: [{ id: 'x', login: async () => {} }],
    steps: ['s1'] as const,
    schema: z.object({}),
    handler: async () => {
      observed = process.listeners('SIGINT').length
    },
  })
  const before = process.listeners('SIGINT').length
  await runWorkflow(wf, {}, {
    launchFn: () => Promise.resolve({
      page: { bringToFront: async () => {} } as unknown as import('playwright').Page,
      context: { close: async () => {} } as never,
      browser: { close: async () => {} } as never,
    }),
    // trackerStub omitted — real tracker path runs with temp dir for isolation
    trackerDir: tmp,
  })
  // During handler execution, only withTrackedWorkflow's handler is installed
  // (exactly +1). If the kernel still installed its own, we'd see +2.
  assert.equal(
    observed,
    before + 1,
    `expected exactly 1 new SIGINT listener during handler (was ${observed} vs baseline ${before})`,
  )
  // After the run, the tracker removes its handler — listener count returns to baseline.
  assert.equal(process.listeners('SIGINT').length, before, 'listener should be removed after')
})
