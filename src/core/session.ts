import type { Page, Browser, BrowserContext } from 'playwright'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { SystemConfig, SessionObserver, CaptureFileOpts } from './types.js'
import { launchBrowser } from '../browser/launch.js'
import { log } from '../utils/log.js'
import { classifyPlaywrightError, errorMessage } from '../utils/errors.js'
import { PATHS } from '../config.js'

export function formatCaptureFilename(args: {
  workflow: string
  itemId: string
  kind: 'form' | 'error' | 'manual'
  label: string
  system: string
  ts: number
}): string {
  return `${args.workflow}-${args.itemId}-${args.kind}-${args.label}-${args.system}-${args.ts}.png`
}

interface SystemSlot {
  page: Page
  browser: Browser | null  // null in persistent-session mode
  context: BrowserContext
  /** OS pid of the Chromium process Playwright spawned. Captured by diffing
   * `pgrep -P` around the launch (Playwright's public Browser API doesn't
   * expose the process pid). Undefined if the diff failed (Windows, sandbox,
   * or unusual process tree). */
  chromiumPid?: number
}

interface SessionState {
  systems: SystemConfig[]
  browsers: Map<string, SystemSlot>
  readyPromises: Map<string, Promise<void>>
}

export interface LaunchOpts {
  authChain?: 'sequential' | 'interleaved' | 'parallel-staggered'
  /**
   * Override the inter-submit stagger for `parallel-staggered` authChain.
   * Defaults to 5000ms. Lowered to a small value in unit tests so the
   * stagger doesn't dominate test wall time.
   */
  staggerMs?: number
  /** Injection point for tests. */
  launchFn?: (opts: LaunchOneOpts) => Promise<SystemSlot>
  /** Observability bundle — see SessionObserver in types.ts. */
  observer?: SessionObserver
  /**
   * Fires synchronously after the Session instance is constructed but
   * before any browser launches. Lets callers wire an observer that
   * needs a Session reference (e.g. to build a real ScreenshotFn).
   */
  onReady?: (session: Session) => void
}

interface LaunchOneOpts {
  system: SystemConfig
}

export class Session {
  private parent: Session | null = null

  private constructor(private state: SessionState) {}

  /** Test-only factory to construct a Session with pre-built state. */
  static forTesting(state: SessionState): Session {
    return new Session(state)
  }

  /**
   * Build a per-worker Session view on top of an already-launched parent.
   * Pages are allocated lazily on first `page(id)` call — each worker gets
   * its own Playwright Page opened against the parent's per-system
   * BrowserContext. `browser: null` on each worker slot signals that the
   * worker does not own the browser lifetime; use `closeWorkerPages()` in
   * the worker's `finally` block and let the parent close the context/browser.
   */
  static forWorker(parent: Session): Session {
    const browsers = new Map<string, SystemSlot>()
    const readyPromises = new Map(parent.state.readyPromises)
    const session = new Session({ systems: parent.state.systems, browsers, readyPromises })
    session.parent = parent
    return session
  }

