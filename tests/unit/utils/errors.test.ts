import { test } from 'vitest'
import assert from 'node:assert/strict'
import { classifyError, isBrowserClosedError } from '../../../src/utils/errors.js'

test('isBrowserClosedError: matches Playwright target-closed shapes', () => {
  assert.equal(
    isBrowserClosedError(new Error('Target page, context or browser has been closed')),
    true,
  )
  assert.equal(isBrowserClosedError(new Error('browser has been disconnected')), true)
  assert.equal(isBrowserClosedError(new Error('Protocol error: Target closed')), true)
  assert.equal(isBrowserClosedError(new Error('Element not found')), false)
})

test('classifyError: appends systemId to browser-closed messages', () => {
  const err = new Error('Target page, context or browser has been closed')
  assert.equal(
    classifyError(err, { systemId: 'new-kronos' }),
    'Browser closed unexpectedly (new-kronos)',
  )
  assert.equal(
    classifyError(err),
    'Browser closed unexpectedly',
  )
})
