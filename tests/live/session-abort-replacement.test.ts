import { test } from 'vitest'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

import { Session } from '../../src/core/kernel/session.js'

test('real Chromium: closing an abandoned Playwright operation is fast and the next item gets a healthy page', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const oldPage = await context.newPage()
  const resetUrl = 'data:text/html,<title>replacement</title><main>healthy</main>'
  await oldPage.goto('data:text/html,<title>old</title><main>old</main>')
  const session = Session.forTesting({
    systems: [{ id: 'local', resetUrl, login: async () => {} }],
    browsers: new Map([['local', { page: oldPage, context, browser }]]),
    readyPromises: new Map([['local', Promise.resolve()]]),
  })

  try {
    const abandoned = oldPage.evaluate(() => new Promise<void>(() => {}))
    await new Promise((resolve) => setTimeout(resolve, 25))
    const startedAt = Date.now()
    session.poisonPage('local', oldPage)
    await assert.rejects(Promise.race([
      abandoned,
      new Promise((_, reject) => setTimeout(() => reject(new Error('abandoned operation did not abort')), 1_500)),
    ]), /closed|Target page|Execution context|abandoned operation/i)
    assert.ok(Date.now() - startedAt < 1_500, 'closing the poisoned page aborts the real CDP call promptly')

    const replacement = await session.page('local')
    assert.notEqual(replacement, oldPage)
    assert.equal(await replacement.locator('main').textContent(), 'healthy')
    assert.equal(await replacement.evaluate(() => 1), 1)
  } finally {
    await session.close()
  }
})
