import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/workflow.js'
import { clear, defineDashboardMetadata } from '../../../src/core/registry.js'
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
  // auto-label falls back to title-cased name when label omitted
  assert.equal(result[0].label, 'Wf A')
})

test('GET /api/workflow-definitions normalizes legacy detailFields (string[]) to labeled shape', () => {
  clear()
  defineWorkflow({
    name: 'wf-legacy-fields',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({ emplId: z.string() }),
    detailFields: ['emplId'],
    handler: async () => {},
  })
  const handler = buildWorkflowsHandler()
  const result = handler()
  const wf = result.find((w) => w.name === 'wf-legacy-fields')
  assert.ok(wf)
  assert.deepEqual(wf?.detailFields, [{ key: 'emplId', label: 'Empl Id' }])
})

test('GET /api/workflow-definitions passes through labeled detailFields verbatim', () => {
  clear()
  defineWorkflow({
    name: 'wf-labeled-fields',
    label: 'Fancy Label',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['only'] as const,
    schema: z.object({}),
    detailFields: [
      { key: 'emplId', label: 'Empl ID' },
      { key: 'wage', label: 'Hourly Wage' },
    ],
    handler: async () => {},
  })
  const handler = buildWorkflowsHandler()
  const result = handler()
  const wf = result.find((w) => w.name === 'wf-labeled-fields')
  assert.ok(wf)
  assert.equal(wf?.label, 'Fancy Label')
  assert.deepEqual(wf?.detailFields, [
    { key: 'emplId', label: 'Empl ID' },
    { key: 'wage', label: 'Hourly Wage' },
  ])
})

test('GET /api/workflow-definitions returns legacy workflow via defineDashboardMetadata', () => {
  clear()
  defineDashboardMetadata({
    name: 'kronos-reports',
    label: 'Kronos Reports',
    systems: ['old-kronos'],
    steps: ['searching', 'extracting', 'downloading'],
    detailFields: [
      { key: 'employee', label: 'Employee' },
      { key: 'id', label: 'ID' },
    ],
  })
  const handler = buildWorkflowsHandler()
  const result = handler()
  const wf = result.find((w) => w.name === 'kronos-reports')
  assert.ok(wf)
  assert.equal(wf?.label, 'Kronos Reports')
  assert.deepEqual(wf?.steps, ['searching', 'extracting', 'downloading'])
  assert.equal(wf?.detailFields.length, 2)
})
