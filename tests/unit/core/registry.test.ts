import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { getByName, clear } from '../../../src/core/registry.js'

// Isolate each test by clearing the registry before it runs.
// getByName returns WorkflowMetadata directly (not RegisteredWorkflow).

test('registry auto-prepends auth:<id> steps from systems when authSteps is unset', () => {
  clear()
  defineWorkflow({
    name: 'prepend-default-wf',
    systems: [
      { id: 'kuali', login: async () => {} },
      { id: 'ucpath', login: async () => {} },
    ],
    steps: ['work-step-a', 'work-step-b'] as const,
    schema: z.object({}),
    handler: async () => {},
  })
  const meta = getByName('prepend-default-wf')
  assert.deepEqual(meta?.steps, [
    'auth:kuali', 'auth:ucpath', 'work-step-a', 'work-step-b',
  ])
})

test('registry does NOT prepend when authSteps is false', () => {
  clear()
  defineWorkflow({
    name: 'optout-wf',
    systems: [{ id: 'kuali', login: async () => {} }],
    steps: ['custom-auth', 'work'] as const,
    schema: z.object({}),
    authSteps: false,
    handler: async () => {},
  })
  const meta = getByName('optout-wf')
  assert.deepEqual(meta?.steps, ['custom-auth', 'work'])
})
