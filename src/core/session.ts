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
}
