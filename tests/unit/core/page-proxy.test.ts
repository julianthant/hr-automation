/**
 * Page proxy — auto-injects ctx.signal into Playwright methods that accept
 * `signal?: AbortSignal`. The synthetic Page mock below records every call's
 * options bag so the test can assert which methods got `signal` merged in,
 * which were passthrough, and that the caller's own signal isn't clobbered.
 *
 * Contract 5: ctx.page(id) returns this proxied Page. Operator cancel aborts
 * the per-run AbortController, which propagates into in-flight Playwright
 * calls via this signal injection.
 */
import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import type { Page } from 'playwright'
import { wrapPageWithSignal } from '../../../src/core/kernel/page-proxy.js'

interface CallRecord {
  method: string
  args: unknown[]
}

function buildMockPage(): { page: Page; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  const record = (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return Promise.resolve('result')
    }
  const recordSync = (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      return 'sync-result'
    }

  // Build the locator object recursively — chained calls (`.locator(...)`)
  // must also be proxied so we can assert signal injection on chained
  // method calls.
  const buildLocator = (): unknown => {
    const loc: Record<string, unknown> = {
      click: record('locator.click'),
      fill: record('locator.fill'),
      waitFor: record('locator.waitFor'),
      evaluate: record('locator.evaluate'),
      // Locator-chaining factories return another Locator.
      locator: recordSync('locator.locator'),
      first: recordSync('locator.first'),
      filter: recordSync('locator.filter'),
      // sync getter
      count: record('locator.count'),
    }
    // Make chained locator factories return a new locator-shaped object so
    // the proxy can recursively wrap.
    loc.locator = (...args: unknown[]) => {
      calls.push({ method: 'locator.locator', args })
      return buildLocator()
    }
    loc.filter = (...args: unknown[]) => {
      calls.push({ method: 'locator.filter', args })
      return buildLocator()
    }
    loc.first = (...args: unknown[]) => {
      calls.push({ method: 'locator.first', args })
      return buildLocator()
    }
    return loc
  }

  const keyboard = {
    press: record('keyboard.press'),
    type: record('keyboard.type'),
    down: record('keyboard.down'),
    up: record('keyboard.up'),
  }

  const mouse = {
    click: record('mouse.click'),
    move: record('mouse.move'),
    down: record('mouse.down'),
    up: record('mouse.up'),
  }

  const mainFrame = {
    waitForSelector: record('frame.waitForSelector'),
    click: record('frame.click'),
    locator: (...args: unknown[]) => {
      calls.push({ method: 'frame.locator', args })
      return buildLocator()
    },
  }

  const page = {
    click: record('click'),
    fill: record('fill'),
    goto: record('goto'),
    reload: record('reload'),
    waitForSelector: record('waitForSelector'),
    waitForFunction: record('waitForFunction'),
    waitForURL: record('waitForURL'),
    screenshot: record('screenshot'),
    evaluate: record('evaluate'),
    // Sync getters — passthrough.
    url: () => 'https://example.test/',
    title: () => Promise.resolve('Test'),
    isClosed: () => false,
    // Locator factories — must return proxied Locators.
    locator: (...args: unknown[]) => {
      calls.push({ method: 'locator', args })
      return buildLocator()
    },
    getByRole: (...args: unknown[]) => {
      calls.push({ method: 'getByRole', args })
      return buildLocator()
    },
    getByText: (...args: unknown[]) => {
      calls.push({ method: 'getByText', args })
      return buildLocator()
    },
    getByLabel: (...args: unknown[]) => {
      calls.push({ method: 'getByLabel', args })
      return buildLocator()
    },
    getByTestId: (...args: unknown[]) => {
      calls.push({ method: 'getByTestId', args })
      return buildLocator()
    },
    // Sub-objects — must be proxied lazily on access.
    keyboard,
    mouse,
    mainFrame,
  } as unknown as Page
  return { page, calls }
}

function lastOptions(calls: CallRecord[]): Record<string, unknown> | undefined {
  const c = calls[calls.length - 1]
  if (!c) return undefined
  const last = c.args[c.args.length - 1]
  return last && typeof last === 'object' ? last as Record<string, unknown> : undefined
}

