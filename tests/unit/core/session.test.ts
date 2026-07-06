import { test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Session, walkDescendantPids } from '../../../src/core/kernel/session.js'
import type { SystemConfig } from '../../../src/core/kernel/types.js'
import { log } from '../../../src/utils/log.js'

const makeSystem = (id: string, loginFn?: () => Promise<void>): SystemConfig => ({
  id,
  login: async () => { await (loginFn ?? (() => Promise.resolve()))() },
})

test('session: construct with no systems is legal', () => {
  const s = Session.forTesting({ systems: [], browsers: new Map(), readyPromises: new Map() })
  assert.equal(s.systemIds().length, 0)
})

test('session: onBrowserDisconnect records system id for classification', () => {
  const browser = Object.assign(new EventEmitter(), { close: async () => {} })
  const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [makeSystem('new-kronos')],
    browsers: new Map([
      ['new-kronos', { page: fakePage, browser: browser as unknown as import('playwright').Browser, context: null as never, chromiumPid: 1 }],
    ]),
    readyPromises: new Map(),
  })
  assert.equal(s.hadBrowserDisconnect(), false)
  s.onBrowserDisconnect(() => {})
  browser.emit('disconnected')
  assert.equal(s.hadBrowserDisconnect(), true)
  assert.deepEqual([...s.disconnectedSystems()], ['new-kronos'])
})

test('session.hadBrowserDisconnect: SCOPED to the last-touched system — an unrelated system disconnecting must not reclassify a genuine failure on another system as cancelled', async () => {
  const fakePage = (): import('playwright').Page =>
    ({ close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page)
  const kualiBrowser = Object.assign(new EventEmitter(), { close: async () => {} })
  const ucpathBrowser = Object.assign(new EventEmitter(), { close: async () => {} })
  const s = Session.forTesting({
    systems: [makeSystem('kuali'), makeSystem('ucpath')],
    browsers: new Map([
      ['kuali', { page: fakePage(), browser: kualiBrowser as unknown as import('playwright').Browser, context: null as never }],
      ['ucpath', { page: fakePage(), browser: ucpathBrowser as unknown as import('playwright').Browser, context: null as never }],
    ]),
    readyPromises: new Map([
      ['kuali', Promise.resolve()],
      ['ucpath', Promise.resolve()],
    ]),
  })
  s.onBrowserDisconnect(() => {})
  kualiBrowser.emit('disconnected') // only kuali disconnects — ucpath never does

  // Touch the OTHER (never-disconnected) system last — the system whose
  // Playwright call would actually have thrown the "Target closed"-shaped
  // error. Before the fix this returned true (any-system disconnect), which
  // would have downgraded a real ucpath handler bug to a cancelled row.
  await s.page('ucpath')
  assert.equal(
    s.hadBrowserDisconnect(),
    false,
    "a real ucpath handler bug must not be reclassified as cancelled just because kuali disconnected earlier",
  )

  // Touching the system that ACTUALLY disconnected still reclassifies correctly.
  await s.page('kuali')
  assert.equal(s.hadBrowserDisconnect(), true)
})

/** Launch fake whose `browser` is a real EventEmitter so a `disconnected` event
 *  reaches the health-emitting listener that `Session.launch` registers. */
function emitterBrowserLaunch(page: import('playwright').Page): {
  browser: EventEmitter
  launchFn: () => Promise<{ page: import('playwright').Page; context: import('playwright').BrowserContext; browser: import('playwright').Browser }>
} {
  const browser = Object.assign(new EventEmitter(), { close: async () => {} })
  const context = { close: async () => {}, newPage: async () => page } as unknown as import('playwright').BrowserContext
  return {
    browser,
    launchFn: async () => ({ page, context, browser: browser as unknown as import('playwright').Browser }),
  }
}

test('session: a SPONTANEOUS browser disconnect surfaces `failed` (genuine crash)', async () => {
  const emits: Array<{ status: string; reason?: string }> = []
  const { browser, launchFn } = emitterBrowserLaunch(makeHealthPage())
  const s = await Session.launch([{ id: 'kuali', login: async () => {} }], {
    launchFn,
    observer: { onBrowserHealth: (_id, status, reason) => emits.push({ status, ...(reason ? { reason } : {}) }) },
  })
  try {
    browser.emit('disconnected') // chromium died on its own — a real fault
    const failed = emits.find((e) => e.status === 'failed')
    assert.ok(failed, `a real crash must surface failed: ${JSON.stringify(emits)}`)
    assert.equal(failed!.reason, 'browser disconnected')
  } finally {
    await s.close()
  }
})

test('session: a disconnect during DELIBERATE teardown does NOT surface `failed` (manual stop)', async () => {
  const emits: Array<{ status: string; reason?: string }> = []
  const { browser, launchFn } = emitterBrowserLaunch(makeHealthPage())
  const s = await Session.launch([{ id: 'kuali', login: async () => {} }], {
    launchFn,
    observer: { onBrowserHealth: (_id, status, reason) => emits.push({ status, ...(reason ? { reason } : {}) }) },
  })
  // Operator stop → the force-stop path flags the session closing BEFORE chromium
  // dies; the resulting `disconnected` is OUR kill, not a fault.
  await s.killChromeHard(0)
  browser.emit('disconnected')
  assert.equal(
    emits.filter((e) => e.status === 'failed').length,
    0,
    `a manual stop must not emit a browser failed event: ${JSON.stringify(emits)}`,
  )
  // …but the disconnect is still RECORDED for the daemon's reassign/fail logic.
  assert.deepEqual([...s.disconnectedSystems()], ['kuali'])
})

test('session: systemIds returns declared ids in order', () => {
  const systems = [makeSystem('ucpath'), makeSystem('kuali')]
  const s = Session.forTesting({ systems, browsers: new Map(), readyPromises: new Map() })
  assert.deepEqual(s.systemIds(), ['ucpath', 'kuali'])
})

test('session: chromePids returns finite Chromium process ids by system', () => {
  const fakePage = {} as import('playwright').Page
  const systems = [makeSystem('ucpath'), makeSystem('kuali'), makeSystem('crm')]
  const s = Session.forTesting({
    systems,
    browsers: new Map([
      ['ucpath', { page: fakePage, browser: null as never, context: null as never, chromiumPid: 111 }],
      ['kuali', { page: fakePage, browser: null as never, context: null as never }],
      ['crm', { page: fakePage, browser: null as never, context: null as never, chromiumPid: Number.NaN }],
    ]),
    readyPromises: new Map(),
  })
  assert.deepEqual(s.chromePids, { ucpath: 111 })
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

test('session.pageAccess: bumps the counter and tracks the last system on every page()', async () => {
  const fakePage = {} as import('playwright').Page
  const s = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }, { id: 'crm', login: async () => {} }],
    browsers: new Map([
      ['ucpath', { page: fakePage, browser: null as never, context: null as never }],
      ['crm', { page: fakePage, browser: null as never, context: null as never }],
    ]),
    readyPromises: new Map([
      ['ucpath', Promise.resolve()],
      ['crm', Promise.resolve()],
    ]),
  })

  // No page touched yet.
  assert.deepEqual(s.pageAccess(), { seq: 0, system: null })

  await s.page('ucpath')
  assert.deepEqual(s.pageAccess(), { seq: 1, system: 'ucpath' })

  await s.page('crm')
  assert.deepEqual(s.pageAccess(), { seq: 2, system: 'crm' })

  // A second access of the same system still advances the counter (so a step
  // that re-fetches the same page is detected as having touched a browser).
  await s.page('crm')
  assert.deepEqual(s.pageAccess(), { seq: 3, system: 'crm' })
})

