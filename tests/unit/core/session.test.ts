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

test('session.healthCheck: returns false on about:blank', async () => {
  const fakePage = {
    isClosed: () => false,
    url: () => 'about:blank',
    evaluate: async () => 1,
  } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  assert.equal(await s.healthCheck('a'), false)
})

test('session.healthCheck: returns false when evaluate throws (destroyed context)', async () => {
  const fakePage = {
    isClosed: () => false,
    url: () => 'https://ucpath.universityofcalifornia.edu/foo',
    evaluate: async () => { throw new Error('Execution context was destroyed') },
  } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  assert.equal(await s.healthCheck('a'), false)
})

test('session.healthCheck: returns true when page open + url set + evaluate roundtrips', async () => {
  const fakePage = {
    isClosed: () => false,
    url: () => 'https://ucpath.universityofcalifornia.edu/psp/UCPATHHM',
    evaluate: async () => 1,
  } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [{ id: 'a', login: async () => {} }],
    browsers: new Map([['a', { page: fakePage, browser: null as never, context: null as never }]]),
    readyPromises: new Map([['a', Promise.resolve()]]),
  })
  assert.equal(await s.healthCheck('a'), true)
})

test('session.healthCheck: returns false when missing system id', async () => {
  const s = Session.forTesting({
    systems: [],
    browsers: new Map(),
    readyPromises: new Map(),
  })
  assert.equal(await s.healthCheck('nope'), false)
})

test('session.screenshotAll: writes one PNG per open page, skips closed, returns paths', async () => {
  const { existsSync, rmSync } = await import('node:fs')
  const { PATHS } = await import('../../../src/config.js')
  const shotCalls: Array<{ id: string; path: string }> = []
  const mkPage = (id: string, closed: boolean) => ({
    isClosed: () => closed,
    screenshot: async (opts: { path: string }) => { shotCalls.push({ id, path: opts.path }) },
  }) as unknown as import('playwright').Page

  const s = Session.forTesting({
    systems: [
      { id: 'ucpath', login: async () => {} },
      { id: 'kuali', login: async () => {} },
      { id: 'closed-one', login: async () => {} },
    ],
    browsers: new Map([
      ['ucpath', { page: mkPage('ucpath', false), browser: null as never, context: null as never }],
      ['kuali', { page: mkPage('kuali', false), browser: null as never, context: null as never }],
      ['closed-one', { page: mkPage('closed-one', true), browser: null as never, context: null as never }],
    ]),
    readyPromises: new Map(),
  })

  // Pre-clean in case a previous run left the dir around.
  const paths = await s.screenshotAll('test-prefix')
  try {
    assert.equal(paths.length, 2, 'only 2 open pages → 2 paths')
    assert.ok(existsSync(PATHS.screenshotDir), `${PATHS.screenshotDir} directory created`)
    // Each path matches `<screenshotDir>/<prefix>-<systemId>-<timestamp>.png`
    const escapedDir = PATHS.screenshotDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pathRe = new RegExp(`^${escapedDir}[\\\\/]test-prefix-(ucpath|kuali)-\\d+\\.png$`)
    for (const p of paths) {
      assert.match(p, pathRe)
    }
    // Screenshot calls correspond 1:1 to returned paths
    assert.equal(shotCalls.length, 2)
    const ids = shotCalls.map((c) => c.id).sort()
    assert.deepEqual(ids, ['kuali', 'ucpath'])
  } finally {
    // Best-effort cleanup — files under src/data/screenshots/ are gitignored so
    // leftovers are fine, but we clean per-test to stay tidy across runs.
    try { rmSync(PATHS.screenshotDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('session.screenshotAll: a failed screenshot does not skip siblings', async () => {
  const { rmSync } = await import('node:fs')
  const { PATHS } = await import('../../../src/config.js')
  const mkOk = (id: string) => ({
    isClosed: () => false,
    screenshot: async () => { /* ok */ void id },
  }) as unknown as import('playwright').Page
  const mkBad = () => ({
    isClosed: () => false,
    screenshot: async () => { throw new Error('disk full') },
  }) as unknown as import('playwright').Page

  const s = Session.forTesting({
    systems: [
      { id: 'a', login: async () => {} },
      { id: 'b-bad', login: async () => {} },
      { id: 'c', login: async () => {} },
    ],
    browsers: new Map([
      ['a', { page: mkOk('a'), browser: null as never, context: null as never }],
      ['b-bad', { page: mkBad(), browser: null as never, context: null as never }],
      ['c', { page: mkOk('c'), browser: null as never, context: null as never }],
    ]),
    readyPromises: new Map(),
  })

  const paths = await s.screenshotAll('sibling-test')
  try {
    // `a` and `c` succeeded; `b-bad` threw and was skipped.
    assert.equal(paths.length, 2)
    assert.ok(paths.some((p) => p.includes('-a-')))
    assert.ok(paths.some((p) => p.includes('-c-')))
    assert.ok(!paths.some((p) => p.includes('-b-bad-')))
  } finally {
    try { rmSync(PATHS.screenshotDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// Fake launch helper used in tests — returns a stub Page/Browser/Context.
function fakeLaunch() {
  const page = { close: async () => {}, bringToFront: async () => {}, goto: async () => {}, waitForTimeout: async () => {} } as unknown as import('playwright').Page
  const context = { close: async () => {} } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return Promise.resolve({ page, context, browser })
}

test('session.launch: observer hooks fire in correct order (sequential, success)', async () => {
  const events: string[] = []
  const loginsReceived: Array<string | undefined> = []
  const mkSys = (id: string): SystemConfig => ({
    id,
    login: async (_page, instance) => {
      loginsReceived.push(instance)
      events.push(`login:${id}`)
    },
  })

  const observer = {
    instance: 'Test 1',
    onBrowserLaunch: (id: string, bid: string) => events.push(`browser:${id}:${bid}`),
    onAuthStart: (id: string, bid: string) => events.push(`authStart:${id}:${bid}`),
    onAuthComplete: (id: string, bid: string) => events.push(`authComplete:${id}:${bid}`),
    onAuthFailed: (id: string, bid: string) => events.push(`authFailed:${id}:${bid}`),
  }

  const s = await Session.launch(
    [mkSys('a'), mkSys('b')],
    { authChain: 'sequential', launchFn: fakeLaunch, observer },
  )

  assert.deepEqual(events, [
    'browser:a:a',
    'browser:b:b',
    'authStart:a:a',
    'login:a',
    'authComplete:a:a',
    'authStart:b:b',
    'login:b',
    'authComplete:b:b',
  ])
  assert.deepEqual(loginsReceived, ['Test 1', 'Test 1'])
  await s.close()
})

test('session.launch: observer onAuthFailed fires after all retries exhaust', async () => {
  const events: string[] = []
  const sys: SystemConfig = {
    id: 'flaky',
    login: async () => { throw new Error('duo timeout') },
  }

  const observer = {
    onAuthStart: (id: string) => events.push(`start:${id}`),
    onAuthFailed: (id: string) => events.push(`failed:${id}`),
    onAuthComplete: (id: string) => events.push(`complete:${id}`),
  }

  await assert.rejects(
    () => Session.launch([sys], { launchFn: fakeLaunch, observer }),
    /duo timeout/,
  )

  // onAuthStart fires once (before retry loop), onAuthFailed fires once (after exhaustion),
  // onAuthComplete never fires.
  assert.deepEqual(events, ['start:flaky', 'failed:flaky'])
})
