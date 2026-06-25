import type { Page, Browser, BrowserContext } from 'playwright'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SystemConfig, SessionObserver, CaptureFileOpts } from './types.js'
import { launchBrowser } from '../../infra/browser/launch.js'
import { log } from '../../utils/log.js'
import { classifyPlaywrightError, errorMessage } from '../../utils/errors.js'
import { PATHS } from '../../config.js'
import { idleRefreshCadence } from '../../domain/idle-refresh.js'

/**
 * Per-system idle-refresh runtime state. One entry per system in this
 * Session's `idleStates` map (created for every system in
 * `IDLE_REFRESH_SYSTEMS` ∩ launched systems). See `src/domain/idle-refresh.ts`.
 */
interface IdleRefreshState {
  thresholdMs: number
  tickMs: number
  timer: ReturnType<typeof setInterval> | null
  /** Last `ctx.page(systemId)` / reload — the "automation is active" mark. */
  lastTouchMs: number
  /** Debounce for the observability callback (≤1 emit/sec). */
  lastTouchCbMs: number
  /** Serializes reloads so two ticks never reload the same page concurrently. */
  reloadChain: Promise<void>
  reloadInFlight: boolean
}

/**
 * Per-browser health status surfaced to the dashboard session tiles. Mirrors
 * `BrowserHealthStatus` in `tracker/session-events.ts` (kept as a local literal
 * so the kernel proper doesn't import the tracker layer).
 */
type BrowserHealthStatus = 'healthy' | 'unhealthy' | 'refreshing' | 'failed'

/** Per-system health-monitor bookkeeping, keyed by systemId. */
interface HealthMonitorState {
  /** Last status emitted, so the monitor only emits on transitions (no spam). */
  lastStatus: BrowserHealthStatus
  /** Consecutive auto-refresh attempts since the last `healthy` — bounds the
   * "refresh-only" recovery so a permanently-broken soft fault eventually
   * surfaces as `failed` instead of reloading forever. */
  autoRefreshCount: number
  /** A `refreshSystem` reload is in flight — serializes operator + monitor refreshes. */
  reloadInFlight: boolean
  /** A monitor tick is mid-probe for this system — prevents overlapping ticks. */
  monitorBusy: boolean
}

/** How often the health monitor probes every launched browser (ms). */
const HEALTH_MONITOR_TICK_MS = 30_000
/** Max consecutive auto-refreshes before a soft fault is surfaced as `failed`. */
const HEALTH_MONITOR_MAX_AUTO_REFRESH = 10

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
  screenshotDir?: string
}

export interface LaunchOpts {
  /**
   * Override the inter-submit stagger between consecutive Submit clicks.
   * Defaults to 5000ms. Lowered to a small value in unit tests so the
   * stagger doesn't dominate test wall time. Only meaningful with ≥2 systems.
   */
  staggerMs?: number
  /**
   * Override the post-prepare settle delay — wall-clock pause between every
   * SSO form being filled and the first Submit click. Defaults to 2000ms.
   * Set to 0 in tests to skip. Only meaningful with ≥2 systems.
   */
  settleMs?: number
  /**
   * Max concurrent in-flight Duo submits. Defaults to 1 so the operator's
   * phone never queues more than 1 prompt at a time; additional systems
   * wait until a slot frees. Set to systems.length to disable the cap
   * (every Duo pends in parallel). Only meaningful with ≥2 systems.
   */
  maxConcurrentDuos?: number
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
  /**
   * Abort an in-progress browser launch/authentication chain. Used by
   * daemon stop paths so a Duo wait does not keep the worker alive.
   */
  abortSignal?: AbortSignal
  /**
   * Global idle-refresh cadence override (primarily for tests) — applies to
   * every idle-refresh system this Session launches. When set, both values
   * must be positive.
   */
  idleRefreshOverride?: { thresholdMs: number; tickMs: number }
  /**
   * Health-monitor cadence override (primarily for tests) — `tickMs` is the
   * probe interval; `maxAutoRefreshes` bounds the auto-refresh recovery before
   * a soft fault is surfaced as `failed`.
   */
  healthMonitorOverride?: { tickMs: number; maxAutoRefreshes?: number }
  /**
   * Output directory for `screenshotAll` / `captureAll` PNGs. Stored on the
   * session state and honored over `PATHS.screenshotDir` (and inherited by
   * `forWorker` children). The daemon threads `screenshotsDir(trackerDir)` here
   * when running at an isolated tracker root so audit screenshots land under
   * that root instead of the real `.tracker/`. Unset → `PATHS.screenshotDir`.
   */
  screenshotDir?: string
}

interface LaunchOneOpts {
  system: SystemConfig
}

export class Session {
  private parent: Session | null = null
  /** Per-system idle-refresh state, keyed by system id. Empty until launch. */
  private idleStates = new Map<string, IdleRefreshState>()
  /** When true, skip idle reload (handler is inside a `ctx.step` body). Global across systems. */
  private idleGuard: () => boolean = () => false
  /** Global cadence override (tests). Applies to every idle-refresh system. */
  private idleRefreshOverride?: { thresholdMs: number; tickMs: number }
  /** Set by `Session.launch` — observability for the idle-refresh ring UI. */
  private idleTouchCb?: (systemId: string) => void
  private idleRefreshCb?: (systemId: string, phase: 'start' | 'end') => void
  /** Set by `Session.launch` — per-browser health lifecycle for the session tiles. */
  private healthCb?: (systemId: string, status: BrowserHealthStatus, reason?: string) => void
  /** Per-system health-monitor state, keyed by systemId. */
  private healthStates = new Map<string, HealthMonitorState>()
  /** The health-monitor interval (root session only). */
  private healthTimer: ReturnType<typeof setInterval> | null = null
  /** Health-monitor cadence override (tests). */
  private healthMonitorOverride?: { tickMs: number; maxAutoRefreshes?: number }

  /**
   * True while the auth chain (`Session.launch` → `loginWithRetry` →
   * Duo prompt / queue wait → per-system readiness) is in progress. Guards the
   * idle-refresh timer across the ENTIRE auth window — `idleGuard` (the
   * `ctx.step` body check) is only wired in `makeCtx`, which runs AFTER auth, so
   * without this flag an idle tick could fire `page.reload()` mid-Duo (navigates
   * the prompt away → auth fails; invalidates the armed CDP WebAuthn target).
   * A worker session inherits the parent's window: a `forWorker` child reads
   * `this.parent.authInProgress` so the parent's auth covers the child too.
   */
  private authInProgress = false

