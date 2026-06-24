import { test } from 'vitest'
import assert from 'node:assert/strict'
import { separationsWorkflow } from '../../../../src/workflows/separations/workflow.js'
import { getByName } from '../../../../src/core/kernel/registry.js'

test('separations effective step list is auth:<systems> + work steps', () => {
  // Import of separationsWorkflow triggers defineWorkflow which auto-registers.
  const meta = getByName('separations')
  assert.ok(meta, 'separations workflow must be registered')
  // identity-check now sits BEFORE kronos-search (and before transaction-check):
  // the EID must be verified/corrected (person-lookup runs ONLY inside
  // identity-check) before the transaction check + timecard read use it. The
  // Workforce Job Summary that gates identity-check is now fetched inline just
  // before the step rather than inside kronos-search. transaction-check follows
  // identity-check and precedes kronos-search.
  assert.deepEqual(meta.steps, [
    'auth:kuali',
    'auth:new-kronos',
    'auth:ucpath',
    'kuali-extraction',
    'identity-check',
    'transaction-check',
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