describe('wrapPageWithSignal', () => {
  test('auto-injects signal into page.click / fill / goto / waitForSelector', async () => {
    const { page, calls } = buildMockPage()
    const controller = new AbortController()
    const wrapped = wrapPageWithSignal(page, controller.signal)

    await wrapped.click('button', { timeout: 1000 })
    assert.equal(lastOptions(calls)?.signal, controller.signal)
    assert.equal(lastOptions(calls)?.timeout, 1000, 'preserves caller options')

    await wrapped.fill('input', 'hello', { force: true })
    assert.equal(lastOptions(calls)?.signal, controller.signal)
    assert.equal(lastOptions(calls)?.force, true)

    await wrapped.goto('https://example.test/', { waitUntil: 'load' })
    assert.equal(lastOptions(calls)?.signal, controller.signal)

    await wrapped.waitForSelector('#foo', { state: 'visible' })
    assert.equal(lastOptions(calls)?.signal, controller.signal)
  })

  test('injects signal even when caller provides no options arg (creates options bag)', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    await wrapped.click('button')
    // First arg is the selector; second arg should be the synthetic options
    // bag containing only `{ signal }`.
    assert.deepEqual(calls[0]?.args, ['button', { signal }])
  })

  test('does NOT clobber a caller-supplied signal', async () => {
    const { page, calls } = buildMockPage()
    const ctxController = new AbortController()
    const callerController = new AbortController()
    const wrapped = wrapPageWithSignal(page, ctxController.signal)

    await wrapped.click('button', { signal: callerController.signal, timeout: 500 })
    assert.equal(lastOptions(calls)?.signal, callerController.signal, 'caller signal wins')
    assert.equal(lastOptions(calls)?.timeout, 500)
  })

  test('locator factories return a proxied Locator whose methods inject signal', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    const loc = wrapped.locator('#foo')
    // locator() call recorded (the factory itself doesn't take signal options,
    // so the args are passthrough — but the RETURN value is proxied).
    assert.equal(calls.find((c) => c.method === 'locator')?.args[0], '#foo')

    await loc.click({ delay: 100 })
    const clickCall = calls.find((c) => c.method === 'locator.click')
    assert.ok(clickCall)
    assert.equal((clickCall.args[clickCall.args.length - 1] as Record<string, unknown>)?.signal, signal)
  })

  test('chained .locator(...) on a proxied Locator stays signal-aware', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    const child = wrapped.locator('#parent').locator('.child')
    await child.click()
    const clickCall = calls.find((c) => c.method === 'locator.click')
    assert.ok(clickCall, 'chained locator click recorded')
    assert.equal((clickCall.args[clickCall.args.length - 1] as Record<string, unknown>)?.signal, signal)
  })

  test('getByRole/getByText/getByLabel/getByTestId return proxied Locators', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    await wrapped.getByRole('button', { name: 'Submit' }).click({ timeout: 1 })
    const clickAfterRole = [...calls].reverse().find((c) => c.method === 'locator.click')
    assert.equal((clickAfterRole?.args[clickAfterRole.args.length - 1] as Record<string, unknown>)?.signal, signal)

    await wrapped.getByText('Hello').fill('world')
    const fillAfterText = [...calls].reverse().find((c) => c.method === 'locator.fill')
    assert.equal((fillAfterText?.args[fillAfterText.args.length - 1] as Record<string, unknown>)?.signal, signal)

    await wrapped.getByLabel('Name').click({})
    await wrapped.getByTestId('save-btn').click({})
  })

  test('keyboard.* and mouse.* sub-objects inject signal', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    await wrapped.keyboard.press('Enter', { delay: 10 })
    const pressCall = calls.find((c) => c.method === 'keyboard.press')
    assert.equal((pressCall?.args[pressCall.args.length - 1] as Record<string, unknown>)?.signal, signal)

    await wrapped.mouse.click(100, 200, { button: 'left' })
    const mouseClick = calls.find((c) => c.method === 'mouse.click')
    assert.equal((mouseClick?.args[mouseClick.args.length - 1] as Record<string, unknown>)?.signal, signal)
  })

  test('mainFrame returns a proxied Frame whose methods inject signal', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    await wrapped.mainFrame.waitForSelector('#foo', { state: 'visible' })
    const wait = calls.find((c) => c.method === 'frame.waitForSelector')
    assert.equal((wait?.args[wait.args.length - 1] as Record<string, unknown>)?.signal, signal)

    // Frame.locator chain still wraps.
    await wrapped.mainFrame.locator('#x').click({})
    const click = [...calls].reverse().find((c) => c.method === 'locator.click')
    assert.equal((click?.args[click.args.length - 1] as Record<string, unknown>)?.signal, signal)
  })

  test('sync getters (url, title, isClosed) pass through verbatim', () => {
    const { page } = buildMockPage()
    const wrapped = wrapPageWithSignal(page, new AbortController().signal)

    assert.equal(wrapped.url(), 'https://example.test/')
    assert.equal(wrapped.isClosed(), false)
  })

  test('methods append a new options-bag when caller passes no options', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    // fill called with selector + value (no options arg). Playwright treats
    // a missing options arg as `{}`, so we append `{ signal }` as the
    // synthetic 3rd argument — this is the only way to inject signal when
    // the caller didn't pass options.
    await wrapped.fill('input', 'hello-no-options')
    const fillCall = calls.find((c) => c.method === 'fill')
    assert.deepEqual(fillCall?.args, ['input', 'hello-no-options', { signal }])
  })

  test('zero-arg call (e.g. reload()) gets options-bag with signal appended', async () => {
    const { page, calls } = buildMockPage()
    const signal = new AbortController().signal
    const wrapped = wrapPageWithSignal(page, signal)

    await wrapped.reload()
    const reloadCall = calls.find((c) => c.method === 'reload')
    assert.deepEqual(reloadCall?.args, [{ signal }])
  })
})
