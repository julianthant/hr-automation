import type { Page, Browser, BrowserContext } from 'playwright'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SystemConfig, SessionObserver, CaptureFileOpts } from './types.js'
import { launchBrowser } from '../../infra/browser/launch.js'
import { log } from '../../utils/log.js'
import { numEnv } from '../../utils/env.js'
import { classifyPlaywrightError, errorMessage } from '../../utils/errors.js'
import { PATHS } from '../../config.js'
import { idleRefreshCadence } from '../../domain/idle-refresh.js'
import { classifyBrowserHealth, isLoginLikeUrl, type BrowserHealthVerdict } from '../../domain/browser-health.js'
import {
  stitchCaptureBands,
  estimateStitchedPixels,
  shouldStitchComposite,
  MAX_STITCH_PIXELS,
  type CaptureBand,
} from './capture-stitch.js'

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
  /** Consecutive Refresh attempts since the last `healthy` — first rung of the
   * recovery ladder (refresh → reopen → surface). */
  autoRefreshCount: number
  /** Consecutive Reopen attempts since the last `healthy` — second rung. */
  reopenCount: number
  /** A `refreshSystem`/`reopenSystem` page mutation is in flight — serializes
   * operator + monitor recoveries against each other. */
  reloadInFlight: boolean
  /** A monitor tick is mid-probe for this system — prevents overlapping ticks. */
  monitorBusy: boolean
}

// These three are operator-tunable via Settings → "Browser health" (the settings
// store populates the env var only for an explicitly-set field; unset = the
// literal default below, so an unconfigured install is unchanged).
/** How often the health monitor probes every launched browser (ms). */
const HEALTH_MONITOR_TICK_MS = numEnv('HRAUTO_HEALTH_MONITOR_TICK_MS', 30_000)
/** Max consecutive Refresh attempts (rung 1) before escalating to Reopen. */
const HEALTH_MONITOR_MAX_AUTO_REFRESH = numEnv('HRAUTO_HEALTH_MONITOR_MAX_REFRESH', 10)
/** Max consecutive Reopen attempts (rung 2) before surfacing `failed`. */
const HEALTH_MONITOR_MAX_REOPEN = numEnv('HRAUTO_HEALTH_MONITOR_MAX_REOPEN', 3)

export function formatCaptureFilename(args: {
  workflow: string
  itemId: string
  kind: 'form' | 'error' | 'manual' | 'step'
  label: string
  system: string
  ts: number
  /**
   * Zero-based page-slice index for a TALL capture split into readable pages.
   * When present, a 1-based zero-padded `-cNN` suffix is appended so the N slices
   * of one page don't collide on the shared `ts`+`system` and sort top-to-bottom
   * lexically. Omitted for a page captured as a single image (short pages).
   */
  chunk?: number
}): string {
  const chunkSuffix =
    args.chunk !== undefined ? `-c${String(args.chunk + 1).padStart(2, '0')}` : ''
  return `${args.workflow}-${args.itemId}-${args.kind}-${args.label}-${args.system}-${args.ts}${chunkSuffix}.png`
}

/**
 * Centralized audit-capture geometry — one source of truth for "what every
 * screenshot looks like." The unified capture pins width to a fixed readable
 * column (so a form captures the same width regardless of the tiled daemon
 * window) and splits a TALL page into page-height slices the operator steps
 * through, instead of one tiny unreadable long image.
 */
// Operator-tunable via Settings → "Audit capture" (env vars populated only for
// explicitly-set fields; unset = the literal defaults below, so the capture is
// byte-identical on an unconfigured install).
export const CAPTURE = {
  /**
   * Fixed MINIMUM layout-viewport WIDTH for every capture. A narrow/normal form
   * renders at this readable column width even on a quarter-tiled daemon window
   * (`setViewportSize` sets the LAYOUT viewport independently of the OS window).
   * Wide content (PeopleSoft grids) widens BEYOND this; it is a floor, not a cap.
   */
  width: numEnv('HRAUTO_CAPTURE_WIDTH', 1280),
  /** Hard cap on widening for pathologically wide content (runaway guard). */
  maxWidth: numEnv('HRAUTO_CAPTURE_MAX_WIDTH', 6000),
  /**
   * Height of each page slice when a tall capture is split. ~one comfortable
   * screenful so a slice reads near 1:1 in the dashboard lightbox instead of a
   * shrunk-to-fit ribbon.
   */
  sliceHeight: numEnv('HRAUTO_CAPTURE_SLICE_HEIGHT', 1200),
  /**
   * Vertical OVERLAP (px) between consecutive slices, so content sitting on a
   * slice boundary stays fully readable in at least one slice. Must be < sliceHeight.
   */
  sliceOverlap: numEnv('HRAUTO_CAPTURE_SLICE_OVERLAP', 120),
  /** Hard cap on slices per page — runaway guard for pathologically tall docs. */
  maxSlices: numEnv('HRAUTO_CAPTURE_MAX_SLICES', 30),
} as const

/**
 * Pure: the top Y offset of each page slice for a page `fullHeight` px tall,
 * given a slice height + overlap seam. Returns `[0]` (one slice = the whole
 * page) when the page fits one slice; otherwise top→bottom offsets, each clamped
 * to `fullHeight - sliceHeight` so the last slice is a full-height band anchored
 * to the bottom (no tiny trailing sliver, no duplicate). Capped at `maxSlices`.
 * Exported for unit tests (the slicing logic is browser-free).
 */
export function computeSliceOffsets(
  fullHeight: number,
  sliceHeight: number,
  overlap: number,
  maxSlices: number,
): number[] {
  if (!Number.isFinite(fullHeight) || fullHeight <= 0) return [0]
  if (fullHeight <= sliceHeight) return [0]
  const maxY = fullHeight - sliceHeight
  const step = Math.max(1, sliceHeight - overlap)
  const ys: number[] = []
  for (let y = 0; ys.length < maxSlices; y += step) {
    const clamped = Math.min(y, maxY)
    if (ys.length && ys[ys.length - 1] === clamped) break
    ys.push(clamped)
    if (clamped >= maxY) break
  }
  return ys
}

/**
 * Pure: when a page is only slightly taller than one scroll band, the last
 * offset is clamped to `maxY` so the final pair of bands overlap far more than
 * the designed `overlap` — producing near-duplicate `-cNN` slices. Return true
 * when that clamp is detected so the capture can auto-stitch into one image.
 *
 * Rule: >=2 offsets AND the last gap is less than `bandHeight - overlap` (the
 * designed step). Tall pages whose interior offsets already stepped at the
 * designed gap keep slicing — only the bottom-clamped short-page case returns
 * true.
 */