  static async launch(systems: SystemConfig[], opts: LaunchOpts = {}): Promise<Session> {
    const authChain = opts.authChain ?? (systems.length > 1 ? 'interleaved' : 'sequential')
    const launchOne = opts.launchFn ?? defaultLaunchOne

    // Construct the Session with empty maps first so onReady can wire observers
    // that need a Session reference (e.g. to build a real ScreenshotFn) BEFORE
    // any browser launches or auth begins. The maps are mutated in-place below.
    const browsers = new Map<string, SystemSlot>()
    const readyPromises = new Map<string, Promise<void>>()
    const session = new Session({ systems, browsers, readyPromises })
    opts.onReady?.(session)

    // Launch all browsers in parallel. Windows land wherever Chromium drops
    // them — tiling was removed 2026-04-23 once Playwright's default window
    // placement proved fine for the small (≤4) browser counts we actually use.
    const slots = await Promise.all(
      systems.map((s) => launchOne({ system: s })),
    )
    systems.forEach((s, i) => browsers.set(s.id, slots[i]))

    // Fire onBrowserLaunch for each system. browserId === systemId today
    // (one browser per system); if that changes later, mint UUIDs here.
    // `slot.chromiumPid` was captured by `defaultLaunchOne` via pgrep diff
    // so the dashboard's force-stop path can SIGKILL orphaned Chromium when
    // the Node parent dies. Undefined when the diff failed (Windows, etc.).
    for (const s of systems) {
      const slot = browsers.get(s.id)
      opts.observer?.onBrowserLaunch?.(s.id, s.id, slot?.chromiumPid)
    }

    // Parallel prepare: for any system that declares a `prepareLogin`, run
    // it concurrently across all browsers BEFORE the Duo chain starts. Each
    // preparer navigates + fills the SSO form but does NOT submit; the
    // subsequent sequential `login` phase just clicks submit + waits for
    // Duo. Saves 3–8s per system of redundant navigation.
    //
    // Best-effort: a prepare failure here is logged but not fatal — the
    // `login` phase is expected to detect a missing/stale form and re-run
    // the preparer itself before clicking submit.
    const toPrepare = systems.filter((s) => typeof s.prepareLogin === 'function')
    if (toPrepare.length > 0) {
      log.step(`[Session] Prepare-login in parallel for ${toPrepare.length} system(s): ${toPrepare.map((s) => s.id).join(', ')}`)
      await Promise.allSettled(
        toPrepare.map(async (s) => {
          const slot = browsers.get(s.id)
          if (!slot) return
          try {
            await s.prepareLogin!(slot.page)
          } catch (err) {
            log.warn(`[Session: ${s.id}] prepareLogin failed — login phase will re-prepare: ${errorMessage(err)}`)
          }
        }),
      )
    }

    if (authChain === 'sequential') {
      for (const s of systems) {
        const slot = browsers.get(s.id)!
        await slot.page.bringToFront()
        opts.observer?.onAuthStart?.(s.id, s.id)
        await loginWithRetry(
          s, slot.page, opts.observer?.instance,
          () => opts.observer?.onAuthFailed?.(s.id, s.id),
        )
        opts.observer?.onAuthComplete?.(s.id, s.id)
      }
      systems.forEach((s) => readyPromises.set(s.id, Promise.resolve()))
    } else if (authChain === 'parallel-staggered') {
      // Parallel-staggered: every system's login fires in its own promise,
      // each one waiting i*5s before clicking submit so that Duo prompts
      // arrive ~5s apart on the user's phone (avoids the multi-prompt
      // collision documented in src/auth/CLAUDE.md while still letting all
      // Duos pend in parallel — total auth time is max(single Duo) + (N-1)*5s
      // instead of sum(all Duos)). The IIFEs are constructed and registered
      // in `readyPromises` synchronously, so `Session.launch` returns
      // immediately and per-system handlers can proceed via `ctx.page(id)`
      // as each Duo clears (in user-approval order, not click order).
      const STAGGER_MS = opts.staggerMs ?? 5_000
      const submitPromises: Promise<void>[] = []
      for (let i = 0; i < systems.length; i++) {
        const sys = systems[i]
        const slot = browsers.get(sys.id)!
        const p = (async () => {
          // Each system fires `i * STAGGER_MS` after t=0. System 0 fires
          // immediately; system 1 after STAGGER_MS; system 2 after 2*STAGGER_MS;
          // etc. This accumulates so concurrent Duos arrive evenly spaced
          // on the user's phone, not back-to-back per IIFE.
          if (i > 0) await new Promise((resolve) => setTimeout(resolve, i * STAGGER_MS))
          await slot.page.bringToFront()
          opts.observer?.onAuthStart?.(sys.id, sys.id)
          await loginWithRetry(
            sys, slot.page, opts.observer?.instance,
            () => opts.observer?.onAuthFailed?.(sys.id, sys.id),
          )
          opts.observer?.onAuthComplete?.(sys.id, sys.id)
        })()
        // Prevent unhandled-rejection warnings if nobody consumes this
        // promise; per-system handlers consume it via `await ctx.page(id)`,
        // but a workflow that ignores a system would otherwise log noisily.
        p.catch(() => {})
        readyPromises.set(sys.id, p)
        submitPromises.push(p)
      }
      // Don't await all submitPromises here — `Session.launch` resolves once
      // every system has its `readyPromise` registered, matching the shape
      // used by `interleaved`. Auth failures surface via the observer's
      // `onAuthFailed` (kernel emits a `failed` tracker row attributed to
      // `auth:<systemId>`), not by throwing out of Session.launch.
      void Promise.allSettled(submitPromises)
    } else {
      // Interleaved: auth system[0] blocking; chain the rest in background.
      const firstSlot = browsers.get(systems[0].id)!
      await firstSlot.page.bringToFront()
      opts.observer?.onAuthStart?.(systems[0].id, systems[0].id)
      await loginWithRetry(
        systems[0], firstSlot.page, opts.observer?.instance,
        () => opts.observer?.onAuthFailed?.(systems[0].id, systems[0].id),
      )
      opts.observer?.onAuthComplete?.(systems[0].id, systems[0].id)
      readyPromises.set(systems[0].id, Promise.resolve())

      let prev: Promise<void> = Promise.resolve()
      for (let i = 1; i < systems.length; i++) {
        const sys = systems[i]
        const slot = browsers.get(sys.id)!
        // Each chain step ignores predecessor failure so one bad auth doesn't block the next.
        const p = prev
          .catch(() => {})
          .then(() => slot.page.bringToFront())
          .then(() => { opts.observer?.onAuthStart?.(sys.id, sys.id) })
          .then(() => loginWithRetry(
            sys, slot.page, opts.observer?.instance,
            () => opts.observer?.onAuthFailed?.(sys.id, sys.id),
          ))
          .then(() => { opts.observer?.onAuthComplete?.(sys.id, sys.id) })
        // Prevent unhandled rejection warnings if nobody consumes this promise.
        p.catch(() => {})
        readyPromises.set(sys.id, p)
        prev = p
      }
    }

    return session
  }