  private constructor(private state: SessionState) {}

  /** Test-only factory to construct a Session with pre-built state. */
  static forTesting(state: SessionState): Session {
    return new Session(state)
  }

  /**
   * True when this session OR (for a worker view) its parent is mid-auth. Used
   * by the idle-refresh timer so no reload fires during the auth chain.
   */
  private isAuthInProgress(): boolean {
    return this.authInProgress || (this.parent?.isAuthInProgress() ?? false)
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
    const session = new Session({
      systems: parent.state.systems,
      browsers,
      readyPromises,
      screenshotDir: parent.state.screenshotDir,
    })
    session.parent = parent
    session.idleRefreshOverride = parent.idleRefreshOverride
    session.idleTouchCb = parent.idleTouchCb
    session.idleRefreshCb = parent.idleRefreshCb
    session.healthCb = parent.healthCb
    // The health monitor runs on the ROOT only — the parent owns the browsers
    // and the disconnect listeners; a worker view shares those pages and must
    // not double-monitor them.
    session.startIdleRefreshIfNeeded()
    return session
  }

  static async launch(systems: SystemConfig[], opts: LaunchOpts = {}): Promise<Session> {
    const launchOne = opts.launchFn ?? defaultLaunchOne
    const abortSignal = opts.abortSignal

    // Construct the Session with empty maps first so onReady can wire observers
    // that need a Session reference (e.g. to build a real ScreenshotFn) BEFORE
    // any browser launches or auth begins. The maps are mutated in-place below.
    const browsers = new Map<string, SystemSlot>()
    const readyPromises = new Map<string, Promise<void>>()
    const session = new Session({ systems, browsers, readyPromises, screenshotDir: opts.screenshotDir })
    session.idleTouchCb = (systemId: string): void => {
      opts.observer?.onIdleTouch?.(systemId)
    }
    session.idleRefreshCb = (systemId: string, phase: 'start' | 'end'): void => {
      opts.observer?.onIdleRefresh?.(systemId, phase)
    }
    session.healthCb = (systemId: string, status: BrowserHealthStatus, reason?: string): void => {
      opts.observer?.onBrowserHealth?.(systemId, status, reason)
    }
    session.healthMonitorOverride = opts.healthMonitorOverride
    opts.onReady?.(session)
    throwIfAborted(abortSignal)

    // Launch all browsers in parallel. Windows land wherever Chromium drops
    // them — tiling was removed 2026-04-23 once Playwright's default window
    // placement proved fine for the small (≤4) browser counts we actually use.
    const slots = await raceAbort(Promise.all(
      systems.map((s) => launchOne({ system: s })),
    ), abortSignal)
    systems.forEach((s, i) => browsers.set(s.id, slots[i]))
    throwIfAborted(abortSignal)

    // Fire onBrowserLaunch for each system. browserId === systemId today
    // (one browser per system); if that changes later, mint UUIDs here.
    // `slot.chromiumPid` was captured by `defaultLaunchOne` via pgrep diff
    // so the dashboard's force-stop path can SIGKILL orphaned Chromium when
    // the Node parent dies. Undefined when the diff failed (Windows, etc.).
    for (const s of systems) {
      const slot = browsers.get(s.id)
      opts.observer?.onBrowserLaunch?.(s.id, s.id, slot?.chromiumPid)
    }

    // Surface a HARD browser failure (Chromium process gone / window closed /
    // OS-killed) as a per-browser `failed` health event. A refresh cannot heal
    // a dead process — by operator policy we never relaunch — so this is the
    // terminal "this browser died" signal the session tile shows. Registered
    // here on the root so it fires for every run, independent of whether the
    // daemon also wires its own disconnect→shutdown handler.
    session.onBrowserDisconnect((systemId) => {
      const st = session.ensureHealthState(systemId)
      st.lastStatus = 'failed'
      session.emitHealth(systemId, 'failed', 'browser disconnected')
    })

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
      await raceAbort(Promise.allSettled(
        toPrepare.map(async (s) => {
          const slot = browsers.get(s.id)
          if (!slot) return
          try {
            throwIfAborted(abortSignal)
            await s.prepareLogin!(slot.page)
          } catch (err) {
            if (abortSignal?.aborted) throw abortReason(abortSignal)
            log.warn(`[Session: ${s.id}] prepareLogin failed — login phase will re-prepare: ${errorMessage(err)}`)
          }
        }),
      ), abortSignal)
    }

