import test from 'node:test'
import assert from 'node:assert/strict'
import { separationsWorkflow } from '../../../../src/workflows/separations/workflow.js'
import { getByName } from '../../../../src/core/registry.js'

test('separations effective step list is auth:<systems> + work steps', () => {
  // Import of separationsWorkflow triggers defineWorkflow which auto-registers.
  const meta = getByName('separations')
  assert.ok(meta, 'separations workflow must be registered')
  assert.deepEqual(meta.steps, [
    'auth:kuali',
    'auth:old-kronos',
    'auth:new-kronos',
    'auth:ucpath',
    'kuali-extraction',
    'kronos-search',
    'ucpath-job-summary',
    'ucpath-transaction',
    'kuali-finalization',
  ])
})

test('separations declared steps tuple no longer contains launching or authenticating', () => {
  const declared = separationsWorkflow.config.steps
  assert.ok(!declared.includes('launching' as never), 'declared tuple should not contain launching')
  assert.ok(
    !declared.includes('authenticating' as never),
    'declared tuple should not contain authenticating',
  )
})
