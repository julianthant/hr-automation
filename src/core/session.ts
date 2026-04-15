import type { Page, Browser, BrowserContext } from 'playwright'
import type { SystemConfig } from './types.js'
import { launchBrowser } from '../browser/launch.js'

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

    const readyPromises = new Map<string, Promise<void>>()

    if (authChain === 'sequential') {
      for (const s of systems) {
        const slot = browsers.get(s.id)!
        await s.login(slot.page)
      }
      systems.forEach((s) => readyPromises.set(s.id, Promise.resolve()))
    } else {
      // Interleaved: auth system[0] blocking; chain the rest in background.
      const firstSlot = browsers.get(systems[0].id)!
      await systems[0].login(firstSlot.page)
      readyPromises.set(systems[0].id, Promise.resolve())

      let prev: Promise<void> = Promise.resolve()
      for (let i = 1; i < systems.length; i++) {
        const sys = systems[i]
        const slot = browsers.get(sys.id)!
        // Each chain step ignores predecessor failure so one bad auth doesn't block the next.
        const p = prev.catch(() => {}).then(() => sys.login(slot.page))
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
}

async function defaultLaunchOne(opts: LaunchOneOpts): Promise<SystemSlot> {
  const { browser, context, page } = await launchBrowser({ sessionDir: opts.system.sessionDir })
  return { page, context, browser }
}
