import { test } from 'vitest'
import assert from 'node:assert/strict'
import { separationsWorkflow } from '../../../../src/workflows/separations/workflow.js'
import { getByName } from '../../../../src/core/kernel/registry.js'

test('separations effective step list is auth:<systems> + work steps', () => {
  // Import of separationsWorkflow triggers defineWorkflow which auto-registers.
  const meta = getByName('separations')
  assert.ok(meta, 'separations workflow must be registered')
  // identity-check now sits AFTER kronos-search: the Workforce Job Summary
  // (fetched in kronos-search) is the gate that decides whether person-lookup
  // runs at all, so the verification step must follow it.
  assert.deepEqual(meta.steps, [
    'auth:kuali',
    'auth:new-kronos',
    'auth:ucpath',
    'kuali-extraction',
    'kronos-search',
    'identity-check',
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