    // Auth strategy — one shape for every workflow:
    //
    //   • 1 system  → fast path: bringToFront → login → done. No semaphore,
    //     no settle, no stagger. Behaviorally equivalent to the legacy
    //     "sequential" chain when there was only one system to wait on.
    //
    //   • ≥2 systems → parallel-staggered: every SSO form has already been
    //     navigated + filled by the `prepareLogin` phase above. Now click
    //     Submit on each one with three guarantees:
    //       1. SETTLE_MS pause between "all forms filled" and the first
    //          Submit so the operator can look at the phone first.
    //       2. STAGGER_MS gap between consecutive Submit clicks so Duo push
    //          notifications arrive evenly spaced (avoids the multi-prompt
    //          collision documented in src/infra/auth/CLAUDE.md).
    //       3. At most MAX_INFLIGHT Duos pending at once — additional systems
    //          wait until a slot frees on approval, so the operator never
    //          sees more than `maxConcurrentDuos` queued prompts.
    //     Total auth time with N systems is roughly:
    //       ceil(N / MAX_INFLIGHT) × max(single Duo) + (MAX_INFLIGHT - 1) × STAGGER_MS
    //     IIFEs are constructed and registered in `readyPromises`
    //     synchronously, so `Session.launch` returns immediately and per-
    //     system handlers can proceed via `ctx.page(id)` as each Duo clears
    //     (in user-approval order, not click order).
    // Guard the idle-refresh timer across the ENTIRE auth chain (login retries,
    // Duo prompts, the serial Duo queue wait, per-system readiness). The
    // `idleGuard` (ctx.step body check) is only wired post-auth in `makeCtx`, so
    // without this flag an idle tick could fire `page.reload()` mid-Duo and
    // break authentication (see `authInProgress` docs). Set BEFORE the dispatch
    // and reset once every system's readiness settles — for the ≥2-system path
    // that is AFTER `Session.launch` returns, since the IIFEs are not awaited
    // here. The 1-system path resets inline in its own finally.
    if (systems.length === 1) {
      const sys = systems[0]
      const slot = browsers.get(sys.id)!
      if (sys.deferAuth) {
        log.step(`[Auth: ${sys.id}] auth deferred — login handled by workflow step`)
        readyPromises.set(sys.id, Promise.resolve())
      } else {
        session.authInProgress = true
        try {
          throwIfAborted(abortSignal)
          await slot.page.bringToFront()
          opts.observer?.onAuthStart?.(sys.id, sys.id)
          await loginWithRetry(
            sys, slot.page, opts.observer?.instance,
            () => opts.observer?.onAuthFailed?.(sys.id, sys.id),
            abortSignal,
          )
          opts.observer?.onAuthComplete?.(sys.id, sys.id)
          readyPromises.set(sys.id, Promise.resolve())
        } finally {
          session.authInProgress = false
        }
      }
    } else if (systems.length > 1) {
      const STAGGER_MS = opts.staggerMs ?? 5_000
      const SETTLE_MS = opts.settleMs ?? 2_000
      const MAX_INFLIGHT = Math.max(1, opts.maxConcurrentDuos ?? 1)

      // Semaphore: limits in-flight Duos to MAX_INFLIGHT. Slot ownership
      // transfers directly from release → next waiter so we never double-
      // increment, and a microtask race between release and a new acquire
      // can't over-count.
      let inFlight = 0
      const waiters: Array<() => void> = []
      const acquireSlot = async (): Promise<void> => {
        if (inFlight < MAX_INFLIGHT) { inFlight++; return }
        await new Promise<void>((resolve) => waiters.push(resolve))
        // Slot was handed over by the releasing system — don't re-increment.
      }
      const releaseSlot = (): void => {
        const next = waiters.shift()
        if (next) { next(); return }
        inFlight--
      }

      // Auth window opens now — every login IIFE below (and its Duo wait) runs
      // inside it. Reset once they all settle, which happens AFTER
      // `Session.launch` returns (the IIFEs are not awaited here).
      session.authInProgress = true
      const settleEndTs = Date.now() + SETTLE_MS
      let nextEligibleSubmitTs = settleEndTs
      const submitPromises: Promise<void>[] = []
      for (let i = 0; i < systems.length; i++) {
        const sys = systems[i]
        const slot = browsers.get(sys.id)!
        // A deferred system skips the Duo chain entirely — its ready
        // promise resolves immediately without any auth observer events.
        if (sys.deferAuth) {
          log.step(`[Auth: ${sys.id}] auth deferred — login handled by workflow step`)
          readyPromises.set(sys.id, Promise.resolve())
          continue
        }
        const p = (async () => {
          throwIfAborted(abortSignal)
          await acquireSlot()
          try {
            // Reserve a submit slot synchronously before any awaits — this
            // prevents the race where multiple systems wake at the same
            // moment and all read the same stale `lastSubmitTs`. Each
            // system locks in its own submit timestamp atomically; the
            // mySubmitTs computation is `max(now, settleEnd, lastSubmit+stagger)`
            // so settle and stagger are enforced together. After the cap
            // queue (semaphore wait), `now` typically exceeds the prior
            // submit + stagger, so cap-queued systems fire without extra
            // stagger wait once their slot frees.
            const mySubmitTs = Math.max(Date.now(), nextEligibleSubmitTs)
            nextEligibleSubmitTs = mySubmitTs + STAGGER_MS
            const waitFor = mySubmitTs - Date.now()
            if (waitFor > 0) await abortableDelay(waitFor, abortSignal)
            throwIfAborted(abortSignal)
            await slot.page.bringToFront()
            opts.observer?.onAuthStart?.(sys.id, sys.id)
            await loginWithRetry(
              sys, slot.page, opts.observer?.instance,
              () => opts.observer?.onAuthFailed?.(sys.id, sys.id),
              abortSignal,
            )
            opts.observer?.onAuthComplete?.(sys.id, sys.id)
          } finally {
            releaseSlot()
          }
        })()
        // Prevent unhandled-rejection warnings if nobody consumes this
        // promise; per-system handlers consume it via `await ctx.page(id)`,
        // but a workflow that ignores a system would otherwise log noisily.
        p.catch(() => {})
        readyPromises.set(sys.id, p)
        submitPromises.push(p)
      }
      // Don't await all submitPromises here — `Session.launch` resolves
      // once every system has its `readyPromise` registered. Auth failures
      // surface via the observer's `onAuthFailed` (kernel emits a `failed`
      // tracker row attributed to `auth:<systemId>`), not by throwing out
      // of Session.launch. The auth window stays open until they all settle,
      // so the idle timer can't reload mid-Duo even though the timer starts
      // (below) before these resolve.
      void Promise.allSettled(submitPromises).then(() => {
        session.authInProgress = false
      })
    }

