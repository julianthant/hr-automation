import { test } from 'vitest'
import assert from 'node:assert/strict'
import { classifyError, isBrowserClosedError } from '../../../src/utils/errors.js'

test('isBrowserClosedError: matches all three browser-closed Playwright shapes', () => {
  assert.equal(
    isBrowserClosedError(new Error('Target page, context or browser has been closed')),
    true,
    'Target page closed',
  )
  assert.equal(
    isBrowserClosedError(new Error('browser has been disconnected')),
    true,
    'Browser disconnected',
  )
  assert.equal(
    isBrowserClosedError(new Error('Protocol error: Target closed')),
    true,
    'Protocol error Target closed',
  )
  assert.equal(isBrowserClosedError(new Error('Element not found')), false)
  assert.equal(isBrowserClosedError(new Error('Timeout waiting for locator')), false)
})

test('classifyError: appends systemId to each browser-closed variant', () => {
  // "Browser closed unexpectedly" (target-page-closed shape)
  assert.equal(
    classifyError(new Error('Target page, context or browser has been closed'), { systemId: 'new-kronos' }),
    'Browser closed unexpectedly (new-kronos)',
  )
  // "Browser disconnected"
  assert.equal(
    classifyError(new Error('browser has been disconnected'), { systemId: 'ucpath' }),
    'Browser disconnected (ucpath)',
  )
  // "Browser closed during operation"
  assert.equal(
    classifyError(new Error('Protocol error: Target closed'), { systemId: 'kuali' }),
    'Browser closed during operation (kuali)',
  )
  // No systemId → no suffix
  assert.equal(
    classifyError(new Error('Target page, context or browser has been closed')),
    'Browser closed unexpectedly',
  )
  // Non-browser-closed message → no suffix even with systemId
  assert.equal(
    classifyError(new Error('net::ERR_CONNECTION_REFUSED'), { systemId: 'ucpath' }),
    'Connection refused — server unreachable',
  )
})