  systemIds(): string[] {
    return this.state.systems.map((s) => s.id)
  }

  /**
   * Map of `systemId → chromium parent process pid` for every browser this
   * Session launched, captured by `defaultLaunchOne` via a pgrep diff around
   * `chromium.launch`. Worker sessions (browser: null) inherit nothing — they
   * don't own any chrome lifetime. Used by:
   *   - daemon `/status` so the dashboard / spawn pre-check can see what
   *     chromium processes belong to which alive daemon
   *   - `Session.killChromeHard` (force-stop teardown) to SIGTERM/SIGKILL
   *     chromium directly when Playwright's graceful close is too slow
   *     (e.g. mid-Playwright-RPC the parent dies → ChildProcess.close() never
   *     completes → 50ms exit window leaks chromium)
   */
  get chromePids(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [id, slot] of this.state.browsers) {
      if (slot.chromiumPid && Number.isFinite(slot.chromiumPid)) {
        out[id] = slot.chromiumPid
      }
    }
    return out
  }

  /**
   * Hard-kill every tracked chromium process. SIGTERM first, wait
   * `gracePeriodMs`, then SIGKILL any survivors. Worker sessions (browser:
   * null) inherit no PIDs from the parent's slots, so calling this on a
   * worker is a no-op. Best-effort: a kill EPERM/ESRCH never throws.
   *
   * Used by the daemon's force-stop path to guarantee chromium is dead
   * before `process.exit()` runs — replacing the prior "graceful
   * `browser.close()` with 50ms window" approach which often left
   * chromium subprocesses orphaned (adopted by init, ppid=1) and
   * cascaded into the "8 chrome windows after retry" bug.
   */
  killChromeHard(gracePeriodMs = 2_000): Promise<number> {
    const pids = Object.values(this.chromePids)
    if (pids.length === 0) return Promise.resolve(0)
    let killed = 0
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); killed++ } catch { /* already dead */ }
    }
    return new Promise<number>((resolve) => {
      setTimeout(() => {
        for (const pid of pids) {
          try {
            process.kill(pid, 0) // is it still alive?
            // Still alive — escalate.
            try { process.kill(pid, 'SIGKILL') } catch { /* race — gone now */ }
          } catch {
            // ESRCH — process already gone
          }
        }
        resolve(killed)
      }, gracePeriodMs).unref()
    })
  }

  async page(id: string): Promise<Page> {
    const ready = this.state.readyPromises.get(id)
    if (!ready) throw new Error(`unknown system: ${id}`)
    await ready
    let slot = this.state.browsers.get(id)
    if (!slot && this.parent) {
      const parentSlot = this.parent.state.browsers.get(id)
      if (!parentSlot) throw new Error(`no browser for system: ${id}`)
      const page = await parentSlot.context.newPage()
      slot = { page, context: parentSlot.context, browser: null }
      this.state.browsers.set(id, slot)
    }
    if (!slot) throw new Error(`no browser for system: ${id}`)
    return slot.page
  }

  async close(): Promise<void> {
    for (const slot of this.state.browsers.values()) {
      await slot.context.close()
      if (slot.browser) await slot.browser.close()
    }
  }

  /**
   * Close every page this worker-session opened (from Session.forWorker).
   * Contexts and browsers belong to the parent — left untouched.
   * Best-effort: a close failure on one page never blocks siblings.
   */
  async closeWorkerPages(): Promise<void> {
    for (const slot of this.state.browsers.values()) {
      try {
        if (!slot.page.isClosed()) await slot.page.close()
      } catch {
        // best-effort
      }
    }
  }

  async reset(id: string): Promise<void> {
    const sys = this.state.systems.find((s) => s.id === id)
    if (!sys?.resetUrl) return
    const slot = this.state.browsers.get(id)
    if (!slot) return
    await slot.page.goto(sys.resetUrl)
  }

  /**
   * Probe a system's page for liveness before reusing it (e.g. between
   * batch items, or mid-handler when a long step is about to start).
   * Catches three failure modes that `isClosed()` alone misses:
   *   - Page object closed by Playwright             — `isClosed()`
   *   - Execution context destroyed (SAML expiry,    — `evaluate(() => 1)`
   *     navigation race, page-level crash)              with a 5s timeout
   *   - Page never navigated past `about:blank`      — `url()` check
   *
   * Best-effort: every probe path is wrapped in try/catch and returns false
   * on any error rather than propagating — callers treat this as a boolean
   * gate, not a diagnostic.
   */
  async healthCheck(id: string): Promise<boolean> {
    const slot = this.state.browsers.get(id)
    if (!slot) return false
    try {
      if (slot.page.isClosed()) return false
      // Stuck on about:blank means either un-navigated or a SAML redirect that
      // never completed — both are reasons to abort the next item.
      const url = slot.page.url()
      if (!url || url === 'about:blank') return false
      // A trivial JS roundtrip detects: hung renderer, destroyed execution
      // context (the symptom of SAML session expiry mid-batch), and stale
      // page handles whose underlying target is gone.
      const probed = await Promise.race([
        slot.page.evaluate(() => 1).then((v) => v === 1).catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ])
      return probed
    } catch {
      return false
    }
  }

  /**
   * Register a handler that fires when any system's browser disconnects
   * (user closed the window, Chrome crashed, OS killed the process, etc.).
   * Returns an unsubscribe function that detaches every listener.
   *
   * Worker slots (browser: null) are skipped — the parent owns browser
   * lifetime in shared-context-pool mode.
   */
  onBrowserDisconnect(handler: (systemId: string) => void): () => void {
    const registered: Array<{ browser: Browser; listener: () => void }> = []
    for (const [systemId, slot] of this.state.browsers) {
      if (!slot.browser) continue
      const listener = (): void => handler(systemId)
      slot.browser.on('disconnected', listener)
      registered.push({ browser: slot.browser, listener })
    }
    return (): void => {
      for (const { browser, listener } of registered) {
        try { browser.off('disconnected', listener) } catch { /* ignore */ }
      }
    }
  }

  async killChrome(): Promise<void> {
    // SIGINT teardown — force-close all browsers without awaiting graceful shutdown.
    for (const slot of this.state.browsers.values()) {
      try { await slot.browser?.close() } catch { /* ignore */ }
    }
  }

  /**
   * Capture a screenshot of the entire page content, including content inside
   * scrollable inner containers (Kuali modals, PeopleSoft iframes with
   * fixed-height overflow wrappers). `fullPage: true` alone only expands the
   * document height — it doesn't release `overflow: auto/scroll` on inner
   * divs. So we temporarily strip overflow + max-height + height caps from
   * every scrollable element, let layout settle, take the shot, then restore
   * the original inline styles. Restoration is best-effort; a late-failing
   * restore still leaves the DOM visually consistent because we reset styles
   * back to whatever was inline before our mutation.
   *
   * The mutation window is ~300ms (waitForTimeout) — acceptable for form-audit
   * screenshots which happen between discrete Playwright actions, not during
   * active typing.
   */
  static async captureFullPage(page: Page, path: string): Promise<Buffer> {
    let restoreFn: (() => Promise<void>) | null = null
    try {
      await page.evaluate(() => {
        interface Saved {
          el: HTMLElement
          overflow: string
          overflowX: string
          overflowY: string
          maxHeight: string
          height: string
          minHeight: string
        }
        const saved: Saved[] = []
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
          const s = getComputedStyle(el)
          const scrolls =
            (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowX === 'auto' || s.overflowX === 'scroll') &&
            (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
          // Also catch elements constrained purely by max-height (Kuali action-list
          // modal sizes itself with `max-height: calc(...)` + flex layout, no
          // scrollbar present until content overflows). Without this branch the
          // earlier overflow-only filter let those modals clip the screenshot.
          const constrained =
            s.maxHeight !== 'none' &&
            parseFloat(s.maxHeight) > 0 &&
            el.scrollHeight > el.clientHeight + 2
          if (!scrolls && !constrained) continue
          saved.push({
            el,
            overflow: el.style.overflow,
            overflowX: el.style.overflowX,
            overflowY: el.style.overflowY,
            maxHeight: el.style.maxHeight,
            height: el.style.height,
            minHeight: el.style.minHeight,
          })
          el.style.overflow = 'visible'
          el.style.overflowX = 'visible'
          el.style.overflowY = 'visible'
          el.style.maxHeight = 'none'
          el.style.height = 'auto'
          // Flex children won't grow if min-height is set — neutralize it so
          // the modal's inner form can expand to its full content height.
          el.style.minHeight = '0'
        }
        // Reset scroll position so fullPage starts from the top of the
        // (now expanded) document. Kuali's action-list modal often starts
        // mid-document if the operator scrolled in a previous step.
        window.scrollTo(0, 0)
        // Force a layout flush so subsequent reads see the new geometry.
        void document.body.offsetHeight
        ;(window as unknown as { __restoreScrollContainers?: () => void }).__restoreScrollContainers = () => {
          for (const r of saved) {
            r.el.style.overflow = r.overflow
            r.el.style.overflowX = r.overflowX
            r.el.style.overflowY = r.overflowY
            r.el.style.maxHeight = r.maxHeight
            r.el.style.height = r.height
            r.el.style.minHeight = r.minHeight
          }
          delete (window as unknown as { __restoreScrollContainers?: () => void }).__restoreScrollContainers
        }
      })
      restoreFn = async () => {
        try {
          await page.evaluate(() => {
            const w = window as unknown as { __restoreScrollContainers?: () => void }
            w.__restoreScrollContainers?.()
          })
        } catch { /* best-effort */ }
      }
      // 800ms settle: Kuali's modal has a CSS height transition that 300ms
      // (the previous value) clipped intermittently. The capture is between
      // discrete Playwright actions, not during typing — extra 500ms is fine.
      await page.waitForTimeout(800)
      const buf = await page.screenshot({ path, fullPage: true })
      return buf
    } finally {
      if (restoreFn) await restoreFn()
    }
  }

  /**
   * Take a screenshot of every open page in the Session and write PNGs to
   * `.screenshots/<prefix>-<systemId>-<timestamp>.png`. Best-effort — a failure
   * on one page (closed tab, I/O error) never skips the siblings. Returns the
   * list of files successfully written.
   */
  async screenshotAll(prefix: string): Promise<string[]> {
    const paths: string[] = []
    try {
      await fs.mkdir(PATHS.screenshotDir, { recursive: true })
    } catch { /* best-effort */ }
    for (const [id, slot] of this.state.browsers.entries()) {
      try {
        if (slot.page.isClosed()) continue
      } catch { continue }
      const path = join(PATHS.screenshotDir, `${prefix}-${id}-${Date.now()}.png`)
      try {
        // captureFullPage: expand inner scroll containers (Kuali modals,
        // PeopleSoft frames) before `fullPage: true`, then restore. A
        // plain `fullPage` shot alone clips off Final Transactions,
        // comments, and the Save button area because those live inside
        // overflow-auto divs.
        await Session.captureFullPage(slot.page, path)
        paths.push(path)
      } catch { /* best-effort — one failed screenshot mustn't skip siblings */ }
    }
    return paths
  }

  /**
   * Capture all open pages as structured PNGs under `.screenshots/`, using the
   * canonical `{workflow}-{itemId}-{kind}-{label}-{system}-{ts}.png` convention.
   * Best-effort — a failure on one page never blocks siblings. Returns metadata
   * for each file successfully written.
   */
  async captureAll(opts: CaptureFileOpts): Promise<Array<{ system: string; path: string; bytes: number }>> {
    const outDir = PATHS.screenshotDir
    try {
      await fs.mkdir(outDir, { recursive: true })
    } catch { /* best-effort */ }
    const wanted = new Set(opts.systems ?? Array.from(this.state.browsers.keys()))
    const results: Array<{ system: string; path: string; bytes: number }> = []
    for (const [id, slot] of this.state.browsers.entries()) {
      if (!wanted.has(id)) continue
      try {
        const filename = formatCaptureFilename({
          workflow: opts.workflow, itemId: opts.itemId, kind: opts.kind,
          label: opts.label, system: id, ts: opts.ts,
        })
        const p = join(outDir, filename)
        // Use captureFullPage so inner-scroll containers (Kuali form
        // modals, PeopleSoft frames) are expanded before the fullPage
        // shot — otherwise Final Transactions / comments / Save button
        // sit in an overflow-auto div and get clipped.
        const buf = await Session.captureFullPage(slot.page, p)
        results.push({ system: id, path: p, bytes: buf.byteLength })
      } catch {
        // Best-effort — per-page failures don't block siblings
      }
    }
    for (const pg of opts.pages ?? []) {
      try {
        const filename = formatCaptureFilename({
          workflow: opts.workflow, itemId: opts.itemId, kind: opts.kind,
          label: opts.label, system: 'ad-hoc', ts: opts.ts,
        })
        const p = join(outDir, filename)
        const buf = await Session.captureFullPage(pg, p)
        results.push({ system: 'ad-hoc', path: p, bytes: buf.byteLength })
      } catch {
        // Best-effort
      }
    }
    return results
  }
}