test('session.launch (1 system): fast path — no settle, no stagger, just one login', async () => {
  const order: string[] = []
  const start = Date.now()
  const sys: SystemConfig = {
    id: 'solo',
    login: async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('solo')
    },
  }

  const s = await Session.launch([sys], {
    // Pass settle/stagger to prove the 1-system path ignores them.
    settleMs: 5_000,
    staggerMs: 5_000,
    launchFn: fakeLaunch,
  })
  const elapsed = Date.now() - start
  assert.deepEqual(order, ['solo'])
  assert.ok(elapsed < 1_000, `1-system fast path should not apply settle (took ${elapsed}ms)`)
  await s.close()
})

test('session.launch: abortSignal rejects an in-progress login without waiting for retries', async () => {
  const controller = new AbortController()
  let loginStarted!: () => void
  const started = new Promise<void>((resolve) => { loginStarted = resolve })
  const sys: SystemConfig = {
    id: 'ucpath',
    login: async () => {
      loginStarted()
      await new Promise(() => {})
    },
  }

  const launched = Session.launch([sys], {
    launchFn: fakeLaunch,
    abortSignal: controller.signal,
  })
  await started
  controller.abort(new Error('stop requested during auth'))

  await assert.rejects(
    () => Promise.race([
      launched,
      new Promise((_, reject) => setTimeout(() => reject(new Error('launch did not abort')), 250)),
    ]),
    /stop requested during auth|aborted/i,
  )
})

test('session.launch (parallel-staggered): submits fire `staggerMs` apart, settle delays the first', async () => {
  // Use small ms in tests so wall time is bounded; production defaults are
  // staggerMs=5_000 and settleMs=2_000.
  const STAGGER_MS = 50
  const SETTLE_MS = 30
  const completed: Array<{ id: string; at: number }> = []
  const start = Date.now()
  const mkSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      // Simulated Duo wait — equal per system so completion order tracks
      // click order.
      await new Promise((r) => setTimeout(r, 20))
      completed.push({ id, at: Date.now() - start })
    },
  })

  const systems = [mkSys('a'), mkSys('b'), mkSys('c')]
  const s = await Session.launch(systems, {
    staggerMs: STAGGER_MS,
    settleMs: SETTLE_MS,
    // Disable the cap so we measure stagger between every submit, not the
    // semaphore queueing behavior.
    maxConcurrentDuos: 3,
    launchFn: fakeLaunch,
  })

  await Promise.all([s.page('a'), s.page('b'), s.page('c')])

  // Equal-duration logins: completion order matches click order.
  assert.deepEqual(completed.map((c) => c.id), ['a', 'b', 'c'])
  // 'a' fires at SETTLE_MS, completes after +20ms (≥30ms).
  assert.ok(
    completed[0].at >= SETTLE_MS,
    `expected a completion ≥${SETTLE_MS}ms (post-settle), got ${completed[0].at}ms`,
  )
  // 'b' fires at SETTLE_MS + STAGGER_MS, completes ≥(30+50)ms.
  assert.ok(
    completed[1].at >= SETTLE_MS + STAGGER_MS,
    `expected b completion ≥${SETTLE_MS + STAGGER_MS}ms, got ${completed[1].at}ms`,
  )
  // 'c' fires at SETTLE_MS + 2*STAGGER_MS, completes ≥(30+100)ms.
  assert.ok(
    completed[2].at >= SETTLE_MS + 2 * STAGGER_MS,
    `expected c completion ≥${SETTLE_MS + 2 * STAGGER_MS}ms, got ${completed[2].at}ms`,
  )
  await s.close()
})

