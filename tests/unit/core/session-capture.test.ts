import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCaptureFilename } from '../../../src/core/session.js'

test('formatCaptureFilename round-trips parseable metadata', () => {
  const fn = formatCaptureFilename({
    workflow: 'separations',
    itemId: '3907',
    kind: 'form',
    label: 'kuali-finalization-saved',
    system: 'kuali',
    ts: 1776712000000,
  })
  assert.equal(fn, 'separations-3907-form-kuali-finalization-saved-kuali-1776712000000.png')
})
