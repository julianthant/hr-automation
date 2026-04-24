import type { Page, Browser, BrowserContext } from 'playwright'
import { promises as fs } from 'node:fs'
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
}

interface SessionState {
  systems: SystemConfig[]
  browsers: Map<string, SystemSlot>
  readyPromises: Map<string, Promise<void>>
}

export interface LaunchOpts {
  authChain?: 'sequential' | 'interleaved'
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
    for (const s of systems) {
      opts.observer?.onBrowserLaunch?.(s.id, s.id)
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
        // `fullPage: true` — capture the entire scrollable page, not just
        // the viewport. Kuali + UCPath forms are long; a viewport-only shot
        // clips off Final Transactions, comments, and the save button area.
        await slot.page.screenshot({ path, fullPage: true })
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
        // `fullPage: true` — capture the whole scrollable page, not just
        // the viewport, so the operator can see the full Kuali / UCPath
        // form (Final Transactions + comments + Save button) without
        // opening the browser.
        const buf = await slot.page.screenshot({ path: p, fullPage: true })
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
        const buf = await pg.screenshot({ path: p, fullPage: true })
        results.push({ system: 'ad-hoc', path: p, bytes: buf.byteLength })
      } catch {
        // Best-effort
      }
    }
    return results
  }
}

async function defaultLaunchOne(opts: LaunchOneOpts): Promise<SystemSlot> {
  const systemId = opts.system.id
  const sessionDir = opts.system.sessionDir
  try {
    const { browser, context, page } = await launchBrowser({
      sessionDir,
    })
    return { page, context, browser }
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