test('session.launch (parallel-staggered): maxConcurrentDuos=2 queues additional systems', async () => {
  // With 4 systems and cap=2, only 2 logins run at once. System #3 cannot
  // start its login until either #1 or #2 has completed.
  const STAGGER_MS = 10
  const SETTLE_MS = 10
  const LOGIN_DURATION = 80
  const events: Array<{ id: string; phase: 'start' | 'done'; at: number }> = []
  const start = Date.now()
  const mkSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      events.push({ id, phase: 'start', at: Date.now() - start })
      await new Promise((r) => setTimeout(r, LOGIN_DURATION))
      events.push({ id, phase: 'done', at: Date.now() - start })
    },
  })

  const systems = [mkSys('a'), mkSys('b'), mkSys('c'), mkSys('d')]
  const s = await Session.launch(systems, {
    staggerMs: STAGGER_MS,
    settleMs: SETTLE_MS,
    maxConcurrentDuos: 2,
    launchFn: fakeLaunch,
  })

  await Promise.all([s.page('a'), s.page('b'), s.page('c'), s.page('d')])

  // a and b start in the first batch. c and d must wait for a slot to free.
  const aStart = events.find((e) => e.id === 'a' && e.phase === 'start')!
  const bStart = events.find((e) => e.id === 'b' && e.phase === 'start')!
  const cStart = events.find((e) => e.id === 'c' && e.phase === 'start')!
  const dStart = events.find((e) => e.id === 'd' && e.phase === 'start')!

  // a and b fire promptly under the cap (settle + small stagger between).
  assert.ok(aStart.at < LOGIN_DURATION, `a should start in first batch, got ${aStart.at}ms`)
  assert.ok(bStart.at < LOGIN_DURATION, `b should start in first batch, got ${bStart.at}ms`)
  // c only fires after one of {a, b} has completed (≈LOGIN_DURATION).
  assert.ok(
    cStart.at >= LOGIN_DURATION,
    `c should wait for cap slot to free (≥${LOGIN_DURATION}ms), got ${cStart.at}ms`,
  )
  // d also fires only after another slot frees.
  assert.ok(
    dStart.at >= LOGIN_DURATION,
    `d should wait for cap slot to free (≥${LOGIN_DURATION}ms), got ${dStart.at}ms`,
  )
  await s.close()
})

test('session.launch (parallel-staggered): default Duo cap serializes pending prompts', async () => {
  const LOGIN_DURATION = 60
  const events: Array<{ id: string; phase: 'start' | 'done'; at: number }> = []
  const start = Date.now()
  const mkSys = (id: string): SystemConfig => ({
    id,
    login: async () => {
      events.push({ id, phase: 'start', at: Date.now() - start })
      await new Promise((r) => setTimeout(r, LOGIN_DURATION))
      events.push({ id, phase: 'done', at: Date.now() - start })
    },
  })

  const s = await Session.launch([mkSys('a'), mkSys('b')], {
    staggerMs: 0,
    settleMs: 0,
    launchFn: fakeLaunch,
  })

  await Promise.all([s.page('a'), s.page('b')])

  const aDone = events.find((e) => e.id === 'a' && e.phase === 'done')!
  const bStart = events.find((e) => e.id === 'b' && e.phase === 'start')!
  assert.ok(
    bStart.at >= aDone.at,
    `default cap should wait for a Duo slot to free before b starts; a done at ${aDone.at}ms, b started at ${bStart.at}ms`,
  )
  await s.close()
})