export function shouldAutoStitchOffsets(
  offsets: number[],
  bandHeight: number,
  overlap: number,
): boolean {
  if (offsets.length < 2) return false
  const designStep = Math.max(1, bandHeight - overlap)
  const lastGap = offsets[offsets.length - 1] - offsets[offsets.length - 2]
  if (lastGap >= designStep) return false
  if (offsets.length > 2 && offsets[1] - offsets[0] >= designStep) return false
  return true
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
  healthMonitorOverride?: { tickMs: number; maxAutoRefreshes?: number; maxReopens?: number }
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
  /**
   * Monotonic counter bumped on every handler `page(id)` call, plus the id of
   * the most recently accessed system. The Stepper reads `pageAccess()` at step
   * boundaries to take an end-of-step audit screenshot of the ONE system the
   * step actually touched: a step whose body never resolved a page leaves the
   * counter unchanged → no capture (a pure-compute step), and a multi-system run
   * still yields one screenshot per step (the last-touched page) rather than one
   * per open page. Per-Session, so a worker child tracks its own access.
   */
  private pageAccessSeq = 0
  private lastAccessedSystem: string | null = null
  /** When true, skip idle reload (handler is inside a `ctx.step` body). Global across systems. */
  private idleGuard: () => boolean = () => false
  /** Global cadence override (tests). Applies to every idle-refresh system. */
  private idleRefreshOverride?: { thresholdMs: number; tickMs: number }
  /** Set by `Session.launch` — observability for the idle-refresh ring UI. */
  private idleTouchCb?: (systemId: string) => void
  private idleRefreshCb?: (systemId: string, phase: 'start' | 'end') => void
  /** Set by `Session.launch` — per-browser health lifecycle for the session tiles. */
  private healthCb?: (systemId: string, status: BrowserHealthStatus, reason?: string, url?: string, paused?: boolean) => void
  /** Systems whose AUTO-recovery the operator paused (still probed + surfaced,
   * but the monitor won't refresh/reopen — lets them inspect a broken browser). */
  private autoRecoveryPaused = new Set<string>()
  /** Per-system health-monitor state, keyed by systemId. */
  private healthStates = new Map<string, HealthMonitorState>()
  /** The health-monitor interval (root session only). */
  private healthTimer: ReturnType<typeof setInterval> | null = null
  /** Health-monitor cadence override (tests). */
  private healthMonitorOverride?: { tickMs: number; maxAutoRefreshes?: number; maxReopens?: number }

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
  /** Systems whose Chromium process disconnected during this session lifetime. */
  private browserDisconnectIds = new Set<string>()
  /**
   * True once this session is DELIBERATELY tearing down (`close` /
   * `closeWorkerPages` / `killChrome` / `killChromeHard`). A `disconnected`
   * event that fires while this is set is OUR own browser kill, not a fault, so
   * the disconnect handler suppresses the `failed` health emit — otherwise an
   * operator stopping a daemon from the session card gets a red "browser
   * failed" toast for a manual stop. A worker view defers to its parent.
   */
  private closing = false

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
   * True when this session OR (for a worker view) its parent is deliberately
   * tearing down. Mirrors `isAuthInProgress` — a worker shares the parent's
   * browser lifetime, so the parent's teardown counts as the worker closing too.
   */
  private isClosing(): boolean {
    return this.closing || (this.parent?.isClosing() ?? false)
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
    session.healthCb = (systemId: string, status: BrowserHealthStatus, reason?: string, url?: string, paused?: boolean): void => {
      opts.observer?.onBrowserHealth?.(systemId, status, reason, url, paused)
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
      // A `disconnected` during a DELIBERATE teardown (operator stop / SIGINT /
      // graceful close) is our own browser kill, not a fault — suppress the
      // `failed` health emit so a manual stop doesn't surface a red "browser
      // failed" toast in the dashboard. The disconnect is still RECORDED (in
      // onBrowserDisconnect's listener) for the daemon's reassign/fail logic.
      if (session.isClosing()) return
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
    this.markClosing()
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
    // Record handler page access for the Stepper's end-of-step screenshot. This
    // is the funnel every `ctx.page(id)` / `ctx.session.page(id)` call hits;
    // internal kernel paths (health monitor, idle reload, reset) touch
    // `slot.page` directly and deliberately do NOT bump this.
    this.pageAccessSeq += 1
    this.lastAccessedSystem = id
    return slot.page
  }

  /**
   * Snapshot of handler page access — the monotonic `page(id)` counter and the
   * most recently accessed system id. The Stepper compares the counter across a
   * step body to decide whether the step touched a browser (and which one) for
   * its end-of-step audit screenshot. See `pageAccessSeq` / `lastAccessedSystem`.
   */
  pageAccess(): { seq: number; system: string | null } {
    return { seq: this.pageAccessSeq, system: this.lastAccessedSystem }
  }

  /**
   * Flag this session as deliberately tearing down and stop the background
   * timers (idle refresh + health monitor) so neither they nor the
   * `disconnected` listener surface our OWN browser kill as a `failed` fault.
   * Idempotent — every teardown entry point (`close`, `closeWorkerPages`,
   * `killChrome`, `killChromeHard`) calls it first.
   */
  private markClosing(): void {
    this.closing = true
    this.stopIdleRefreshTimers()
    this.stopHealthMonitor()
  }

  async close(): Promise<void> {
    this.markClosing()
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
    this.markClosing()
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
    return (await this.inspectSystemHealth(id)).kind === 'ok'
  }

  /**
   * Classify a system's page into a recovery VERDICT (the richer form of
   * `healthCheck`). Gathers three raw observations — closed? what url? does a
   * trivial JS round-trip succeed? — and maps them via the pure
   * `classifyBrowserHealth` (so the taxonomy is unit-testable without
   * Playwright). The JS probe is SKIPPED for a login/chrome-error/blank url —
   * the url alone already classifies those, and we don't want to evaluate into
   * the SSO page's context. Best-effort: every probe path falls back rather
   * than throwing.
   */
  private async inspectSystemHealth(id: string): Promise<BrowserHealthVerdict> {
    const slot = this.state.browsers.get(id)
    if (!slot) return { kind: 'dead', reason: 'no browser for system' }
    let closed: boolean
    try { closed = slot.page.isClosed() } catch { closed = true }
    if (closed) return classifyBrowserHealth({ closed: true, url: '', probed: false })
    let url = ''
    try { url = slot.page.url() } catch { /* leave '' → wedged */ }
    let probed = false
    // Only spend the 5s JS round-trip when the url looks like a usable app page;
    // a login/chrome-error/blank url is already decisive.
    if (url && url !== 'about:blank' && !url.toLowerCase().startsWith('chrome-error') && !isLoginLikeUrl(url)) {
      try {
        probed = await Promise.race([
          slot.page.evaluate(() => 1).then((v) => v === 1).catch(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
        ])
      } catch {
        probed = false
      }
    }
    return classifyBrowserHealth({ closed: false, url, probed })
  }

  /**
   * The system's current page URL (best-effort) — surfaced to the dashboard tile
   * so the operator can see where each browser actually is (e.g. stuck on login).
   * Returns `undefined` if unavailable.
   */
  currentUrl(id: string): string | undefined {
    const slot = this.state.browsers.get(id)
    if (!slot) return undefined
    try {
      const u = slot.page.url()
      return u || undefined
    } catch {
      return undefined
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
  /**
   * True when a launched browser emitted `disconnected` (this session or parent).
   * Callers (`Stepper`/`run-one-item`'s `mapEscapedHandlerError`/`isCancelledOutcome`)
   * consult this to reclassify a "Target closed"-shaped Playwright error as a
   * cancellation instead of a genuine failure. **Scoped to the system this
   * Session last touched** (`lastAccessedSystem`, the same signal `pageAccess()`
   * exposes and that `classifyError`'s `systemId` attribution already relies on)
   * — only a disconnect on THAT system reclassifies. Without this scoping, any
   * ONE system disconnecting once would silently downgrade every LATER genuine
   * handler bug on every OTHER (never-disconnected) system to a cancelled row
   * for the rest of the daemon's uptime, hiding a real failure as a cancel
   * (fail-loud violation). Every real call site invokes this immediately after
   * a `ctx.page(id)`-driven Playwright call throws, so `lastAccessedSystem` is
   * the system whose call actually failed. Falls back to the legacy
   * "any system ever disconnected" check only when no page has been accessed
   * yet on this Session (no system to scope to — an edge case only synthetic
   * tests exercise via a bare `hadBrowserDisconnect()` with no prior `page()` call).
   */
  hadBrowserDisconnect(): boolean {
    const systemId = this.lastAccessedSystem
    if (systemId !== null) return this.disconnectedSystems().has(systemId)
    if (this.browserDisconnectIds.size > 0) return true
    return this.parent?.hadBrowserDisconnect() ?? false
  }

  /** System ids whose browser process disconnected (includes parent pool browsers). */
  disconnectedSystems(): ReadonlySet<string> {
    const merged = new Set(this.browserDisconnectIds)
    if (this.parent) {
      for (const id of this.parent.disconnectedSystems()) merged.add(id)
    }
    return merged
  }

  onBrowserDisconnect(handler: (systemId: string) => void): () => void {
    const registered: Array<{ browser: Browser; listener: () => void }> = []
    for (const [systemId, slot] of this.state.browsers) {
      // `browser: null` is a worker slot (parent owns lifetime). Guard `.on`
      // too so a stub Browser (tests) can't break the launch wiring that now
      // registers this internally.
      if (!slot.browser || typeof slot.browser.on !== 'function') continue
      const listener = (): void => {
        this.browserDisconnectIds.add(systemId)
        handler(systemId)
      }
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
      st = { lastStatus: 'healthy', autoRefreshCount: 0, reopenCount: 0, reloadInFlight: false, monitorBusy: false }
      this.healthStates.set(systemId, st)
    }
    return st
  }

  /** Emit a per-browser health transition (best-effort; never breaks automation).
   * Auto-attaches the system's current url + auto-recovery-paused flag so the
   * tile can show where the browser is and whether auto-recovery is off. */
  private emitHealth(systemId: string, status: BrowserHealthStatus, reason?: string): void {
    try {
      this.healthCb?.(systemId, status, reason, this.currentUrl(systemId), this.isAutoRecoveryPaused(systemId))
    } catch {
      /* observability must not break automation */
    }
  }

  /** Whether the operator paused AUTO-recovery for this system (manual controls
   * still work; the monitor just won't refresh/reopen it). Workers defer to the
   * parent (the root owns the monitor + the pause set). */
  isAutoRecoveryPaused(id: string): boolean {
    return this.autoRecoveryPaused.has(id) || (this.parent?.isAutoRecoveryPaused(id) ?? false)
  }

  /** Pause auto-recovery for a system and surface it immediately (emit current health). */
  pauseAutoRecovery(id: string): void {
    this.autoRecoveryPaused.add(id)
    const st = this.healthStates.get(id)
    this.emitHealth(id, st?.lastStatus ?? 'healthy')
  }

  /** Resume auto-recovery for a system and surface it immediately. */
  resumeAutoRecovery(id: string): void {
    this.autoRecoveryPaused.delete(id)
    const st = this.healthStates.get(id)
    this.emitHealth(id, st?.lastStatus ?? 'healthy')
  }

  /**
   * Set/clear the idle-refresh `reloadInFlight` flag for a system (when it has
   * an idle timer) so an idle reload and a health Refresh/Reopen never mutate
   * the same page concurrently. The idle tick already bails on its own
   * `reloadInFlight`; the health monitor bails on it too (`tickHealthMonitor`).
   */
  private setIdleReloadFlag(systemId: string, value: boolean): void {
    const idle = this.idleStates.get(systemId)
    if (idle) idle.reloadInFlight = value
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
    this.setIdleReloadFlag(id, true)
    try {
      let closed = false
      try { closed = slot.page.isClosed() } catch { closed = true }
      if (closed) {
        // A closed tab can't be reloaded — Reopen (a fresh tab on the live
        // context) is the recovery. Surface unhealthy so the monitor/operator
        // escalates rather than treating Refresh as a dead end.
        this.emitHealth(id, 'unhealthy', 'tab closed — needs reopen')
        st.lastStatus = 'unhealthy'
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
        st.reopenCount = 0
      } else {
        this.emitHealth(id, 'unhealthy', 'page did not recover after refresh')
        st.lastStatus = 'unhealthy'
      }
      return ok
    } finally {
      st.reloadInFlight = false
      this.setIdleReloadFlag(id, false)
    }
  }

  /**
   * Reopen a system on a FRESH tab in its existing authenticated context — the
   * escalation past Refresh for a wedged page (dead iframe context, stalled
   * `about:blank`, or a closed tab) where the SERVER SESSION IS STILL VALID. A
   * new page on the same `BrowserContext` inherits the auth cookies, so this is
   * **no-Duo** (no relaunch, no re-auth). Sequence: open a new page → navigate
   * to the system's home/reset URL (or where it was) → verify the new page is
   * usable → swap `slot.page` and close the old one.
   *
   * Doubles as the expiry probe: if even the fresh tab lands on the SSO/login
   * host, the session is genuinely gone → surface `failed` ("re-auth needed"),
   * never loop. Serialized against Refresh + idle-refresh via `reloadInFlight`.
   *
   * Safe because handlers fetch `ctx.page(id)` fresh each step and the monitor
   * only reopens between steps (guarded by `idleGuard`), so no handler holds a
   * stale page reference across the swap.
   */
  async reopenSystem(id: string): Promise<boolean> {
    const slot = this.state.browsers.get(id)
    if (!slot) return false
    const st = this.ensureHealthState(id)
    if (st.reloadInFlight) return false
    st.reloadInFlight = true
    this.setIdleReloadFlag(id, true)
    try {
      const sys = this.state.systems.find((s) => s.id === id)
      // Prefer the system's home/reset URL; else re-navigate to where it was
      // (unless that's a dead/login/error url). Last resort: about:blank, which
      // the post-nav check will reject as unhealthy.
      let target = sys?.resetUrl
      if (!target) {
        try {
          const u = slot.page.url()
          if (u && u !== 'about:blank' && !u.toLowerCase().startsWith('chrome-error') && !isLoginLikeUrl(u)) {
            target = u
          }
        } catch { /* leave undefined */ }
      }
      target = target ?? 'about:blank'

      this.emitHealth(id, 'refreshing', 'reopening browser tab')
      st.lastStatus = 'refreshing'

      let newPage: Page
      try {
        newPage = await slot.context.newPage()
      } catch (err) {
        log.warn(`[Session: ${id}] reopen: could not open a new tab: ${errorMessage(err)}`)
        this.emitHealth(id, 'failed', 'could not open a new tab')
        st.lastStatus = 'failed'
        return false
      }
      try {
        await newPage.goto(target, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      } catch (err) {
        // Keep the page — the verdict check below decides if it's usable.
        log.warn(`[Session: ${id}] reopen: navigation to ${target} failed: ${errorMessage(err)}`)
      }

      // Verify the NEW page directly (slot.page is still the old one until we swap).
      let newUrl = ''
      try { newUrl = newPage.url() } catch { /* leave '' */ }
      if (isLoginLikeUrl(newUrl)) {
        // Even a fresh tab landed on SSO — the session is actually expired.
        try { await newPage.close() } catch { /* best-effort */ }
        this.emitHealth(id, 'failed', 'session expired — re-auth needed')
        st.lastStatus = 'failed'
        return false
      }
      let probed = false
      if (newUrl && newUrl !== 'about:blank' && !newUrl.toLowerCase().startsWith('chrome-error')) {
        try {
          probed = await Promise.race([
            newPage.evaluate(() => 1).then((v) => v === 1).catch(() => false),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
          ])
        } catch { probed = false }
      }
      if (!probed) {
        try { await newPage.close() } catch { /* best-effort */ }
        this.emitHealth(id, 'unhealthy', 'reopened tab did not become usable')
        st.lastStatus = 'unhealthy'
        return false
      }

      // Swap: point the slot at the fresh page, then close the wedged one.
      const oldPage = slot.page
      slot.page = newPage
      try { if (!oldPage.isClosed()) await oldPage.close() } catch { /* best-effort */ }
      if (this.idleStates.has(id)) this.noteIdleActivity(id)
      log.success(`[Session: ${id}] reopened on a fresh tab (same auth, no Duo)`)
      this.emitHealth(id, 'healthy')
      st.lastStatus = 'healthy'
      st.autoRefreshCount = 0
      st.reopenCount = 0
      return true
    } finally {
      st.reloadInFlight = false
      this.setIdleReloadFlag(id, false)
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
   * Capture the current VIEWPORT of a system's page as a PNG buffer — the
   * operator "peek" (see what the browser shows right now, inline, without
   * hunting for the window). Viewport (not fullPage) keeps it fast + small.
   * Returns null if the system has no live/usable page. Best-effort.
   */
  async screenshotSystem(id: string): Promise<Buffer | null> {
    const slot = this.state.browsers.get(id)
    if (!slot) return null
    try {
      if (slot.page.isClosed()) return null
      return await slot.page.screenshot({ type: 'png' })
    } catch {
      return null
    }
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
   * Start the per-browser health monitor on the ROOT session. Every `tickMs` it
   * classifies each launched browser and walks the recovery LADDER — Refresh
   * (rung 1, bounded) → Reopen on a fresh tab (rung 2, bounded) → surface
   * `failed`. A genuinely-expired session (page on the SSO host) is surfaced
   * for re-auth, never auto-fixed. Idempotent; unref'd so it never keeps the
   * process alive.
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
   * (never probe/reload mid-Duo), while a `ctx.step` body owns the page
   * (`idleGuard` — the handler's own `gotoWithRetry` covers in-step nav faults),
   * or while an idle-refresh reload is mid-flight. So recovery only fires
   * between steps / when the session is parked.
   *
   * The escalation ladder, by verdict (see `classifyBrowserHealth`):
   *   - `ok`            → emit `healthy` (recovery), reset rung counters.
   *   - `expired`       → surface `failed` ("re-auth needed"); Refresh/Reopen
   *                       would just re-land on login, so don't.
   *   - `soft`          → Refresh (rung 1) up to `maxAutoRefreshes`, then Reopen.
   *   - `wedged`/`closed` → a reload can't help (or there's no tab to reload),
   *                       so go straight to Reopen (rung 2) up to `maxReopens`.
   *   - exhausted both  → surface `failed` (recovery exhausted).
   */
  private async tickHealthMonitor(systemId: string): Promise<void> {
    const slot = this.state.browsers.get(systemId)
    if (!slot) return
    if (this.isAuthInProgress()) return
    if (this.idleGuard()) return
    const idle = this.idleStates.get(systemId)
    if (idle?.reloadInFlight) return
    const st = this.ensureHealthState(systemId)
    if (st.monitorBusy || st.reloadInFlight) return
    st.monitorBusy = true
    try {
      const verdict = await this.inspectSystemHealth(systemId)
      if (verdict.kind === 'ok') {
        if (st.lastStatus !== 'healthy') this.emitHealth(systemId, 'healthy')
        st.lastStatus = 'healthy'
        st.autoRefreshCount = 0
        st.reopenCount = 0
        return
      }
      if (verdict.kind === 'dead' || verdict.kind === 'expired') {
        // dead = no slot (handled above); expired = on the SSO host. Neither is
        // auto-recoverable — surface for re-auth / inspection. (A hard process
        // disconnect surfaces `failed` via onBrowserDisconnect separately.)
        if (st.lastStatus !== 'failed') this.emitHealth(systemId, 'failed', verdict.reason)
        st.lastStatus = 'failed'
        return
      }
      // Auto-recovery paused — surface the fault so the operator sees it, but
      // do NOT refresh/reopen (they're inspecting). Manual controls still work.
      if (this.isAutoRecoveryPaused(systemId)) {
        if (st.lastStatus !== 'unhealthy') this.emitHealth(systemId, 'unhealthy', `${verdict.reason ?? 'unhealthy'} (auto-recovery paused)`)
        st.lastStatus = 'unhealthy'
        return
      }
      const maxRefreshes = this.healthMonitorOverride?.maxAutoRefreshes ?? HEALTH_MONITOR_MAX_AUTO_REFRESH
      const maxReopens = this.healthMonitorOverride?.maxReopens ?? HEALTH_MONITOR_MAX_REOPEN
      // Rung 1 — Refresh, but only for a `soft` fault (a reload can clear a
      // chrome-error). A `wedged`/`closed` page skips straight to Reopen.
      if (verdict.kind === 'soft' && st.autoRefreshCount < maxRefreshes) {
        st.autoRefreshCount++
        await this.refreshSystem(systemId)
        return
      }
      // Rung 2 — Reopen on a fresh tab (same auth, no Duo).
      if (st.reopenCount < maxReopens) {
        st.reopenCount++
        await this.reopenSystem(systemId)
        return
      }
      // Both rungs exhausted — surface for the operator.
      if (st.lastStatus !== 'failed') this.emitHealth(systemId, 'failed', `${verdict.reason ?? 'unhealthy'} (recovery exhausted)`)
      st.lastStatus = 'failed'
    } catch {
      /* best-effort — a monitor failure must never break the run */
    } finally {
      st.monitorBusy = false
    }
  }

  async killChrome(): Promise<void> {
    // SIGINT teardown — force-close all browsers without awaiting graceful shutdown.
    this.markClosing()
    for (const slot of this.state.browsers.values()) {
      try { await slot.browser?.close() } catch { /* ignore */ }
    }
  }

  /**
   * THE unified "whole page / whole form" audit capture. Every `ctx.screenshot()`
   * routes here (no per-caller mode soup). It captures the ENTIRE page or form —
   * never a clipped portion — as ONE image when the content fits one viewport, or
   * a sequence of readable page-height SLICES (`-cNN`) when it's tall, so a long
   * form is a few readable pages the operator steps through, not one tiny strip.
   * Returns the file path(s) written.
   *
   * **Technique — scroll-and-capture the PAINTED pixels** (the approach proven by
   * full-page-screenshot browser extensions, adapted to Playwright). Rather than
   * mutating the DOM to force `document.scrollHeight` tall and trusting
   * `screenshot({fullPage})` to render off-screen content — which is unreliable
   * when the real content lives inside a scroll container or a same-origin iframe
   * (the Kuali finalization modal and the UCPath `#main_target_win0` frame both
   * clipped under the old approach) — we find the element that ACTUALLY scrolls,
   * scroll it one band at a time, and screenshot what is genuinely PAINTED at each
   * position. Painted-pixel capture can't clip content the renderer never drew.
   *
   * Pipeline (each step best-effort + reversible, restored in `finally`):
   *   1. `setCaptureWidth(CAPTURE.width)` — pin the layout viewport to a FIXED
   *      readable column width (1280) so a narrow/normal form captures the SAME
   *      width regardless of the tiled daemon window; widen BEYOND 1280 only for
   *      genuinely wide content (PeopleSoft grids).
   *   2. `planScrollCapture` — pick the DOMINANT scroll target (the window, an
   *      inner `overflow:auto/scroll` container like the Kuali modal, or a
   *      same-origin iframe like the UCPath content frame — whichever has the
   *      most hidden overflow), tag it, and HIDE `position:fixed`/`sticky`
   *      elements that aren't the target (so a sticky banner/header — e.g. the
   *      "unsupported browser" bar pinned over the Kuali form — doesn't repeat in
   *      every band). Returns the target's `scrollHeight` + visible band height.
   *   3. `computeSliceOffsets(scrollHeight, bandHeight, …)` → for each offset,
   *      `scrollCaptureTo(y)` scrolls the target there + returns its live on-screen
   *      clip rect, then one `page.screenshot({ clip })` of the painted viewport.
   *      A content-fits-one-viewport WINDOW page is a single tight `fullPage` shot.
   *
   * `slicePath(null)` names a single-image capture; `slicePath(i)` names slice i.
   *
   * Stitching is the DEFAULT: the bands are composited into ONE continuous image
   * (written to `slicePath(null)`) via `stitchCaptureBands` rather than emitted
   * as separate `-cNN` chunk slices — so every capture is a single screenshot,
   * never a chunked set. Pass `opts.stitch === false` to force the raw `-cNN`
   * slices. A short (single-band) page is one image either way; a compositing
   * failure degrades to writing the raw slices, so a capture is never lost.
   * A composite whose estimated canvas exceeds `MAX_STITCH_PIXELS` (very tall
   * pages) also degrades to the raw `-cNN` slices — compositing decodes every
   * band and allocates/deflates the full-page RGBA canvas synchronously on the
   * daemon event loop, so an unbounded stitch stalls Duo polling / health /
   * abort handling. The degradation is logged.
   */
  static async captureFullPage(
    page: Page,
    slicePath: (chunk: number | null) => string,
    opts?: { stitch?: boolean },
  ): Promise<string[]> {
    let restoreViewport: (() => Promise<void>) | null = null
    let restorePlan: (() => Promise<void>) | null = null
    const written: string[] = []
    const fallbackFullPage = async (): Promise<void> => {
      if (written.length > 0) return
      try {
        const p = slicePath(null)
        await page.screenshot({ path: p, fullPage: true })
        written.push(p)
      } catch { /* best-effort */ }
    }
    try {
      const maybeWaitForLoadState = page as unknown as {
        waitForLoadState?: (state: 'networkidle', options: { timeout: number }) => Promise<void>
        waitForTimeout?: (ms: number) => Promise<void>
      }
      await maybeWaitForLoadState.waitForLoadState?.('networkidle', { timeout: 1_000 }).catch(() => {})
      const pin = await Session.setCaptureWidth(page, CAPTURE.width)
      restoreViewport = pin.restore

      const plan = await Session.planScrollCapture(page)
      restorePlan = async () => {
        try {
          await page.evaluate(() => {
            const w = window as unknown as { __hrcapRestore?: () => void }
            w.__hrcapRestore?.()
          })
        } catch { /* best-effort */ }
      }
      if (!plan || !Number.isFinite(plan.scrollHeight) || plan.scrollHeight <= 0) {
        await fallbackFullPage()
        return written
      }

      const bandHeight = Math.max(1, Math.min(plan.clientHeight || CAPTURE.sliceHeight, CAPTURE.sliceHeight))
      const offsets = computeSliceOffsets(plan.scrollHeight, bandHeight, CAPTURE.sliceOverlap, CAPTURE.maxSlices)
      const autoStitch = shouldAutoStitchOffsets(offsets, bandHeight, CAPTURE.sliceOverlap)
      const single = offsets.length === 1

      // A short WINDOW page (fits one viewport) is a single tight fullPage shot —
      // no scrolling, no whitespace padding below the content.
      if (single && plan.mode === 'window') {
        const p = slicePath(null)
        await page.screenshot({ path: p, fullPage: true })
        written.push(p)
        return written
      }

      // Stitch by DEFAULT: scroll-capture each band to a buffer, then composite
      // them into ONE continuous image (overlap removed by exact scroll geometry)
      // instead of writing separate `-cNN` chunk slices — every capture is one
      // screenshot, never a chunked set. Only an explicit `stitch: false` opts
      // back into slices, and even then an over-overlapped final band pair
      // (slightly-taller-than-one-band) still auto-stitches to avoid near-dupes.
      const stitch = opts?.stitch !== false
      if (stitch || autoStitch) {
        const bands: Array<{ buffer: Buffer; offsetCss: number; clipHeightCss: number | null }> = []
        for (let i = 0; i < offsets.length; i++) {
          const clip = await Session.scrollCaptureTo(page, offsets[i])
          await maybeWaitForLoadState.waitForTimeout?.(250).catch(() => {})
          try {
            const buffer = clip ? await page.screenshot({ clip }) : await page.screenshot()
            bands.push({ buffer, offsetCss: offsets[i], clipHeightCss: clip ? clip.height : null })
          } catch { /* best-effort — one band failure mustn't lose the rest */ }
        }
        if (bands.length === 1) {
          // One band: no compositing needed — write it as the single image.
          const p = slicePath(null)
          try { await fs.writeFile(p, bands[0].buffer); written.push(p) } catch { /* best-effort */ }
        } else if (bands.length > 1 && bands.every((b) => b.clipHeightCss && b.clipHeightCss > 0)) {
          // Cap the composite: stitching decodes every band, allocates the
          // full-page RGBA canvas (4 bytes/px), and deflates it synchronously
          // on the daemon event loop — a very tall page stalls Duo polling /
          // health / abort for seconds. Estimate the canvas from the band PNG
          // headers (no decode) and degrade to the -cNN slices above the cap.
          const estPixels = estimateStitchedPixels(bands as CaptureBand[])
          if (!shouldStitchComposite(estPixels)) {
            log.warn({
              message: `[Session] Capture stitch skipped — estimated composite ${estPixels}px exceeds cap ${MAX_STITCH_PIXELS}px; degrading to ${bands.length} -cNN page slices`,
              count: bands.length,
            })
          } else {
            try {
              const stitched = stitchCaptureBands(bands as CaptureBand[])
              const p = slicePath(null)
              await fs.writeFile(p, stitched)
              written.push(p)
            } catch { /* compositing failed — degrade to raw slices below */ }
          }
        }
        // Degrade: stitch couldn't run (missing clip / decode failure). Write the
        // captured bands as the usual `-cNN` slices so the capture is never lost.
        if (written.length === 0 && bands.length > 0) {
          for (let i = 0; i < bands.length; i++) {
            const p = bands.length === 1 ? slicePath(null) : slicePath(i)
            try { await fs.writeFile(p, bands[i].buffer); written.push(p) } catch { /* best-effort */ }
          }
        }
        if (written.length === 0) await fallbackFullPage()
        return written
      }

      for (let i = 0; i < offsets.length; i++) {
        const clip = await Session.scrollCaptureTo(page, offsets[i])
        await maybeWaitForLoadState.waitForTimeout?.(250).catch(() => {})
        const p = single ? slicePath(null) : slicePath(i)
        try {
          if (clip) await page.screenshot({ path: p, clip })
          else await page.screenshot({ path: p })
          written.push(p)
        } catch { /* best-effort — one band failure mustn't lose the rest */ }
      }
      if (written.length === 0) await fallbackFullPage()
      return written
    } catch {
      await fallbackFullPage()
      return written
    } finally {
      if (restorePlan) await restorePlan()
      if (restoreViewport) await restoreViewport()
    }
  }

  /**
   * Pick the DOMINANT scroll target for a painted-pixel capture and prep the page
   * for it. Compares the hidden overflow of (a) the window, (b) every visible
   * `overflow:auto/scroll` element that fills a meaningful slice of the viewport,
   * and (c) every same-origin iframe's scrolling document, and selects whichever
   * has the most off-screen content — but ONLY among containers that are actually
   * VISIBLE (a scroll container painted behind another layer, e.g. the Kuali Build
   * apps catalog mounted behind an open document view, is occlusion-rejected so the
   * capture walks the on-screen form, not the hidden catalog). Tags the chosen
   * element/iframe (`data-hrcap`
   * / `data-hrcap-frame`) so `scrollCaptureTo` can drive it across evaluate calls,
   * and hides `position:fixed`/`sticky` chrome that isn't part of the target chain
   * (so it doesn't reprint in every band). Stashes a `window.__hrcapRestore` that
   * un-hides + un-tags. Returns the target's `scrollHeight` and visible band
   * height, or null on failure (caller falls back to a plain fullPage shot).
   *
   * Written as ITERATIVE evaluate code — a NAMED nested function/arrow inside
   * `page.evaluate` trips the esbuild/tsx `__name` keep-names helper (undefined in
   * the browser → the whole evaluate throws); see `src/core/CLAUDE.md`.
   */
  private static async planScrollCapture(page: Page): Promise<
    { mode: 'window' | 'element' | 'iframe'; scrollHeight: number; clientHeight: number } | null
  > {
    try {
      const plan = await page.evaluate(() => {
        const vw = window.innerWidth
        const vh = window.innerHeight
        const docH = Math.max(
          document.documentElement ? document.documentElement.scrollHeight : 0,
          document.body ? document.body.scrollHeight : 0,
        )
        const winOverflow = Math.max(0, docH - vh)
        const MIN_OVERFLOW = 40
        const MIN_HEIGHT_FRAC = 0.35
        const MIN_WIDTH_FRAC = 0.3
        const SCAN_CAP = 25_000
        const all = document.querySelectorAll<HTMLElement>('*')
        const scanN = Math.min(all.length, SCAN_CAP)

        // (b) dominant scrollable element in this document.
        let bestEl: HTMLElement | null = null
        let bestElOverflow = 0
        for (let i = 0; i < scanN; i++) {
          const el = all[i]
          const cs = getComputedStyle(el)
          const oy = cs.overflowY
          if (!(oy === 'auto' || oy === 'scroll')) continue
          const ov = el.scrollHeight - el.clientHeight
          if (ov <= MIN_OVERFLOW) continue
          const r = el.getBoundingClientRect()
          if (r.height < vh * MIN_HEIGHT_FRAC || r.width < vw * MIN_WIDTH_FRAC) continue
          // Skip a scroll container that is fully OCCLUDED — mounted in the DOM but
          // painted BEHIND another layer. The Kuali Build apps catalog stays mounted
          // behind an open document view with ~15000px of overflow; by raw overflow
          // it wins this scan, so the capture walked the hidden catalog instead of
          // the visible form. Sample a grid of points in the element's on-screen rect
          // and keep it only if it (or a descendant) is the TOP painted element at
          // some point — i.e. it is actually visible to the operator. Fail-open: if
          // elementFromPoint can't run, don't reject (no regression).
          let elVisible = false
          for (let sx = 0; sx < 3 && !elVisible; sx++) {
            for (let sy = 0; sy < 3 && !elVisible; sy++) {
              const px = Math.min(vw - 1, Math.max(0, r.left + r.width * (0.25 + sx * 0.25)))
              const py = Math.min(vh - 1, Math.max(0, r.top + r.height * (0.3 + sy * 0.2)))
              let top: Element | null = null
              try { top = document.elementFromPoint(px, py) } catch { /* occlusion probe is best-effort */ }
              if (top && (top === el || el.contains(top))) elVisible = true
            }
          }
          if (!elVisible) continue
          if (ov > bestElOverflow) { bestElOverflow = ov; bestEl = el }
        }

        // (c) dominant scrollable same-origin iframe.
        let bestFrame: HTMLIFrameElement | null = null
        let bestFrameOverflow = 0
        let bestFrameScrollHeight = 0
        const frames = document.querySelectorAll('iframe')
        for (let i = 0; i < frames.length; i++) {
          const f = frames[i]
          let cdoc: Document | null
          try { cdoc = f.contentDocument } catch { cdoc = null }
          if (!cdoc || !cdoc.documentElement) continue
          const se = cdoc.scrollingElement || cdoc.documentElement
          const ov = se.scrollHeight - se.clientHeight
          if (ov <= MIN_OVERFLOW) continue
          const r = f.getBoundingClientRect()
          if (r.height < vh * MIN_HEIGHT_FRAC || r.width < vw * MIN_WIDTH_FRAC) continue
          // Same occlusion guard as the element scan: skip an iframe painted behind
          // another layer. A visible iframe is itself the top element at its own
          // coordinates (the parent document's elementFromPoint can't descend into
          // the child doc), so a genuinely-shown frame passes via `top === f`.
          let frameVisible = false
          for (let sx = 0; sx < 3 && !frameVisible; sx++) {
            for (let sy = 0; sy < 3 && !frameVisible; sy++) {
              const px = Math.min(vw - 1, Math.max(0, r.left + r.width * (0.25 + sx * 0.25)))
              const py = Math.min(vh - 1, Math.max(0, r.top + r.height * (0.3 + sy * 0.2)))
              let top: Element | null = null
              try { top = document.elementFromPoint(px, py) } catch { /* occlusion probe is best-effort */ }
              if (top && (top === f || f.contains(top))) frameVisible = true
            }
          }
          if (!frameVisible) continue
          if (ov > bestFrameOverflow) { bestFrameOverflow = ov; bestFrame = f; bestFrameScrollHeight = se.scrollHeight }
        }

        // Choose the target with the most hidden overflow. Prefer the window on a
        // tie/within-window content (it shows everything in one column).
        let mode: 'window' | 'element' | 'iframe' = 'window'
        let scrollHeight = docH
        let clientHeight = vh
        let chainStart: HTMLElement | null = null
        if (bestFrame && bestFrameOverflow > winOverflow && bestFrameOverflow >= bestElOverflow) {
          mode = 'iframe'
          chainStart = bestFrame
          scrollHeight = bestFrameScrollHeight
          const r = bestFrame.getBoundingClientRect()
          clientHeight = Math.max(1, Math.min(r.height, vh))
          bestFrame.setAttribute('data-hrcap-frame', '1')
        } else if (bestEl && bestElOverflow > winOverflow) {
          mode = 'element'
          chainStart = bestEl
          scrollHeight = bestEl.scrollHeight
          const r = bestEl.getBoundingClientRect()
          clientHeight = Math.max(1, Math.min(bestEl.clientHeight, r.height, vh))
          bestEl.setAttribute('data-hrcap', '1')
        }

        // Keep the target + its ancestors visible; hide other fixed/sticky chrome.
        const keep = new Set<HTMLElement>()
        let c: HTMLElement | null = chainStart
        while (c) { keep.add(c); c = c.parentElement }
        const hidden: Array<[HTMLElement, string]> = []
        for (let i = 0; i < scanN; i++) {
          const el = all[i]
          const cs = getComputedStyle(el)
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
          if (keep.has(el)) continue
          if (chainStart && el.contains(chainStart)) continue
          hidden.push([el, el.style.display])
          el.style.display = 'none'
        }

        ;(window as unknown as { __hrcapRestore?: () => void }).__hrcapRestore = () => {
          for (const pair of hidden) { try { pair[0].style.display = pair[1] } catch { /* ignore */ } }
          const fr = document.querySelector('[data-hrcap-frame]'); if (fr) fr.removeAttribute('data-hrcap-frame')
          const te = document.querySelector('[data-hrcap]'); if (te) te.removeAttribute('data-hrcap')
          try { window.scrollTo(0, 0) } catch { /* ignore */ }
          delete (window as unknown as { __hrcapRestore?: () => void }).__hrcapRestore
        }

        return { mode, scrollHeight, clientHeight }
      })
      return plan
    } catch {
      return null
    }
  }

  /**
   * Scroll the tagged capture target (iframe content / inner element / window) to
   * vertical offset `y` and return its live on-screen clip rect (CSS px, clamped
   * to the viewport) for the next `page.screenshot({ clip })`. Best-effort — a
   * scroll/measure failure returns null and the caller shoots the bare viewport.
   */
  private static async scrollCaptureTo(
    page: Page,
    y: number,
  ): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      return await page.evaluate((offset: number) => {
        const vw = window.innerWidth
        const vh = window.innerHeight
        let rect: { left: number; top: number; width: number; height: number } | null
        const frame = document.querySelector<HTMLIFrameElement>('[data-hrcap-frame]')
        if (frame) {
          try { frame.contentWindow?.scrollTo(0, offset) } catch { /* ignore */ }
          const r = frame.getBoundingClientRect()
          rect = { left: r.left, top: r.top, width: r.width, height: r.height }
        } else {
          const el = document.querySelector<HTMLElement>('[data-hrcap]')
          if (el) {
            el.scrollTop = offset
            const r = el.getBoundingClientRect()
            rect = { left: r.left, top: r.top, width: r.width, height: r.height }
          } else {
            window.scrollTo(0, offset)
            rect = { left: 0, top: 0, width: vw, height: vh }
          }
        }
        const x0 = Math.max(0, rect.left)
        const y0 = Math.max(0, rect.top)
        const x1 = Math.min(vw, rect.left + rect.width)
        const y1 = Math.min(vh, rect.top + rect.height)
        return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) }
      }, y)
    } catch {
      return null
    }
  }

  /**
   * Pin the layout viewport to a FIXED width — at least `minWidth` (a readable
   * column) so a narrow form captures the same width on any tiled window, and
   * widened BEYOND `minWidth` to fit genuinely wide content (PeopleSoft grids,
   * measured at the top document AND inside child frames since the grid lives in
   * a fluid-width iframe), capped at `CAPTURE.maxWidth`. Returns the applied
   * width + a best-effort restore. Never throws.
   */
  private static async setCaptureWidth(page: Page, minWidth: number): Promise<{ restore: () => Promise<void>; width: number }> {
    const noop = { restore: async (): Promise<void> => {}, width: minWidth }
    const maybeResize = page as unknown as {
      setViewportSize?: (size: { width: number; height: number }) => Promise<void>
      waitForTimeout?: (ms: number) => Promise<void>
      frames?: () => Array<{ evaluate: (fn: () => number) => Promise<number> }>
    }
    if (typeof maybeResize.setViewportSize !== 'function') return noop
    try {
      const metrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth || 0,
        innerHeight: window.innerHeight || 0,
        docWidth: Math.max(
          document.documentElement?.scrollWidth ?? 0,
          document.body?.scrollWidth ?? 0,
        ),
      })).catch(() => null)
      if (!metrics || metrics.innerHeight <= 0) return noop

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

      const target = Math.min(Math.max(minWidth, widest + 24), CAPTURE.maxWidth)
      if (metrics.innerWidth === target) return { restore: async () => {}, width: target }
      await maybeResize.setViewportSize({ width: target, height: metrics.innerHeight })
      await maybeResize.waitForTimeout?.(200).catch(() => {})
      return {
        restore: async () => {
          try { await maybeResize.setViewportSize!({ width: metrics.innerWidth, height: metrics.innerHeight }) } catch { /* best-effort */ }
        },
        width: target,
      }
    } catch {
      return noop
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
      const base = join(outDir, `${prefix}-${id}-${Date.now()}.png`)
      // The unified capture writes ONE file for a short page, or N `-cNN` page
      // slices for a tall one (each a readable page band of the whole form).
      const slicePath = (chunk: number | null): string =>
        chunk === null ? base : base.replace(/\.png$/, `-c${String(chunk + 1).padStart(2, '0')}.png`)
      try {
        const written = await Session.captureFullPage(slot.page, slicePath)
        paths.push(...written)
      } catch { /* best-effort — one failed screenshot mustn't skip siblings */ }
    }
    return paths
  }

  /**
   * Capture all open pages as structured PNGs under `.screenshots/`, using the
   * canonical `{workflow}-{itemId}-{kind}-{label}-{system}-{ts}[-cNN].png`
   * convention. Best-effort — a failure on one page never blocks siblings.
   * Returns metadata for each file written — ONE per short page, or N `-cNN`
   * page slices for a tall one.
   *
   * There is ONE capture mode for every workflow: the unified whole-page/form
   * `captureFullPage` (pin width to a readable column + grow fixed-height iframes
   * + whole-page-or-N-readable-slices), so the ENTIRE page or form is in frame,
   * never a clipped portion. The lone exception is `opts.centerSelector` — a
   * VIEWPORT shot centered on an element, for VIRTUAL-SCROLL grids (the Kronos
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
      // The unified capture for EVERY other page: the whole page/form, never a
      // clipped portion — ONE file when short, or N readable `-cNN` page slices
      // when tall (the operator steps through them in the lightbox).
      const slicePath = (chunk: number | null): string =>
        chunk === null ? p : join(outDir, formatCaptureFilename({
          workflow: opts.workflow, itemId: opts.itemId, kind: opts.kind,
          label: opts.label, system, ts: opts.ts, chunk,
        }))
      const written = await Session.captureFullPage(page, slicePath, { stitch: opts.stitch })
      for (const w of written) await fileMeta(w)
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
