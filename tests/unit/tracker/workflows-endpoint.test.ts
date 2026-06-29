import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineWorkflow } from '../../../src/core/kernel/workflow.js'
import { clear, register } from '../../../src/core/kernel/registry.js'
import { buildWorkflowsHandler } from '../../../src/tracker/dashboard.js'
import { defaultPresentationFromMetadata } from '../../../src/domain/workflow-presentation/resolve.js'

test('GET /api/workflow-definitions returns registered metadata', () => {
  clear()
  defineWorkflow({
    name: 'wf-a',
    systems: [{ id: 'ucpath', login: async () => {} }],
    authSteps: false,
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

test('GET /api/workflow-definitions registers every shipped dashboard workflow on module load', async () => {
  vi.resetModules()
  const [{ buildWorkflowsHandler }, { listWorkflowNames }] = await Promise.all([
    import('../../../src/tracker/dashboard/workflows.js'),
    import('../../../src/core/workflow-loaders.js'),
  ])

  const result = buildWorkflowsHandler()()
  const names = new Set(result.map((workflow) => workflow.name))
  const expected = [...listWorkflowNames(), 'ocr', 'sharepoint-download']

  for (const name of expected) {
    assert.ok(names.has(name), `expected ${name} in dashboard workflow metadata`)
  }
})

test('GET /api/workflow-definitions normalizes legacy detailFields (string[]) to labeled shape', () => {
  clear()
  defineWorkflow({
    name: 'wf-legacy-fields',
    systems: [{ id: 'ucpath', login: async () => {} }],
    authSteps: false,
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
    authSteps: false,
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

test('GET /api/workflow-definitions surfaces presets for the InputRunPanel gear menu', () => {
  clear()
  defineWorkflow({
    name: 'wf-with-presets',
    systems: [{ id: 'ucpath', login: async () => {} }],
    authSteps: false,
    steps: ['extract', 'kronos-check', 'lookup', 'transact', 'finalize'] as const,
    schema: z.object({}),
    presets: [
      {
        id: 'transactions-only',
        label: 'Transactions only',
        skipSteps: ['kronos-check', 'lookup'],
        description: 'For docs whose form is already filled.',
      },
    ],
    handler: async () => {},
  })
  const handler = buildWorkflowsHandler()
  const wf = handler().find((w) => w.name === 'wf-with-presets')
  assert.ok(wf)
  assert.deepEqual(wf?.presets, [
    {
      id: 'transactions-only',
      label: 'Transactions only',
      skipSteps: ['kronos-check', 'lookup'],
      description: 'For docs whose form is already filled.',
    },
  ])
})

test('GET /api/workflow-definitions omits presets field when workflow declared none', () => {
  clear()
  defineWorkflow({
    name: 'wf-no-presets',
    systems: [{ id: 'ucpath', login: async () => {} }],
    authSteps: false,
    steps: ['only'] as const,
    schema: z.object({}),
    handler: async () => {},
  })
  const handler = buildWorkflowsHandler()
  const wf = handler().find((w) => w.name === 'wf-no-presets')
  assert.ok(wf)
  assert.equal(wf?.presets, undefined)
})

test('GET /api/workflow-definitions returns metadata registered via register()', () => {
  clear()
  register({
    name: 'kronos-reports',
    label: 'Kronos Reports',
    systems: ['old-kronos'],
    steps: ['searching', 'extracting', 'downloading'],
    archetype: 'operation',
    code: 'kr',
    detailFields: [
      { key: 'employee', label: 'Employee' },
      { key: 'id', label: 'ID' },
    ],
    presentation: defaultPresentationFromMetadata({ archetype: 'batch' }),
  })
  const handler = buildWorkflowsHandler()
  const result = handler()
  const wf = result.find((w) => w.name === 'kronos-reports')
  assert.ok(wf)
  assert.equal(wf?.label, 'Kronos Reports')
  assert.deepEqual(wf?.steps, ['searching', 'extracting', 'downloading'])
  assert.equal(wf?.detailFields.length, 2)
})
