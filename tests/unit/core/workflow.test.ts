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