test('session.launch (parallel-staggered): one auth failure does not block siblings', async () => {
  const completed: string[] = []
  const systems: SystemConfig[] = [
    { id: 'a', login: async () => { completed.push('a') } },
    { id: 'b', login: async () => { throw new Error('b login failed') } },
    { id: 'c', login: async () => { completed.push('c') } },
  ]
  const s = await Session.launch(systems, {
    staggerMs: 10,
    settleMs: 0,
    maxConcurrentDuos: 3,
    launchFn: fakeLaunch,
  })

  await assert.rejects(() => s.page('b'), /b login failed/)
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

test('session.screenshotAll honors configured screenshot dir for test isolation', async () => {
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const shotDir = mkdtempSync(join(tmpdir(), 'session-shots-'))
  const mkPage = () => ({
    isClosed: () => false,
    evaluate: async (_fn: unknown) => undefined,
    waitForTimeout: async (_ms: number) => undefined,
    screenshot: async (_opts: { path: string }) => undefined,
  }) as unknown as import('playwright').Page

  const s = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map([
      ['ucpath', { page: mkPage(), browser: null as never, context: null as never }],
    ]),
    readyPromises: new Map(),
    screenshotDir: shotDir,
  })

  try {
    const paths = await s.screenshotAll('isolated-prefix')
    assert.equal(paths.length, 1)
    assert.equal(paths[0].startsWith(`${shotDir}/`), true)
    assert.equal(existsSync(shotDir), true)
  } finally {
    rmSync(shotDir, { recursive: true, force: true })
  }
})

test('session.screenshotAll: writes one PNG per open page, skips closed, returns paths', async () => {
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const shotDir = mkdtempSync(join(tmpdir(), 'session-shots-'))
  const shotCalls: Array<{ id: string; path: string }> = []
  const mkPage = (id: string, closed: boolean) => ({
    isClosed: () => closed,
    // captureFullPage uses page.evaluate + waitForTimeout to expand
    // inner-scroll containers before the screenshot. Stub both so the
    // mock page survives the full capture path.
    evaluate: async (_fn: unknown) => undefined,
    waitForTimeout: async (_ms: number) => undefined,
    screenshot: async (opts: { path: string }) => {
      shotCalls.push({ id, path: opts.path })
    },
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
    screenshotDir: shotDir,
  })

  const paths = await s.screenshotAll('test-prefix')
  try {
    assert.equal(paths.length, 2, 'only 2 open pages → 2 paths')
    assert.ok(existsSync(shotDir), `${shotDir} directory created`)
    // Each path matches `<screenshotDir>/<prefix>-<systemId>-<timestamp>.png`
    const escapedDir = shotDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pathRe = new RegExp(`^${escapedDir}[\\\\/]test-prefix-(ucpath|kuali)-\\d+\\.png$`)
    for (const p of paths) {
      assert.match(p, pathRe)
    }
    // Screenshot calls correspond 1:1 to returned paths
    assert.equal(shotCalls.length, 2)
    const ids = shotCalls.map((c) => c.id).sort()
    assert.deepEqual(ids, ['kuali', 'ucpath'])
  } finally {
    rmSync(shotDir, { recursive: true, force: true })
  }
})

test('session.screenshotAll: a failed screenshot does not skip siblings', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const shotDir = mkdtempSync(join(tmpdir(), 'session-shots-'))
  const mkOk = (id: string) => ({
    isClosed: () => false,
    evaluate: async (_fn: unknown) => undefined,
    waitForTimeout: async (_ms: number) => undefined,
    screenshot: async () => { /* ok */ void id },
  }) as unknown as import('playwright').Page
  const mkBad = () => ({
    isClosed: () => false,
    evaluate: async (_fn: unknown) => undefined,
    waitForTimeout: async (_ms: number) => undefined,
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
    screenshotDir: shotDir,
  })

  const paths = await s.screenshotAll('sibling-test')
  try {
    // `a` and `c` succeeded; `b-bad` threw and was skipped.
    assert.equal(paths.length, 2)
    assert.ok(paths.some((p) => p.includes('-a-')))
    assert.ok(paths.some((p) => p.includes('-c-')))
    assert.ok(!paths.some((p) => p.includes('-b-bad-')))
  } finally {
    rmSync(shotDir, { recursive: true, force: true })
  }
})

// Fake launch helper used in tests — returns a stub Page/Browser/Context.
function fakeLaunch() {
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/',
    reload: async () => {},
  } as unknown as import('playwright').Page
  const context = { close: async () => {} } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return Promise.resolve({ page, context, browser })
}

test('session.launch: observer hooks fire in correct per-system order (success)', async () => {
  // With parallel-staggered (≥2 systems) per-system events interleave with
  // the other system. So we assert the per-system relative order
  // (browser → authStart → login → authComplete) rather than a strict
  // global event sequence. Settle/stagger are zeroed so this test stays
  // fast.
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
    {
      launchFn: fakeLaunch,
      observer,
      staggerMs: 0,
      settleMs: 0,
      maxConcurrentDuos: 2,
    },
  )
  await Promise.all([s.page('a'), s.page('b')])

  for (const id of ['a', 'b']) {
    const browserIdx = events.indexOf(`browser:${id}:${id}`)
    const authStartIdx = events.indexOf(`authStart:${id}:${id}`)
    const loginIdx = events.indexOf(`login:${id}`)
    const authCompleteIdx = events.indexOf(`authComplete:${id}:${id}`)
    assert.ok(browserIdx >= 0, `${id}: browser event missing`)
    assert.ok(
      browserIdx < authStartIdx && authStartIdx < loginIdx && loginIdx < authCompleteIdx,
      `${id}: events not in browser → authStart → login → authComplete order; got ${events.join(', ')}`,
    )
  }
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

test('session: UCPath idle reload fires after idle threshold', async () => {
  const reloads: number[] = []
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/psp',
    reload: async () => {
      reloads.push(1)
    },
  } as unknown as import('playwright').Page
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext

  const s = await Session.launch(
    [{ id: 'ucpath', login: async () => {} }],
    {
      launchFn: async () => ({
        page,
        context,
        browser: { close: async () => {} } as import('playwright').Browser,
      }),
      // Longer threshold vs. wait window so exactly one reload fits (timer keeps firing).
      idleRefreshOverride: { thresholdMs: 200, tickMs: 40 },
    },
  )
  try {
    await s.page('ucpath')
    s.setIdleRefreshGuard(() => false)
    await new Promise((r) => setTimeout(r, 280))
    assert.equal(reloads.length, 1)
  } finally {
    await s.close()
  }
})