function listChildPids(parentPid: number): number[] {
  // pgrep is on macOS + Linux. Windows path falls through and returns []
  // (chromium-pid wiring is best-effort there; force-stop still SIGKILLs
  // the parent, OS handles orphan reaping differently per platform).
  if (process.platform === 'win32') return []
  try {
    const out = execFileSync('pgrep', ['-P', String(parentPid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).toString()
    return out.trim().split('\n').filter(Boolean).map(Number).filter(Number.isFinite)
  } catch {
    return []
  }
}

async function defaultLaunchOne(opts: LaunchOneOpts): Promise<SystemSlot> {
  const systemId = opts.system.id
  const sessionDir = opts.system.sessionDir
  // Snapshot child pids so we can diff out the new Chromium process after
  // launch. Playwright spawns Chromium as a direct child of the Node parent;
  // there's only one new direct child per launchBrowser() call.
  const childrenBefore = new Set(listChildPids(process.pid))
  try {
    const { browser, context, page } = await launchBrowser({
      sessionDir,
      acceptDownloads: opts.system.acceptDownloads,
    })
    const childrenAfter = listChildPids(process.pid)
    const newChildren = childrenAfter.filter((p) => !childrenBefore.has(p))
    const chromiumPid = newChildren[0]
    return { page, context, browser, chromiumPid }
  } catch (e) {
    const classified = classifyPlaywrightError(e)
    if (classified.kind === 'process-singleton') {
      log.error(`[Session: ${systemId}] ProcessSingleton collision — another process holds the Chrome profile lock. pid=${process.pid} sessionDir='${sessionDir ?? '<ephemeral>'}'`)
    } else {
      log.error(`[Session: ${systemId}] launch failed: ${classified.kind} — ${classified.summary}`)
    }
    throw e
  }
}

const AUTH_MAX_ATTEMPTS = 3;

async function loginWithRetry(
  system: SystemConfig,
  page: Page,
  instance?: string,
  onFailed?: () => void,
): Promise<void> {
  let lastError: string | undefined
  for (let attempt = 1; attempt <= AUTH_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      log.warn(`[Auth: ${system.id}] Retrying (attempt ${attempt}/${AUTH_MAX_ATTEMPTS}) — previous error: ${lastError ?? '<none>'}`)
    } else {
      log.step(`[Auth: ${system.id}] Starting login (attempt ${attempt}/${AUTH_MAX_ATTEMPTS})`)
    }
    try {
      await system.login(page, instance)
      if (attempt > 1) {
        log.success(`[Auth: ${system.id}] Recovered on attempt ${attempt}`)
      }
      return
    } catch (err) {
      lastError = errorMessage(err)
      if (attempt < AUTH_MAX_ATTEMPTS) {
        await page.goto('about:blank').catch(() => {})
        await page.waitForTimeout(1_000)
      } else {
        onFailed?.()
        throw err
      }
    }
  }
}

/**
 * Return a sessionDir path isolated by process PID. Use this for persistent
 * Chrome profiles (launchPersistentContext) in workflows that may be run as
 * multiple parallel OS processes — each process gets its own directory so
 * Chromium's ProcessSingleton lock doesn't collide.
 *
 * @param basePath The non-isolated base (e.g. ~/ukg_session_sep)
 * @param pid Override for testing. Defaults to process.pid.
 */
export function getProcessIsolatedSessionDir(basePath: string, pid: number = process.pid): string {
  return `${basePath}_pid${pid}`;
}
