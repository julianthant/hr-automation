import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../../../src/core/session.js'
import type { SystemConfig } from '../../../src/core/types.js'

const makeSystem = (id: string, loginFn?: () => Promise<void>): SystemConfig => ({
  id,
  login: async () => { await (loginFn ?? (() => Promise.resolve()))() },
})

test('session: construct with no systems is legal', () => {
  const s = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() })
  assert.equal(s.systemIds().length, 0)
})

test('session: systemIds returns declared ids in order', () => {
  const systems = [makeSystem('ucpath'), makeSystem('kuali')]
  const s = Session.forTesting({ systems, browsers: new Map(), readyPromises: new Map() })
  assert.deepEqual(s.systemIds(), ['ucpath', 'kuali'])
})

test('session.page: awaits ready promise, then returns cached page', async () => {
  const fakePage = { __marker: 'fake-page' } as unknown as import('playwright').Page
  let resolveReady: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })

  const s = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map([['ucpath', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['ucpath', ready]]),
  })

  let pageResolved = false
  const pagePromise = s.page('ucpath').then((p) => { pageResolved = true; return p })

  // Before ready resolves, page() should be pending.
  await Promise.resolve()
  assert.equal(pageResolved, false)

  resolveReady!()
  const page = await pagePromise
  assert.equal(pageResolved, true)
  assert.strictEqual(page, fakePage)
})

test('session.page: unknown id throws', async () => {
  const s = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() })
  await assert.rejects(() => s.page('nope'), /unknown system/i)
})

test('session.launch (sequential): awaits each login in order', async () => {
  const order: string[] = []
  const makeSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push(id)
    },
  })

  const s = await Session.launch(
    [makeSys('a'), makeSys('b'), makeSys('c')],
    { authChain: 'sequential', launchFn: fakeLaunch },
  )
  assert.deepEqual(order, ['a', 'b', 'c'])
  await s.close()
})

// Fake launch helper used in tests — returns a stub Page/Browser/Context.
function fakeLaunch() {
  const page = { close: async () => {} } as unknown as import('playwright').Page
  const context = { close: async () => {} } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return Promise.resolve({ page, context, browser })
}