test('session: UCPath idle reload suppressed when idle guard is busy', async () => {
  const reloads: number[] = []
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/psp',
    reload: async () => {
      reloads.push(1)
    },
  } as unknown as import('playwright').Page
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext

  const s = await Session.launch(
    [{ id: 'ucpath', login: async () => {} }],
    {
      launchFn: async () => ({
        page,
        context,
        browser: { close: async () => {} } as import('playwright').Browser,
      }),
      idleRefreshOverride: { thresholdMs: 200, tickMs: 40 },
    },
  )
  try {
    await s.page('ucpath')
    s.setIdleRefreshGuard(() => true)
    await new Promise((r) => setTimeout(r, 280))
    assert.equal(reloads.length, 0)
  } finally {
    await s.close()
  }
})

test('session: idle reload also fires for i9 (registry-driven, not ucpath-only)', async () => {
  const reloads: number[] = []
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://wwwe.i9complete.com/dashboard',
    reload: async () => {
      reloads.push(1)
    },
  } as unknown as import('playwright').Page
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext

  const s = await Session.launch(
    [{ id: 'i9', login: async () => {} }],
    {
      launchFn: async () => ({
        page,
        context,
        browser: { close: async () => {} } as import('playwright').Browser,
      }),
      idleRefreshOverride: { thresholdMs: 200, tickMs: 40 },
    },
  )
  try {
    await s.page('i9')
    s.setIdleRefreshGuard(() => false)
    await new Promise((r) => setTimeout(r, 280))
    assert.equal(reloads.length, 1)
  } finally {
    await s.close()
  }
})

test('session: idle reload also fires for new-kronos (registry-driven, co-resident with ucpath in separations)', async () => {
  const reloads: number[] = []
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://www.dayforcehcm.com/mydayforce',
    reload: async () => {
      reloads.push(1)
    },
  } as unknown as import('playwright').Page
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext

  const s = await Session.launch(
    [{ id: 'new-kronos', login: async () => {} }],
    {
      launchFn: async () => ({
        page,
        context,
        browser: { close: async () => {} } as import('playwright').Browser,
      }),
      idleRefreshOverride: { thresholdMs: 200, tickMs: 40 },
    },
  )
  try {
    await s.page('new-kronos')
    s.setIdleRefreshGuard(() => false)
    await new Promise((r) => setTimeout(r, 280))
    assert.equal(reloads.length, 1)
  } finally {
    await s.close()
  }
})

test('session: idle reload is suppressed while auth in progress, fires after auth completes', async () => {
  const reloads: number[] = []
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/psp',
    reload: async () => {
      reloads.push(1)
    },
  } as unknown as import('playwright').Page
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext

  // Two systems take the ≥2-system parallel-staggered path. There, the login
  // IIFEs are NOT awaited by Session.launch — it returns immediately while auth
  // continues in the background, so we can observe the in-progress window from
  // the test. Hold both logins open, let the idle timer tick well past the
  // threshold, assert NO reload fired, then release auth and assert a reload
  // fires once the threshold elapses post-auth.
  let releaseA!: () => void
  let releaseB!: () => void
  const gateA = new Promise<void>((r) => { releaseA = r })
  const gateB = new Promise<void>((r) => { releaseB = r })

  const s = await Session.launch(
    [
      { id: 'ucpath', login: async () => { await gateA } },
      { id: 'i9', login: async () => { await gateB } },
    ],
    {
      launchFn: async () => ({
        page,
        context,
        browser: { close: async () => {} } as import('playwright').Browser,
      }),
      staggerMs: 0,
      settleMs: 0,
      maxConcurrentDuos: 2,
      idleRefreshOverride: { thresholdMs: 100, tickMs: 20 },
    },
  )

  try {
    // ucpath + i9 both opt into idle-refresh. Auth is in progress (gates not
    // released). Wait well past the idle threshold — the auth guard must
    // suppress every tick.
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(reloads.length, 0, 'no reload may fire while auth is in progress')

    // Release auth. After auth settles, authInProgress flips false; the next
    // idle tick past the threshold should reload (no ctx.step guard wired).
    releaseA!()
    releaseB!()
    await Promise.all([s.page('ucpath'), s.page('i9')])
    // Settle the post-auth `authInProgress = false` microtask, then wait past
    // the threshold so a tick fires.
    await new Promise((r) => setTimeout(r, 250))
    assert.ok(reloads.length >= 1, `a reload should fire after auth completes + idle threshold (got ${reloads.length})`)
  } finally {
    await s.close()
  }
})

