import type { Page, Browser, BrowserContext } from 'playwright'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SystemConfig, SessionObserver } from './types.js'
import { launchBrowser } from '../browser/launch.js'
import { computeTileLayout } from '../browser/tiling.js'
import { log } from '../utils/log.js'

interface SystemSlot {
  page: Page
  browser: Browser | null  // null in persistent-session mode
  context: BrowserContext
}

interface SessionState {
  systems: SystemConfig[]
  browsers: Map<string, SystemSlot>
  readyPromises: Map<string, Promise<void>>
}

export interface LaunchOpts {
  authChain?: 'sequential' | 'interleaved'
  tiling?: 'auto' | 'single' | 'side-by-side'
  /** Injection point for tests. */
  launchFn?: (opts: LaunchOneOpts) => Promise<SystemSlot>
  /** Observability bundle — see SessionObserver in types.ts. */
  observer?: SessionObserver
}

interface LaunchOneOpts {
  system: SystemConfig
  tileIndex: number
  tileCount: number
  tiling: 'auto' | 'single' | 'side-by-side'
}

export class Session {
  private constructor(private state: SessionState) {}

  /** Test-only factory to construct a Session with pre-built state. */
  static forTesting(state: SessionState): Session {
    return new Session(state)
  }

  static async launch(systems: SystemConfig[], opts: LaunchOpts = {}): Promise<Session> {
    const authChain = opts.authChain ?? (systems.length > 1 ? 'interleaved' : 'sequential')
    const tiling = opts.tiling ?? (systems.length > 1 ? 'auto' : 'single')
    const launchOne = opts.launchFn ?? defaultLaunchOne

    // Launch all browsers in parallel.
    const slots = await Promise.all(
      systems.map((s, i) =>
        launchOne({ system: s, tileIndex: i, tileCount: systems.length, tiling }),
      ),
    )
    const browsers = new Map<string, SystemSlot>()
    systems.forEach((s, i) => browsers.set(s.id, slots[i]))

    // Fire onBrowserLaunch for each system. browserId === systemId today
    // (one browser per system); if that changes later, mint UUIDs here.
    for (const s of systems) {
      opts.observer?.onBrowserLaunch?.(s.id, s.id)
    }

    // Tile windows using actual screen dimensions (detected from first browser via CDP).
    // Skip when a custom launchFn is provided (test injection — no real browsers to tile).
    if (tiling !== 'single' && systems.length > 1 && !opts.launchFn) {
      await tileWindows(systems, browsers)
    }

    const readyPromises = new Map<string, Promise<void>>()

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

    return new Session({ systems, browsers, readyPromises })
  }

  systemIds(): string[] {
    return this.state.systems.map((s) => s.id)
  }

  async page(id: string): Promise<Page> {
    const ready = this.state.readyPromises.get(id)
    if (!ready) throw new Error(`unknown system: ${id}`)
    await ready
    const slot = this.state.browsers.get(id)
    if (!slot) throw new Error(`no browser for system: ${id}`)
    return slot.page
  }

  async close(): Promise<void> {
    for (const slot of this.state.browsers.values()) {
      await slot.context.close()
      if (slot.browser) await slot.browser.close()
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

  async killChrome(): Promise<void> {
    // SIGINT teardown — force-close all browsers without awaiting graceful shutdown.
    for (const slot of this.state.browsers.values()) {
      try { await slot.browser?.close() } catch { /* ignore */ }
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
      await fs.mkdir('.screenshots', { recursive: true })
    } catch { /* best-effort */ }
    for (const [id, slot] of this.state.browsers.entries()) {
      try {
        if (slot.page.isClosed()) continue
      } catch { continue }
      const path = join('.screenshots', `${prefix}-${id}-${Date.now()}.png`)
      try {
        await slot.page.screenshot({ path })
        paths.push(path)
      } catch { /* best-effort — one failed screenshot mustn't skip siblings */ }
    }
    return paths
  }
}

async function defaultLaunchOne(opts: LaunchOneOpts): Promise<SystemSlot> {
  const { browser, context, page } = await launchBrowser({
    sessionDir: opts.system.sessionDir,
  })
  return { page, context, browser }
}

const AUTH_MAX_ATTEMPTS = 3;

async function loginWithRetry(
  system: SystemConfig,
  page: Page,
  instance?: string,
  onFailed?: () => void,
): Promise<void> {
  for (let attempt = 1; attempt <= AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      await system.login(page, instance)
      return
    } catch (err) {
      if (attempt < AUTH_MAX_ATTEMPTS) {
        log.step(`Auth failed for ${system.id} (attempt ${attempt}/${AUTH_MAX_ATTEMPTS}) — refreshing and retrying...`)
        await page.goto('about:blank').catch(() => {})
        await page.waitForTimeout(1_000)
      } else {
        onFailed?.()
        throw err
      }
    }
  }
}

async function tileWindows(
  systems: SystemConfig[],
  browsers: Map<string, SystemSlot>,
): Promise<void> {
  const firstSlot = browsers.get(systems[0].id)!
  const screen = await firstSlot.page.evaluate(() => ({
    width: window.screen.availWidth,
    height: window.screen.availHeight,
  }))

  for (let i = 0; i < systems.length; i++) {
    const slot = browsers.get(systems[i].id)!
    const tile = computeTileLayout(i, systems.length, screen)
    try {
      const client = await slot.context.newCDPSession(slot.page)
      const { windowId } = await client.send('Browser.getWindowForTarget') as { windowId: number }
      await client.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: tile.position.x,
          top: tile.position.y,
          width: tile.size.width,
          height: tile.size.height,
          windowState: 'normal',
        },
      })
      await client.detach()
    } catch {
      // CDP tiling is best-effort — fall through if unsupported
    }
  }
}
