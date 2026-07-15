import { describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import type { Page } from 'playwright'
import { wrapPageWithSignal } from '../../../src/core/kernel/page-proxy.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('wrapPageWithSignal', () => {
  test('passes Playwright arguments through unchanged', async () => {
    const click = vi.fn(async () => undefined)
    const page = { click } as unknown as Page
    const wrapped = wrapPageWithSignal(page, new AbortController().signal)

    await wrapped.click('#save', { timeout: 123 })

    const call = (click.mock.calls as unknown as unknown[][])[0]
    assert.deepEqual(call, ['#save', { timeout: 123 }])
    assert.equal('signal' in (call[1] as object), false)
  })

  test('aborts a held Playwright promise promptly and poisons once', async () => {
    const held = deferred<void>()
    const waitForSelector = vi.fn(() => held.promise)
    const poison = vi.fn()
    const controller = new AbortController()
    const wrapped = wrapPageWithSignal({ waitForSelector } as unknown as Page, controller.signal, poison)

    const started = wrapped.waitForSelector('#slow', { timeout: 60_000 })
    controller.abort(new Error('operator cancelled'))

    await assert.rejects(started, /operator cancelled/)
    assert.equal(poison.mock.calls.length, 1)
    assert.deepEqual(waitForSelector.mock.calls[0], ['#slow', { timeout: 60_000 }])

    // A late underlying rejection is observed by the proxy and must not become
    // an unhandled rejection after the abort race has already settled.
    held.reject(new Error('late browser failure'))
    await new Promise((resolve) => setImmediate(resolve))
  })

  test('a pre-aborted signal refuses to dispatch the Playwright method', async () => {
    const click = vi.fn(async () => undefined)
    const poison = vi.fn()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before dispatch'))
    const wrapped = wrapPageWithSignal({ click } as unknown as Page, controller.signal, poison)

    await assert.rejects(wrapped.click('#save'), /cancelled before dispatch/)
    assert.equal(click.mock.calls.length, 0)
    assert.equal(poison.mock.calls.length, 0, 'an undispatched call did not poison the page')
  })

  test('locator and frame chains retain the same abort race', async () => {
    const held = deferred<void>()
    const locatorClick = vi.fn(() => held.promise)
    const childLocator = { click: locatorClick }
    const frame = { locator: vi.fn(() => childLocator) }
    const page = { mainFrame: vi.fn(() => frame) } as unknown as Page
    const poison = vi.fn()
    const controller = new AbortController()
    const wrapped = wrapPageWithSignal(page, controller.signal, poison)

    const started = wrapped.mainFrame().locator('#child').click()
    controller.abort(new Error('stop nested action'))

    await assert.rejects(started, /stop nested action/)
    assert.equal(poison.mock.calls.length, 1)
  })

  test('resolved promises detach their abort listener and do not poison later', async () => {
    const click = vi.fn(async () => undefined)
    const poison = vi.fn()
    const controller = new AbortController()
    const wrapped = wrapPageWithSignal({ click } as unknown as Page, controller.signal, poison)

    await wrapped.click('#done')
    controller.abort(new Error('too late'))

    assert.equal(poison.mock.calls.length, 0)
  })

  test('evaluate arguments remain byte-for-byte untouched while its promise is cancellable', async () => {
    const held = deferred<number>()
    const evaluate = vi.fn(() => held.promise)
    const controller = new AbortController()
    const wrapped = wrapPageWithSignal({ evaluate } as unknown as Page, controller.signal)
    const arg = { count: 7 }
    const fn = (value: { count: number }) => value.count

    const started = wrapped.evaluate(fn, arg)
    controller.abort(new Error('cancel evaluate'))

    await assert.rejects(started, /cancel evaluate/)
    assert.deepEqual(evaluate.mock.calls[0], [fn, arg])
  })
})