// ── Per-browser health: refresh / focus + the auto-recovery monitor ────────
//
// All use Session.launch (not forTesting) so the real observer wiring
// (launch → healthCb → observer.onBrowserHealth) is exercised end-to-end.

function makeHealthPage(opts: {
  url?: () => string
  evaluate?: () => Promise<unknown>
  onClose?: () => void
  onReload?: () => void
  isClosed?: () => boolean
} = {}): import('playwright').Page {
  return {
    close: async () => { opts.onClose?.() },
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: opts.isClosed ?? (() => false),
    url: opts.url ?? (() => 'https://example.test/x'),
    reload: async () => { opts.onReload?.() },
    evaluate: opts.evaluate ?? (async () => 1),
  } as unknown as import('playwright').Page
}

/** Launch fake where `context.newPage()` returns a caller-controlled fresh page
 * (distinct from the root page) — needed to exercise `reopenSystem`'s swap. */
function healthFakeLaunchWithNewPage(rootPage: import('playwright').Page, newPageFactory: () => import('playwright').Page) {
  const context = {
    close: async () => {},
    newPage: async () => newPageFactory(),
  } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return async () => ({ page: rootPage, context, browser })
}

function healthFakeLaunch(page: import('playwright').Page) {
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext
  const browser = { close: async () => {} } as unknown as import('playwright').Browser
  return async () => ({ page, context, browser })
}

test('session.focusSystem: brings the system window to front (which-browser-is-this)', async () => {
  let fronted = 0
  const page = {
    close: async () => {},
    bringToFront: async () => { fronted++ },
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/x',
    reload: async () => {},
    evaluate: async () => 1,
  } as unknown as import('playwright').Page
  const s = await Session.launch([{ id: 'a', login: async () => {} }], { launchFn: healthFakeLaunch(page) })
  try {
    fronted = 0 // launch's fast path also calls bringToFront once; reset to isolate focusSystem
    await s.focusSystem('a')
    assert.equal(fronted, 1)
  } finally {
    await s.close()
  }
})

test('session.refreshSystem: reloads + emits refreshing → healthy when the page recovers', async () => {
  const statuses: string[] = []
  let reloaded = false
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/x',
    reload: async () => { reloaded = true },
    evaluate: async () => { if (!reloaded) throw new Error('ctx destroyed'); return 1 },
  } as unknown as import('playwright').Page
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunch(page),
    observer: { onBrowserHealth: (_id, status) => statuses.push(status) },
  })
  try {
    const ok = await s.refreshSystem('a')
    assert.equal(ok, true)
    assert.equal(reloaded, true)
    assert.deepEqual(statuses, ['refreshing', 'healthy'])
  } finally {
    await s.close()
  }
})

test('session.refreshSystem: a closed page is unhealthy (needs reopen), not a dead end', async () => {
  const statuses: Array<{ status: string; reason?: string }> = []
  let reloads = 0
  const page = makeHealthPage({ isClosed: () => true, onReload: () => { reloads++ } })
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunch(page),
    observer: { onBrowserHealth: (_id, status, reason) => statuses.push({ status, ...(reason ? { reason } : {}) }) },
  })
  try {
    const ok = await s.refreshSystem('a')
    assert.equal(ok, false)
    assert.equal(reloads, 0)
    assert.equal(statuses.length, 1)
    assert.equal(statuses[0].status, 'unhealthy')
    assert.match(statuses[0].reason ?? '', /reopen/i)
  } finally {
    await s.close()
  }
})

test('session.reopenSystem: opens a fresh tab, swaps it in, closes the wedged one (no Duo)', async () => {
  const statuses: string[] = []
  let oldClosed = false
  let newPages = 0
  // Wedged root page (execution context dead); the fresh tab is healthy.
  const root = makeHealthPage({
    evaluate: async () => { throw new Error('ctx destroyed') },
    onClose: () => { oldClosed = true },
  })
  const fresh = makeHealthPage({ url: () => 'https://example.test/fresh', evaluate: async () => 1 })
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunchWithNewPage(root, () => { newPages++; return fresh }),
    observer: { onBrowserHealth: (_id, status) => statuses.push(status) },
  })
  try {
    const ok = await s.reopenSystem('a')
    assert.equal(ok, true)
    assert.equal(newPages, 1, 'a fresh tab was opened on the same context')
    assert.equal(oldClosed, true, 'the wedged tab was closed')
    assert.deepEqual(statuses, ['refreshing', 'healthy'])
  } finally {
    await s.close()
  }
})