    session.applyIdleRefreshOverride(opts.idleRefreshOverride)
    session.startIdleRefreshIfNeeded()
    session.startHealthMonitor()
    return session
  }

  /**
   * Called from `makeCtx` so idle reload never runs while a `ctx.step` body
   * is executing (avoids reload mid-automation). Global across all
   * idle-refresh systems.
   */
  setIdleRefreshGuard(guard: () => boolean): void {
    this.idleGuard = guard
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
    if (this.idleStates.has(id)) this.noteIdleActivity(id)
    return slot.page
  }

  async close(): Promise<void> {
    this.stopIdleRefreshTimers()
    this.stopHealthMonitor()
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
    this.stopIdleRefreshTimers()
    this.stopHealthMonitor()
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
    if (this.idleStates.has(id)) this.noteIdleActivity(id)
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
      // `browser: null` is a worker slot (parent owns lifetime). Guard `.on`
      // too so a stub Browser (tests) can't break the launch wiring that now
      // registers this internally.
      if (!slot.browser || typeof slot.browser.on !== 'function') continue
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

  // ── Per-browser health + operator controls ──────────────────────────────
  //
  // The session-card tiles are bound to a browser by `systemId` (=== browserId
  // today), so every health emit and every control below routes by id — never
  // by tile order. A tile shows the state of ITS browser regardless of where it
  // sits or which sibling failed.

  private ensureHealthState(systemId: string): HealthMonitorState {
    let st = this.healthStates.get(systemId)
    if (!st) {
      st = { lastStatus: 'healthy', autoRefreshCount: 0, reloadInFlight: false, monitorBusy: false }
      this.healthStates.set(systemId, st)
    }
    return st
  }

  /** Emit a per-browser health transition (best-effort; never breaks automation). */
  private emitHealth(systemId: string, status: BrowserHealthStatus, reason?: string): void {
    try {
      this.healthCb?.(systemId, status, reason)
    } catch {
      /* observability must not break automation */
    }
  }

  /**
   * Reload a system's page — the "refresh-only" recovery (operator-triggered
   * from the panel, or auto-triggered by the health monitor). Emits
   * `refreshing` then `healthy`/`unhealthy`/`failed` so the tile reflects the
   * outcome. Serialized per system via `reloadInFlight` so an operator refresh
   * and a monitor tick never reload the same page concurrently. Returns true
   * when the page passed a liveness probe after the reload.
   *
   * A closed/dead page is NOT refreshable (the process is gone) — by operator
   * policy we never relaunch, so it surfaces as `failed`.
   */
  async refreshSystem(id: string): Promise<boolean> {
    const slot = this.state.browsers.get(id)
    if (!slot) return false
    const st = this.ensureHealthState(id)
    if (st.reloadInFlight) return false
    st.reloadInFlight = true
    try {
      let closed = false
      try { closed = slot.page.isClosed() } catch { closed = true }
      if (closed) {
        this.emitHealth(id, 'failed', 'browser page closed')
        st.lastStatus = 'failed'
        return false
      }
      this.emitHealth(id, 'refreshing')
      st.lastStatus = 'refreshing'
      try {
        await slot.page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 })
      } catch (err) {
        log.warn(`[Session: ${id}] refresh reload failed: ${errorMessage(err)}`)
      }
      if (this.idleStates.has(id)) this.noteIdleActivity(id)
      const ok = await this.healthCheck(id)
      if (ok) {
        this.emitHealth(id, 'healthy')
        st.lastStatus = 'healthy'
        st.autoRefreshCount = 0
      } else {
        this.emitHealth(id, 'unhealthy', 'page did not recover after refresh')
        st.lastStatus = 'unhealthy'
      }
      return ok
    } finally {
      st.reloadInFlight = false
    }
  }

  /**
   * Bring a system's Chromium window to the front — the operator's "which
   * browser is this?" control. Routes by systemId, so the right physical window
   * surfaces regardless of tile order.
   */
  async focusSystem(id: string): Promise<void> {
    const slot = this.state.browsers.get(id)
    if (!slot) throw new Error(`no browser for system: ${id}`)
    await slot.page.bringToFront()
  }

  /**
   * Probe a system once and emit its health (operator "check now" + the
   * monitor's per-tick probe). Reports `healthy`/`failed` so a manual check
   * always lands a fresh tile state. Does NOT auto-refresh — that's the
   * monitor's job (and `refreshSystem` for the explicit refresh control).
   */
  async probeSystemHealth(id: string): Promise<boolean> {
    const slot = this.state.browsers.get(id)
    if (!slot) return false
    const st = this.ensureHealthState(id)
    const ok = await this.healthCheck(id)
    if (ok) {
      this.emitHealth(id, 'healthy')
      st.lastStatus = 'healthy'
      st.autoRefreshCount = 0
    } else {
      this.emitHealth(id, 'unhealthy', 'liveness probe failed')
      st.lastStatus = 'unhealthy'
    }
    return ok
  }

  /**
   * Start the per-browser health monitor on the ROOT session. Every `tickMs`
   * it probes each launched browser; a soft (refreshable) fault auto-refreshes
   * up to `maxAutoRefreshes` times before surfacing as `failed`; a healthy
   * probe after a fault emits the recovery. Idempotent; unref'd so it never
   * keeps the process alive.
   */
  private startHealthMonitor(): void {
    if (this.healthTimer) return
    const tickMs = this.healthMonitorOverride?.tickMs ?? HEALTH_MONITOR_TICK_MS
    this.healthTimer = setInterval(() => {
      for (const systemId of this.state.browsers.keys()) {
        void this.tickHealthMonitor(systemId)
      }
    }, tickMs)
    this.healthTimer.unref()
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  /**
   * One health-monitor probe for a system. Skipped while auth is in progress
   * (never probe/reload mid-Duo) or while a `ctx.step` body owns the page
   * (`idleGuard` — the handler's own `gotoWithRetry` covers in-step nav faults).
   * So auto-refresh recovery only fires between steps / when the session is
   * parked — exactly the session-expiry window it's meant for.
   */
  private async tickHealthMonitor(systemId: string): Promise<void> {
    const slot = this.state.browsers.get(systemId)
    if (!slot) return
    if (this.isAuthInProgress()) return
    if (this.idleGuard()) return
    const st = this.ensureHealthState(systemId)
    if (st.monitorBusy || st.reloadInFlight) return
    st.monitorBusy = true
    try {
      let closed = false
      try { closed = slot.page.isClosed() } catch { closed = true }
      if (closed) {
        if (st.lastStatus !== 'failed') this.emitHealth(systemId, 'failed', 'browser page closed')
        st.lastStatus = 'failed'
        return
      }
      const healthy = await this.healthCheck(systemId)
      if (healthy) {
        if (st.lastStatus !== 'healthy') this.emitHealth(systemId, 'healthy')
        st.lastStatus = 'healthy'
        st.autoRefreshCount = 0
        return
      }
      // Soft fault — auto-refresh recovery, bounded. Once exhausted, surface
      // `failed` and stop reloading until it recovers or the operator acts.
      const maxRefreshes = this.healthMonitorOverride?.maxAutoRefreshes ?? HEALTH_MONITOR_MAX_AUTO_REFRESH
      if (st.autoRefreshCount >= maxRefreshes) {
        if (st.lastStatus !== 'failed') this.emitHealth(systemId, 'failed', 'auto-refresh exhausted')
        st.lastStatus = 'failed'
        return
      }
      st.autoRefreshCount++
      // refreshSystem emits `refreshing` → `healthy`/`unhealthy` and updates lastStatus.
      await this.refreshSystem(systemId)
    } catch {
      /* best-effort — a monitor failure must never break the run */
    } finally {
      st.monitorBusy = false
    }
  }

  async killChrome(): Promise<void> {
    // SIGINT teardown — force-close all browsers without awaiting graceful shutdown.
    for (const slot of this.state.browsers.values()) {
      try { await slot.browser?.close() } catch { /* ignore */ }
    }
  }

  /**
   * THE unified "whole page / whole form" audit capture — one `fullPage` PNG
   * that contains the ENTIRE page or form, never a clipped portion. Every
   * `ctx.screenshot()` routes here (no per-caller mode soup). It composes the
   * three transforms an enterprise HR page needs before a `fullPage` shot can
   * see all of its content, each best-effort + reversible:
   *
   *   1. `expandScrollContainers` — strip `overflow:auto/scroll` + `max-height`
   *      caps off inner scroll containers (the Kuali finalization dialog is a
   *      fixed `max-height` + `overflow:auto` modal; `fullPage` alone only grows
   *      the DOCUMENT height, not these inner divs).
   *   2. `widenViewportForCapture` — `fullPage` grows HEIGHT but clamps WIDTH to
   *      the viewport, so wide content (the PeopleSoft Person Org assignment
   *      grid, ~1600-2200px) clips on the right in a narrow tiled window. Widen
   *      the layout viewport to fit the widest content (top document AND inside
   *      child frames — the grid lives in a fluid-width iframe), so the whole
   *      grid is in frame. Done BEFORE the iframe grow so the in-frame content
   *      reflows to its final width first.
   *   3. `growOverflowingIframes` — the UCPath PeopleSoft content frame
   *      (`#main_target_win0`) is a fixed `height:520px` same-origin iframe with
   *      its OWN scroll, so a tall in-frame form (the submitted-transaction
   *      confirmation) clips at the iframe's fold even under `fullPage`. Grow the
   *      iframe ELEMENT to its inner `scrollHeight` so the shot walks through the
   *      whole in-frame form. (This is what the retired `region` mode did by
   *      hand for one selector; folding it into the default makes every page get
   *      it for free.)
   *
   * All three restore the original inline styles / viewport in the `finally`.
   * Restoration is best-effort; a late-failing restore still leaves the DOM
   * visually consistent because we reset to whatever was inline before. The
   * mutation window is short (settle waits) — fine for form-audit shots taken
   * between discrete Playwright actions, not during active typing.
   */
  static async captureFullPage(page: Page, path: string): Promise<Buffer> {
    let restoreFn: (() => Promise<void>) | null = null
    let restoreViewport: (() => Promise<void>) | null = null
    let restoreIframes: (() => Promise<void>) | null = null
    try {
      restoreFn = await Session.expandScrollContainers(page)
      const maybeWaitForLoadState = page as unknown as {
        waitForLoadState?: (state: 'networkidle', options: { timeout: number }) => Promise<void>
      }
      await maybeWaitForLoadState.waitForLoadState?.('networkidle', { timeout: 1_000 }).catch(() => {})
      restoreViewport = await Session.widenViewportForCapture(page)
      // Grow fixed-height same-origin iframes AFTER widening, so each frame's
      // inner `scrollHeight` is measured at its final reflowed width. Without
      // this the UCPath content frame clips a tall in-frame form at its 520px
      // fold even though `fullPage` is set on the OUTER document.
      restoreIframes = await Session.growOverflowingIframes(page)
      const buf = await page.screenshot({ path, fullPage: true })
      return buf
    } finally {
      if (restoreIframes) await restoreIframes()
      if (restoreViewport) await restoreViewport()
      if (restoreFn) await restoreFn()
    }
  }

  /**
   * Temporarily widen the page viewport so a `fullPage` screenshot captures
   * horizontally-overflowing content (wide PeopleSoft grids) instead of
   * clipping it. Returns a restore callback (no-op when no widening was needed
   * or the page can't be resized). Best-effort — never throws.
   */
  private static async widenViewportForCapture(page: Page): Promise<(() => Promise<void>) | null> {
    const maybeResize = page as unknown as {
      setViewportSize?: (size: { width: number; height: number }) => Promise<void>
      waitForTimeout?: (ms: number) => Promise<void>
      frames?: () => Array<{ evaluate: (fn: () => number) => Promise<number> }>
    }
    if (typeof maybeResize.setViewportSize !== 'function') return null

    try {
      const metrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth || 0,
        innerHeight: window.innerHeight || 0,
        docWidth: Math.max(
          document.documentElement?.scrollWidth ?? 0,
          document.body?.scrollWidth ?? 0,
        ),
      })).catch(() => null)
      if (!metrics || metrics.innerWidth <= 0 || metrics.innerHeight <= 0) return null

      // The PeopleSoft assignment grid lives in a content iframe; the top
      // document width often doesn't reflect it, so probe each frame too.
      let widest = Math.max(metrics.docWidth, metrics.innerWidth)
      try {
        for (const fr of maybeResize.frames?.() ?? []) {
          const w = await fr.evaluate(() => Math.max(
            document.documentElement?.scrollWidth ?? 0,
            document.body?.scrollWidth ?? 0,
          )).catch(() => 0)
          if (typeof w === 'number') widest = Math.max(widest, w)
        }
      } catch { /* best-effort — frame probing is optional */ }

      // Only widen when content actually overflows; cap to avoid runaway sizes.
      if (widest <= metrics.innerWidth + 2) return null
      const target = Math.min(widest + 24, 6_000)

      await maybeResize.setViewportSize({ width: target, height: metrics.innerHeight })
      await maybeResize.waitForTimeout?.(200).catch(() => {})
      return async () => {
        try {
          await maybeResize.setViewportSize!({
            width: metrics.innerWidth,
            height: metrics.innerHeight,
          })
        } catch { /* best-effort */ }
      }
    } catch {
      return null
    }
  }

  /**
   * Grow every SAME-ORIGIN iframe whose inner content overflows its rendered
   * box to its full inner content height — RECURSIVELY through nested frames —
   * and return a best-effort restore callback. A fixed-height iframe (the UCPath
   * PeopleSoft content frame `#main_target_win0` is `height:520px` with its own
   * scroll) clips a tall form: reaching INTO the frame with
   * `frameLocator(...).screenshot()` still captures only the visible fold, and a
   * plain `fullPage` on the OUTER document stops at the iframe's rendered height.
   * Growing the iframe ELEMENT to its inner `scrollHeight` (after stripping the
   * inner document's overflow caps) makes a subsequent `fullPage` include the
   * entire in-frame form.
   *
   * PeopleSoft nests its content frame inside an outer frame, so a top-level-only
   * walk never reaches it. We recurse POST-ORDER: grow a frame's OWN nested
   * iframes first, so when we measure this frame's inner `scrollHeight` it already
   * reflects its grown descendants, then grow this frame to fit. Cross-origin
   * frames throw on `contentDocument` access and are skipped (best-effort).
   * Verified against synthetic single- and nested-iframe UCPath pages.
   */
  private static async growOverflowingIframes(page: Page): Promise<() => Promise<void>> {
    await page.evaluate(() => {
      const saved: Array<{ el: HTMLIFrameElement; height: string; innerCss: Array<[HTMLElement, string]> }> = []
      // Collect every same-origin (iframe element → its document) pair tagged with
      // nesting depth, breadth-first. NOTE: this is an ITERATIVE traversal on
      // purpose — a NAMED nested function/arrow inside `page.evaluate` trips the
      // esbuild/tsx `__name` helper (undefined in the browser → the whole evaluate
      // throws and is swallowed by the `.catch` below, silently growing nothing).
      const MAX_FRAME_DEPTH = 6 // runaway guard for pathological frame nesting
      const collected: Array<{ el: HTMLIFrameElement; doc: Document; depth: number }> = []
      const queue: Array<{ doc: Document; depth: number }> = [{ doc: document, depth: 0 }]
      while (queue.length) {
        const node = queue.shift()!
        if (node.depth > MAX_FRAME_DEPTH) continue
        for (const el of Array.from(node.doc.querySelectorAll('iframe'))) {
          try {
            const childDoc = el.contentDocument
            if (!childDoc || !childDoc.documentElement) continue // cross-origin or not loaded
            collected.push({ el, doc: childDoc, depth: node.depth + 1 })
            queue.push({ doc: childDoc, depth: node.depth + 1 })
          } catch { /* cross-origin iframe — skip */ }
        }
      }
      // Grow DEEPEST frames first, so when a parent frame is measured its inner
      // `scrollHeight` already reflects its grown children (the PeopleSoft content
      // frame is nested inside an outer frame).
      collected.sort((a, b) => b.depth - a.depth)
      for (const { el, doc } of collected) {
        try {
          // Strip inner-scroll overflow caps so scrollHeight reflects full content.
          // Detect by COMPUTED style across all elements (a stylesheet rule, not
          // just inline `style=`/class names, can set the cap).
          const innerCss: Array<[HTMLElement, string]> = []
          const view = doc.defaultView
          for (const inner of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
            const cs = view ? view.getComputedStyle(inner) : null
            if (!cs) continue
            const scrolls =
              (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
              inner.scrollHeight > inner.clientHeight + 2
            const capped = cs.maxHeight !== 'none' && parseFloat(cs.maxHeight) > 0 &&
              inner.scrollHeight > inner.clientHeight + 2
            if (!scrolls && !capped) continue
            innerCss.push([inner, inner.style.cssText])
            inner.style.overflow = 'visible'; inner.style.maxHeight = 'none'; inner.style.height = 'auto'
          }
          if (view) view.scrollTo(0, 0)
          const innerH = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0)
          const rendered = el.getBoundingClientRect().height
          if (innerH > rendered + 2) {
            saved.push({ el, height: el.style.height, innerCss })
            el.style.height = `${innerH}px`
          } else if (innerCss.length) {
            saved.push({ el, height: el.style.height, innerCss })
          }
        } catch { /* per-frame best-effort */ }
      }
      ;(window as unknown as { __restoreIframes?: () => void }).__restoreIframes = () => {
        for (const s of saved) {
          s.el.style.height = s.height
          for (const [inner, css] of s.innerCss) inner.style.cssText = css
        }
        delete (window as unknown as { __restoreIframes?: () => void }).__restoreIframes
      }
    }).catch(() => {})
    return async () => {
      try {
        await page.evaluate(() => {
          const w = window as unknown as { __restoreIframes?: () => void }
          w.__restoreIframes?.()
        })
      } catch { /* best-effort */ }
    }
  }

  /**
   * Capture the VIEWPORT (NOT `fullPage`) after scrolling `selector`'s element to
   * the vertical CENTER of the view (`scrollIntoView({ block: 'center' })`). This
   * is the capture for virtual-scroll grids (Old / New Kronos timecards), where
   * `fullPage` would only render the rows currently in the DOM — the off-screen
   * rows of a virtual grid never make it into a `fullPage` shot. By scrolling the
   * latest-worked-date row to center and shooting only what's painted, the audit
   * image shows that date centered with surrounding rows for context.
   *
   * Best-effort: a missing selector still captures whatever is shown (so a
   * scroll-target miss never loses the screenshot). Returns the written path, or
   * null on a screenshot failure.
   */
  static async captureViewportCenteredOnElement(
    page: Page,
    selector: string,
    path: string,
  ): Promise<string | null> {
    try {
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        if (el) (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'auto' })
      }, selector).catch(() => {})
      const maybeWait = page as unknown as { waitForTimeout?: (ms: number) => Promise<void> }
      await maybeWait.waitForTimeout?.(400).catch(() => {})
    } catch {
      // best-effort scroll — capture whatever is shown regardless
    }
    try {
      // Deliberately NOT fullPage — virtual-scroll grids only render visible rows.
      await page.screenshot({ path })
      return path
    } catch {
      return null
    }
  }

  /**
   * Strip `overflow`/`max-height`/`height` caps from every scrollable inner
   * container (Kuali modals, PeopleSoft frames) so a subsequent `fullPage`
   * capture sees the full content height, and return a best-effort restore
   * callback. Used by the unified `captureFullPage`. See its doc comment for why
   * each cap is neutralized.
   */
  private static async expandScrollContainers(page: Page): Promise<() => Promise<void>> {
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
      // Detect scroll containers by COMPUTED style across EVERY element, not by
      // a name-based selector. The Kuali finalization dialog sets `overflow:auto`
      // + `max-height` via a STYLESHEET rule on a `class="dialog"` element — a
      // `[style*=overflow], .modal, [class*=scroll]` selector never matches it,
      // so the old pre-filter silently skipped it and the modal clipped at its
      // max-height fold. Two passes (read-only detect, then mutate) so reading
      // `scrollHeight` isn't interleaved with style writes — that would force a
      // reflow per element and make an all-element scan O(n²). A hard cap keeps
      // a pathological DOM (the 30k-px CRM record) from stalling the audit shot.
      const ELEMENT_SCAN_CAP = 25_000
      const all = document.querySelectorAll<HTMLElement>('*')
      const toExpand: HTMLElement[] = []
      const scanLimit = Math.min(all.length, ELEMENT_SCAN_CAP)
      for (let i = 0; i < scanLimit; i++) {
        const el = all[i]
        const s = getComputedStyle(el)
        const scrolls =
          (s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowX === 'auto' || s.overflowX === 'scroll') &&
          (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2)
        const constrained =
          s.maxHeight !== 'none' &&
          parseFloat(s.maxHeight) > 0 &&
          el.scrollHeight > el.clientHeight + 2
        if (scrolls || constrained) toExpand.push(el)
      }
      for (const el of toExpand) {
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
        el.style.minHeight = '0'
      }
      window.scrollTo(0, 0)
      void document.body.offsetHeight
      // A `position:fixed`/`absolute` container (the Kuali finalization dialog is
      // a fixed, centered modal) is OUT of document flow, so growing it does NOT
      // grow `document.scrollHeight`. A `fullPage` shot is sized to scrollHeight,
      // so a modal whose EXPANDED content runs taller than the page behind it
      // (a long Kuali form over the short Action List) clips at the bottom. Bump
      // `body` min-height to cover the tallest expanded out-of-flow container so
      // fullPage's measured height includes all of it. Re-read scrollHeight AFTER
      // the offsetHeight reflow above so the comparison is against final layout.
      const prevBodyMinHeight = document.body.style.minHeight
      let maxBottom = 0
      for (const el of toExpand) {
        const pos = getComputedStyle(el).position
        if (pos !== 'fixed' && pos !== 'absolute') continue
        const r = el.getBoundingClientRect()
        const bottom = r.top + window.scrollY + el.scrollHeight
        if (bottom > maxBottom) maxBottom = bottom
      }
      const docHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
      if (maxBottom > docHeight) {
        document.body.style.minHeight = `${Math.ceil(maxBottom)}px`
        void document.body.offsetHeight
      }
      ;(window as unknown as { __restoreScrollContainers?: () => void }).__restoreScrollContainers = () => {
        for (const r of saved) {
          r.el.style.overflow = r.overflow
          r.el.style.overflowX = r.overflowX
          r.el.style.overflowY = r.overflowY
          r.el.style.maxHeight = r.maxHeight
          r.el.style.height = r.height
          r.el.style.minHeight = r.minHeight
        }
        document.body.style.minHeight = prevBodyMinHeight
        delete (window as unknown as { __restoreScrollContainers?: () => void }).__restoreScrollContainers
      }
    })
    return async () => {
      try {
        await page.evaluate(() => {
          const w = window as unknown as { __restoreScrollContainers?: () => void }
          w.__restoreScrollContainers?.()
        })
      } catch { /* best-effort */ }
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
    const outDir = this.state.screenshotDir ?? PATHS.screenshotDir
    try {
      await fs.mkdir(outDir, { recursive: true })
    } catch { /* best-effort */ }
    for (const [id, slot] of this.state.browsers.entries()) {
      try {
        if (slot.page.isClosed()) continue
      } catch { continue }
      const path = join(outDir, `${prefix}-${id}-${Date.now()}.png`)
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
   * for each file successfully written (ONE file per targeted page).
   *
   * There is ONE capture mode for every workflow: the unified whole-page/form
   * `captureFullPage` shot (expand inner-scroll containers + grow fixed-height
   * iframes + content-fit widen + one `fullPage`), so the ENTIRE page or form is
   * in frame, never a clipped portion. The lone exception is `opts.centerSelector`
   * — a VIEWPORT shot centered on an element, for VIRTUAL-SCROLL grids (the Kronos
   * timecard) whose off-screen rows aren't in the DOM and so can't be reached by
   * any full-page shot.
   */
  async captureAll(opts: CaptureFileOpts): Promise<Array<{ system: string; path: string; bytes: number }>> {
    const outDir = this.state.screenshotDir ?? PATHS.screenshotDir
    try {
      await fs.mkdir(outDir, { recursive: true })
    } catch { /* best-effort */ }
    const wanted = new Set(opts.systems ?? Array.from(this.state.browsers.keys()))
    const results: Array<{ system: string; path: string; bytes: number }> = []
    for (const [id, slot] of this.state.browsers.entries()) {
      if (!wanted.has(id)) continue
      results.push(...await this.captureOnePage(outDir, opts, id, slot.page))
    }
    for (const pg of opts.pages ?? []) {
      results.push(...await this.captureOnePage(outDir, opts, 'ad-hoc', pg))
    }
    return results
  }

  /**
   * Capture one page in the mode requested by `opts`, returning a metadata
   * entry for the single file written. Best-effort — any failure returns the
   * files captured so far without throwing, so one page can never skip its
   * siblings in `captureAll`.
   */
  private async captureOnePage(
    outDir: string,
    opts: CaptureFileOpts,
    system: string,
    page: Page,
  ): Promise<Array<{ system: string; path: string; bytes: number }>> {
    const out: Array<{ system: string; path: string; bytes: number }> = []
    const fileMeta = async (p: string): Promise<void> => {
      try {
        const stat = await fs.stat(p)
        out.push({ system, path: p, bytes: stat.size })
      } catch {
        // file wasn't written — skip its metadata entry
      }
    }
    const p = join(outDir, formatCaptureFilename({
      workflow: opts.workflow, itemId: opts.itemId, kind: opts.kind,
      label: opts.label, system, ts: opts.ts,
    }))
    try {
      if (opts.centerSelector) {
        // The ONE exception to the unified whole-page capture: a VIRTUAL-SCROLL
        // grid (the Kronos timecard) renders only the rows currently in the DOM,
        // so a `fullPage` shot can't reach off-screen rows no matter how we
        // expand — physically centering the target row and shooting the VIEWPORT
        // is the only faithful "everything on screen" capture for it.
        const written = await Session.captureViewportCenteredOnElement(page, opts.centerSelector, p)
        if (written) await fileMeta(written)
        return out
      }
      // The unified capture for EVERY other page: one fullPage shot that expands
      // inner-scroll containers, grows fixed-height iframes, and content-fit
      // widens so the ENTIRE page or form is in frame, never a clipped portion.
      const buf = await Session.captureFullPage(page, p)
      out.push({ system, path: p, bytes: buf.byteLength })
      return out
    } catch {
      // Best-effort — per-page failures don't block siblings.
      return out
    }
  }

  private applyIdleRefreshOverride(override?: { thresholdMs: number; tickMs: number }): void {
    if (override && override.thresholdMs > 0 && override.tickMs > 0) {
      this.idleRefreshOverride = override
    }
  }

  private noteIdleActivity(systemId: string): void {
    const st = this.idleStates.get(systemId)
    if (!st) return
    const now = Date.now()
    st.lastTouchMs = now
    // Debounce the observability callback: idle-refresh systems are page-heavy
    // (UCPath calls `ctx.page("ucpath")` many times per item), and each call
    // writes a session event via `appendFileSync`. The dashboard idle countdown
    // only needs ~1s granularity, so suppress sub-second emits.
    if (now - st.lastTouchCbMs < 1000) return
    st.lastTouchCbMs = now
    try {
      this.idleTouchCb?.(systemId)
    } catch {
      /* observability must not break automation */
    }
  }

  /**
   * Start a per-system idle-refresh timer for every launched system that opts
   * in via `IDLE_REFRESH_SYSTEMS` (and isn't already running). Idempotent.
   */
  private startIdleRefreshIfNeeded(): void {
    for (const sys of this.state.systems) {
      const cadence = idleRefreshCadence(sys.id)
      if (!cadence) continue
      if (this.idleStates.has(sys.id)) continue
      const thresholdMs = this.idleRefreshOverride?.thresholdMs ?? cadence.thresholdMs
      const tickMs = this.idleRefreshOverride?.tickMs ?? cadence.tickMs
      const st: IdleRefreshState = {
        thresholdMs,
        tickMs,
        timer: null,
        lastTouchMs: Date.now(),
        lastTouchCbMs: 0,
        reloadChain: Promise.resolve(),
        reloadInFlight: false,
      }
      st.timer = setInterval(() => {
        this.tickIdleRefresh(sys.id)
      }, tickMs)
      st.timer.unref()
      this.idleStates.set(sys.id, st)
    }
  }

  private stopIdleRefreshTimers(): void {
    for (const st of this.idleStates.values()) {
      if (st.timer) {
        clearInterval(st.timer)
        st.timer = null
      }
    }
  }

  private tickIdleRefresh(systemId: string): void {
    try {
      const st = this.idleStates.get(systemId)
      if (!st) return
      if (this.isAuthInProgress()) return
      if (this.idleGuard()) return
      if (st.reloadInFlight) return
      const slot = this.state.browsers.get(systemId)
      if (!slot) return
      try {
        if (slot.page.isClosed()) return
      } catch {
        return
      }
      if (Date.now() - st.lastTouchMs < st.thresholdMs) return
      st.reloadInFlight = true
      void this.scheduleIdleReload(systemId)
    } catch {
      /* best-effort */
    }
  }

  private scheduleIdleReload(systemId: string): void {
    const st = this.idleStates.get(systemId)
    if (!st) return
    st.reloadChain = st.reloadChain.then(async () => {
      let recordActivity = false
      let refreshCbFired = false
      try {
        const slot = this.state.browsers.get(systemId)
        if (!slot) return
        try {
          if (slot.page.isClosed()) return
        } catch {
          return
        }
        if (this.isAuthInProgress()) return
        if (this.idleGuard()) return
        if (Date.now() - st.lastTouchMs < st.thresholdMs) return
        log.step(`[Session: ${systemId}] Idle refresh — reloading page after automation idle`)
        try {
          this.idleRefreshCb?.(systemId, 'start')
          refreshCbFired = true
        } catch {
          /* ignore */
        }
        try {
          await slot.page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 })
        } catch (err) {
          log.warn(`[Session: ${systemId}] Idle refresh reload failed: ${errorMessage(err)}`)
        }
        recordActivity = true
      } finally {
        st.reloadInFlight = false
        if (refreshCbFired) {
          try {
            this.idleRefreshCb?.(systemId, 'end')
          } catch {
            /* ignore */
          }
        }
        if (recordActivity) st.lastTouchMs = Date.now()
      }
    }).catch(() => {
      st.reloadInFlight = false
    })
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

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(reason ? String(reason) : 'operation aborted')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal)
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err) => {
        cleanup()
        reject(err)
      },
    )
  })
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal })
  } catch (err) {
    // node:timers/promises throws AbortError with the signal's reason
    // attached as `cause`. Surface our codebase's abortReason() shape so
    // existing callers see the same Error instance shape they got before.
    if (signal?.aborted) throw abortReason(signal)
    throw err
  }
}

