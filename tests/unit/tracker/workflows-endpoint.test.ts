import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { clear } from '../../../src/core/registry.js'
import { buildWorkflowsHandler } from '../../../src/tracker/dashboard.js'

test('GET /api/workflow-definitions returns registered metadata', () => {
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