test('session: health monitor REFRESHES a soft (chrome-error) fault and recovers', async () => {
  const statuses: string[] = []
  let recovered = false
  let reloads = 0
  // chrome-error page → soft → refresh; reload clears it (url becomes good).
  const page = makeHealthPage({
    url: () => (recovered ? 'https://example.test/x' : 'chrome-error://chromewebdata/'),
    onReload: () => { recovered = true; reloads++ },
    evaluate: async () => 1,
  })
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunch(page),
    observer: { onBrowserHealth: (_id, status) => statuses.push(status) },
    healthMonitorOverride: { tickMs: 20 },
  })
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(reloads >= 1, `expected ≥1 refresh (reload), got ${reloads}`)
    assert.equal(statuses[statuses.length - 1], 'healthy', `last status should be healthy: ${statuses.join(',')}`)
  } finally {
    await s.close()
  }
})

test('session: health monitor ESCALATES a wedged page to reopen (fresh tab) and recovers', async () => {
  const statuses: string[] = []
  let reloads = 0
  let newPages = 0
  // Wedged root (evaluate throws, url ok) → NOT soft → skip refresh → reopen.
  const root = makeHealthPage({ evaluate: async () => { throw new Error('ctx destroyed') }, onReload: () => { reloads++ } })
  const fresh = makeHealthPage({ url: () => 'https://example.test/fresh', evaluate: async () => 1 })
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunchWithNewPage(root, () => { newPages++; return fresh }),
    observer: { onBrowserHealth: (_id, status) => statuses.push(status) },
    healthMonitorOverride: { tickMs: 20 },
  })
  try {
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(reloads, 0, 'a wedged page must NOT be reloaded — it escalates straight to reopen')
    assert.ok(newPages >= 1, `expected ≥1 reopen (fresh tab), got ${newPages}`)
    assert.equal(statuses[statuses.length - 1], 'healthy', `last status should be healthy: ${statuses.join(',')}`)
  } finally {
    await s.close()
  }
})

test('session: health monitor surfaces failed after the reopen budget is exhausted', async () => {
  const emits: Array<{ status: string; reason?: string }> = []
  let newPages = 0
  const root = makeHealthPage({ evaluate: async () => { throw new Error('ctx destroyed') } })
  // Every fresh tab is ALSO wedged → reopen never recovers.
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunchWithNewPage(root, () => {
      newPages++
      return makeHealthPage({ evaluate: async () => { throw new Error('ctx destroyed') } })
    }),
    observer: { onBrowserHealth: (_id, status, reason) => emits.push({ status, ...(reason ? { reason } : {}) }) },
    healthMonitorOverride: { tickMs: 20, maxReopens: 2 },
  })
  try {
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(newPages, 2, `should reopen exactly maxReopens(=2) times, got ${newPages}`)
    const failed = emits.find((e) => e.status === 'failed')
    assert.ok(failed, `expected a failed emit: ${JSON.stringify(emits)}`)
    assert.match(failed!.reason ?? '', /exhausted/)
  } finally {
    await s.close()
  }
})

test('session: pauseAutoRecovery stops the monitor refreshing/reopening but still surfaces the fault', async () => {
  const emits: Array<{ status: string; reason?: string }> = []
  let reloads = 0
  let newPages = 0
  const root = makeHealthPage({ evaluate: async () => { throw new Error('ctx destroyed') }, onReload: () => { reloads++ } })
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunchWithNewPage(root, () => { newPages++; return makeHealthPage() }),
    observer: { onBrowserHealth: (_id, status, reason) => emits.push({ status, ...(reason ? { reason } : {}) }) },
    healthMonitorOverride: { tickMs: 20 },
  })
  try {
    s.pauseAutoRecovery('a')
    assert.equal(s.isAutoRecoveryPaused('a'), true)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(reloads, 0, 'paused: no auto-refresh')
    assert.equal(newPages, 0, 'paused: no auto-reopen')
    // The fault is still surfaced (unhealthy with a paused reason).
    const unhealthy = emits.find((e) => e.status === 'unhealthy')
    assert.ok(unhealthy, `expected an unhealthy surface while paused: ${JSON.stringify(emits)}`)
    assert.match(unhealthy!.reason ?? '', /paused/)
  } finally {
    await s.close()
  }
})

test('session: health monitor surfaces an EXPIRED session (SSO url) for re-auth — no refresh/reopen', async () => {
  const emits: Array<{ status: string; reason?: string }> = []
  let reloads = 0
  let newPages = 0
  // Page sitting on the Duo/SSO host → session expired → re-auth needed.
  const page = makeHealthPage({ url: () => 'https://api-xxx.duosecurity.com/frame/prompt', onReload: () => { reloads++ } })
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunchWithNewPage(page, () => { newPages++; return page }),
    observer: { onBrowserHealth: (_id, status, reason) => emits.push({ status, ...(reason ? { reason } : {}) }) },
    healthMonitorOverride: { tickMs: 20 },
  })
  try {
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(reloads, 0, 'an expired session must not be refreshed (would re-land on login)')
    assert.equal(newPages, 0, 'an expired session must not be reopened')
    const failed = emits.find((e) => e.status === 'failed')
    assert.ok(failed, `expected a failed emit: ${JSON.stringify(emits)}`)
    assert.match(failed!.reason ?? '', /re-auth|expired/i)
  } finally {
    await s.close()
  }
})

