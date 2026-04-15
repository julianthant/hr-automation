import type { Page, Browser, BrowserContext } from 'playwright'
import type { SystemConfig } from './types.js'

interface SystemSlot {
  page: Page
  browser: Browser
  context: BrowserContext
}

interface SessionState {
  systems: SystemConfig[]
  browsers: Map<string, SystemSlot>
  readyPromises: Map<string, Promise<void>>
}

export class Session {
  private constructor(private state: SessionState) {}

  /** Test-only factory to construct a Session with pre-built state. */
  static forTesting(state: SessionState): Session {
    return new Session(state)
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
}
