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

test('session.launch (interleaved): first login blocks; subsequent logins resolve as chain progresses', async () => {
  const logins: Array<{ id: string; at: number }> = []
  let t = 0
  const mkSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      await new Promise((r) => setTimeout(r, 5))
      logins.push({ id, at: ++t })
    },
  })

  const systems = [mkSys('a'), mkSys('b'), mkSys('c')]
  const s = await Session.launch(systems, { authChain: 'interleaved', launchFn: fakeLaunch })

  // First system must be fully authed when launch returns.
  const pageA = await s.page('a')
  assert.ok(pageA)
  // b and c may or may not be done yet — await them.
  await Promise.all([s.page('b'), s.page('c')])
  // Order of completion: a first, then b, then c.
  assert.equal(logins[0].id, 'a')
  assert.deepEqual(logins.map((l) => l.id), ['a', 'b', 'c'])
  await s.close()
})

test('session.launch (interleaved): failed auth on system N does not block system N+1', async () => {
  const completed: string[] = []
  const systems: SystemConfig[] = [
    { id: 'a', login: async () => { completed.push('a') } },
    { id: 'b', login: async () => { throw new Error('b login failed') } },
    { id: 'c', login: async () => { completed.push('c') } },
  ]
  const s = await Session.launch(systems, { authChain: 'interleaved', launchFn: fakeLaunch })

  await assert.rejects(() => s.page('b'), /b login failed/)
  // c should still resolve.
  const pageC = await s.page('c')
  assert.ok(pageC)
  assert.deepEqual(completed, ['a', 'c'])
  await s.close()
})

test('session.reset: navigates to resetUrl when configured', async () => {
  const urls: string[] = []
  const fakePage = {
    goto: async (url: string) => { urls.push(url) },
    close: async () => {},
  } as unknown as import('playwright').Page

  const s = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {}, resetUrl: 'https://ucpath/home' }],
    browsers: new Map([['ucpath', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  await s.reset('ucpath')
  assert.deepEqual(urls, ['https://ucpath/home'])
})

test('session.reset: no-op when resetUrl missing', async () => {
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: {} as import('playwright').Page, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  await assert.doesNotReject(() => s.reset('a'))
})

test('session.healthCheck: returns false if page is closed', async () => {
  const fakePage = { isClosed: () => true } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  assert.equal(await s.healthCheck('a'), false)
})

// Fake launch helper used in tests — returns a stub Page/Browser/Context.
function fakeLaunch() {
  const page = { close: async () => {} } as unknown as import('playwright').Page
  const context = { close: async () => {} } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return Promise.resolve({ page, context, browser })
}