test('session: idle reload does NOT fire for a non-registry system (crm)', async () => {
  const reloads: number[] = []
  const page = {
    close: async () => {},
    bringToFront: async () => {},
    goto: async () => {},
    waitForTimeout: async () => {},
    isClosed: () => false,
    url: () => 'https://example.test/crm',
    reload: async () => {
      reloads.push(1)
    },
  } as unknown as import('playwright').Page
  const context = {
    close: async () => {},
    newPage: async () => page,
  } as unknown as import('playwright').BrowserContext

  const s = await Session.launch(
    [{ id: 'crm', login: async () => {} }],
    {
      launchFn: async () => ({
        page,
        context,
        browser: { close: async () => {} } as import('playwright').Browser,
      }),
      idleRefreshOverride: { thresholdMs: 200, tickMs: 40 },
    },
  )
  try {
    await s.page('crm')
    s.setIdleRefreshGuard(() => false)
    await new Promise((r) => setTimeout(r, 280))
    assert.equal(reloads.length, 0)
  } finally {
    await s.close()
  }
})

test('session.close: bounded — a hung context.close() falls back to killChromeHard instead of hanging forever', async () => {
  const warnMessages: string[] = []
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation((msg: unknown) => {
    warnMessages.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
  })
  const hangingContext = {
    close: () => new Promise<void>(() => { /* deliberately never resolves — simulates a wedged CDP RPC */ }),
  } as unknown as import('playwright').BrowserContext
  const fakeBrowser = { close: async () => {} } as unknown as import('playwright').Browser
  const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
  const s = Session.forTesting({
    systems: [],
    browsers: new Map([
      ['kuali', { page: fakePage, context: hangingContext, browser: fakeBrowser, chromiumPid: 999_999 }],
    ]),
    readyPromises: new Map(),
  })
  const killSpy = vi.spyOn(s, 'killChromeHard').mockResolvedValue(0)
  vi.useFakeTimers()
  try {
    const closePromise = s.close()
    // Advance well past the default SESSION_CLOSE_TIMEOUT_MS (15s) bound so the
    // hung context.close() never gets a chance to resolve on its own.
    await vi.advanceTimersByTimeAsync(20_000)
    await closePromise
    assert.equal(killSpy.mock.calls.length, 1, 'killChromeHard should fire exactly once the close() timeout trips')
    assert.ok(
      warnMessages.some((m) => m.includes('close()') && m.includes('killChromeHard')),
      `expected a log.warn naming the hang + fallback: ${JSON.stringify(warnMessages)}`,
    )
  } finally {
    vi.useRealTimers()
    warnSpy.mockRestore()
    killSpy.mockRestore()
  }
})

test('session: health monitor catch never swallows silently — logs a warning naming the system + error', async () => {
  const warnMessages: string[] = []
  const warnSpy = vi.spyOn(log, 'warn').mockImplementation((msg: unknown) => {
    warnMessages.push(typeof msg === 'string' ? msg : JSON.stringify(msg))
  })
  const page = makeHealthPage()
  const s = await Session.launch([{ id: 'a', login: async () => {} }], {
    launchFn: healthFakeLaunch(page),
    healthMonitorOverride: { tickMs: 20 },
  })
  const boom = new Error('inspect boom')
  // Monkey-patch the instance's (TS-private, runtime-public) inspectSystemHealth
  // to force the unexpected-throw path the health monitor's catch guards
  // against — the production paths (inspectSystemHealth/refreshSystem/
  // reopenSystem) are all internally defensive today, so this simulates a
  // future/edge-case throw rather than reaching one through real page fakes.
  ;(s as unknown as { inspectSystemHealth: (id: string) => Promise<unknown> }).inspectSystemHealth =
    async () => { throw boom }
  try {
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(
      warnMessages.some((m) => m.includes('a') && m.includes('inspect boom')),
      `expected a log.warn naming the system + error: ${JSON.stringify(warnMessages)}`,
    )
  } finally {
    warnSpy.mockRestore()
    await s.close()
  }
})

test('walkDescendantPids: BFS-walks the full descendant tree via an injected child-lookup, root excluded, no duplicates', () => {
  // Tree:      1
  //          /   \
  //         2     3
  //        /       \
  //       4         5
  const tree: Record<number, number[]> = {
    1: [2, 3],
    2: [4],
    3: [5],
    4: [],
    5: [],
  }
  const getChildren = (pid: number): number[] => tree[pid] ?? []
  const result = walkDescendantPids(1, getChildren)
  assert.deepEqual([...result].sort((a, b) => a - b), [2, 3, 4, 5])
})

test('walkDescendantPids: a cycle in a buggy child-lookup does not infinite-loop', () => {
  const tree: Record<number, number[]> = {
    1: [2],
    2: [1], // cycle back to root
  }
  const getChildren = (pid: number): number[] => tree[pid] ?? []
  const result = walkDescendantPids(1, getChildren)
  assert.deepEqual(result, [2])
})

test('walkDescendantPids: no children returns an empty array', () => {
  const result = walkDescendantPids(42, () => [])
  assert.deepEqual(result, [])
})
