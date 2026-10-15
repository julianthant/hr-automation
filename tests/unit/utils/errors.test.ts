import { test } from 'vitest'
import assert from 'node:assert/strict'
import { classifyError, describeLocatorFailure, isBrowserClosedError } from '../../../src/utils/errors.js'

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

test('describeLocatorFailure: names the control instead of a locator timeout', () => {
  assert.equal(
    describeLocatorFailure(
      "locator.waitFor: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Search' }) to be visible",
    ),
    "Can't find Search button",
  )
  assert.equal(
    describeLocatorFailure(
      "locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('textbox', { name: 'Empl ID' })",
    ),
    "Can't fill Empl ID field",
  )
  assert.equal(
    describeLocatorFailure(
      "locator.waitFor: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator('#PERSON_NPC_VW_EMPLID') to be visible",
    ),
    "Can't find #PERSON_NPC_VW_EMPLID",
  )
  assert.equal(describeLocatorFailure("Last Day Worked cannot be in the future"), null)
})

test('classifyError: a locator timeout becomes the missing control', () => {
  assert.equal(
    classifyError(new Error("locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Save' })")),
    "Can't find Save button",
  )
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
