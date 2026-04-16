import type { Page, Browser, BrowserContext } from 'playwright'
import type { SystemConfig } from './types.js'
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
        await loginWithRetry(s, slot.page)
      }
      systems.forEach((s) => readyPromises.set(s.id, Promise.resolve()))
    } else {
      // Interleaved: auth system[0] blocking; chain the rest in background.
      const firstSlot = browsers.get(systems[0].id)!
      await firstSlot.page.bringToFront()
      await loginWithRetry(systems[0], firstSlot.page)
      readyPromises.set(systems[0].id, Promise.resolve())

      let prev: Promise<void> = Promise.resolve()
      for (let i = 1; i < systems.length; i++) {
        const sys = systems[i]
        const slot = browsers.get(sys.id)!
        // Each chain step ignores predecessor failure so one bad auth doesn't block the next.
        const p = prev.catch(() => {}).then(() => slot.page.bringToFront()).then(() => loginWithRetry(sys, slot.page))
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

  async healthCheck(id: string): Promise<boolean> {
    const slot = this.state.browsers.get(id)
    if (!slot) return false
    try {
      if (slot.page.isClosed()) return false
      return true
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
}

async function defaultLaunchOne(opts: LaunchOneOpts): Promise<SystemSlot> {
  const { browser, context, page } = await launchBrowser({
    sessionDir: opts.system.sessionDir,
  })
  return { page, context, browser }
}

const AUTH_MAX_ATTEMPTS = 3;

async function loginWithRetry(system: SystemConfig, page: Page): Promise<void> {
  for (let attempt = 1; attempt <= AUTH_MAX_ATTEMPTS; attempt++) {
    try {
      await system.login(page)
      return
    } catch (err) {
      if (attempt < AUTH_MAX_ATTEMPTS) {
        log.step(`Auth failed for ${system.id} (attempt ${attempt}/${AUTH_MAX_ATTEMPTS}) — refreshing and retrying...`)
        await page.goto('about:blank').catch(() => {})
        await page.waitForTimeout(1_000)
      } else {
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