async function loginWithRetry(
  system: SystemConfig,
  page: Page,
  instance?: string,
  onFailed?: () => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  let lastError: string | undefined
  for (let attempt = 1; attempt <= AUTH_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(abortSignal)
    if (attempt > 1) {
      log.warn(`[Auth: ${system.id}] Retrying (attempt ${attempt}/${AUTH_MAX_ATTEMPTS}) — previous error: ${lastError ?? '<none>'}`)
    } else {
      log.step(`[Auth: ${system.id}] Starting login (attempt ${attempt}/${AUTH_MAX_ATTEMPTS})`)
    }
    try {
      if (!system.login) {
        // loginWithRetry should never be called for a deferAuth system — the
        // caller (Session.launch) skips this function when sys.deferAuth is set.
        // A missing login on a non-deferred system is a programming error.
        throw new Error(`[Auth: ${system.id}] login function is undefined (programming error — system must declare login or set deferAuth)`)
      }
      await raceAbort(system.login(page, instance, { abortSignal }), abortSignal)
      if (attempt > 1) {
        log.success(`[Auth: ${system.id}] Recovered on attempt ${attempt}`)
      }
      return
    } catch (err) {
      if (abortSignal?.aborted) throw abortReason(abortSignal)
      lastError = errorMessage(err)
      if (attempt < AUTH_MAX_ATTEMPTS) {
        await raceAbort(page.goto('about:blank'), abortSignal).catch((gotoErr) => {
          if (abortSignal?.aborted) throw abortReason(abortSignal)
          log.warn(`[Auth: ${system.id}] reset to about:blank failed before retry: ${errorMessage(gotoErr)}`)
        })
        await abortableDelay(1_000, abortSignal)
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
