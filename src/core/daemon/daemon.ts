import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import type { RegisteredWorkflow } from '../kernel/types.js'
import { Session } from '../kernel/session.js'
import { runOneItem } from '../kernel/run-one-item.js'
import { withBatchLifecycle } from '../kernel/batch-lifecycle.js'
import { log, enterDaemonLogContext } from '../../utils/log.js'
import { numEnv } from '../../utils/env.js'
import {
  lockfilePath,
  randomInstanceId,
  writeLockfile,
  ensureDaemonsDir,
  findAliveDaemons,
  filterPeersAvailableForHandoff,
  scanAliveDaemonInstanceNames,
} from './registry.js'
import {
  claimNextItem,
  markItemCancelled,
  markItemDone,
  markItemFailed,
} from './queue.js'
import { wakeDaemonsForReleasedParents } from './client.js'
import {
  reassignInFlightItem,
  failInFlightItem,
  SHUTDOWN_NO_DAEMON_FAIL_REASON,
  SHUTDOWN_NO_RESPONSIVE_PEER_FAIL_REASON,
} from './in-flight-shutdown.js'
import { resolveTeardownTransition } from './teardown-transition.js'
import type { DaemonLockfile, QueueItem } from './types.js'
import {
  emitItemStart,
  emitItemComplete,
  emitItemCancelled,
  emitDaemonPhase,
  emitIdleSignal,
  generateInstanceName,
} from '../../tracker/session-events.js'
import { emitTrackerRow, type StampedData } from '../../tracker/jsonl.js'
import { isIdleRefreshSystem } from '../../domain/idle-refresh.js'
import { screenshotsDir } from '../../tracker/paths.js'
import { findFrozenTraceId } from '../../tracker/find-latest-entry.js'
import { openControlDb } from '../control-db.js'
import { createTaskStore } from '../task-store/index.js'
import { createWorkerStore } from './worker-store.js'
import { startDaemonHttpServer } from './http.js'
import { runKeepaliveTick } from './keepalive.js'
import type { DaemonPhase, DaemonState } from './daemon-types.js'
import { daemonInFlight } from './daemon-types.js'
export type { DaemonPhase } from './daemon-types.js'
import { runRegistry, type RunHandle } from '../run-registry.js'
import {
  buildShutdownTrackerData,
  createAbortLaunchAndKillSession,
  installDaemonSignalHandlers,
  runDaemonShutdownCleanup,
} from './shutdown.js'
import {
  createEmitWorkerHeartbeat,
  createHandleWorkerCommand,
  createPollWorkerCommands,
  createRecoverClaimsFromDeadOrStaleWorkers,
  createRegisterBrowserProcesses,
  startWorkerTickInterval,
  type WorkerCommandContext,
} from './worker-commands.js'
import { createDaemonItemAuthTimingResolver } from './auth-timing.js'
import { terminalizeWithReconciliation, type TerminalizationResult } from './terminalization.js'
import {
  OperatorSettingsFaultError,
  readOperatorSettingsFileState,
} from '../../tracker/settings/store.js'

export interface DaemonOpts {
  trackerDir?: string
  /** Repo root containing config/settings.json. Defaults to the daemon cwd. */
  repoRoot?: string
  /** Test-only override for `Session.launch` so we don't open real browsers. */
  sessionLaunchFn?: typeof Session.launch
  /** Test-only: cap the idle wait window (default 15min). */
  idleTimeoutMs?: number
  /** Test-only: cap the lockfile self-heal interval (default 10s). */
  lockHealIntervalMs?: number
  /** Test-only: cap worker heartbeat interval (default 5s). */
  heartbeatIntervalMs?: number
  /** Test-only: cap worker command polling interval (default: heartbeat interval). */
  commandPollIntervalMs?: number
  /** Test-only: cap the idle re-poll backstop interval (default 30s). */
  idleRepollMs?: number
}

// Operator-tunable via Settings → "Daemon" (env populated only for explicitly-set
// fields; unset = the literal default, so an unconfigured install is unchanged).
const DEFAULT_IDLE_MS = numEnv('HRAUTO_DAEMON_IDLE_MS', 15 * 60 * 1000)
const DEFAULT_LOCK_HEAL_MS = 10_000
/**
 * Bounded idle re-poll backstop (ISS-008). The claim loop re-claims on the
 * SOONER of a `/wake` and this interval, so a missed wake — a `/wake` POST that
 * timed out against a momentarily-busy daemon, or one dropped in the synchronous
 * claim→park window — is recovered within seconds instead of waiting out the
 * 15-min keepalive tick. Much shorter than `DEFAULT_IDLE_MS` but a steady-state
 * idle daemon only does a cheap indexed `claimNextTask` seek per tick.
 */
const DEFAULT_IDLE_REPOLL_MS = numEnv('HRAUTO_DAEMON_IDLE_REPOLL_MS', 30_000)
/**
 * Retry delay after a `claimNextItem` THROW (fail-loud: distinct from the
 * normal idle cadence — see the `CLAIM_ERROR` sentinel below).
 */
const CLAIM_ERROR_RETRY_MS = 2_000
/**
 * Sentinel distinguishing a `claimNextItem` ERROR from a genuinely empty
 * queue. `claimNextItem` (queue.ts) already resolves `null` for "nothing
 * queued" — a thrown error is a real fault (e.g. a SQLite transaction
 * failure), and swallowing it to that same `null` would make a broken claim
 * indistinguishable from healthy idle, so the loop would silently retry on
 * the same up-to-`idleRepollMs` idle cadence forever with no visible signal.
 */
const CLAIM_ERROR = Symbol('claim-error')

/**
 * Long-running daemon loop. Must be invoked from a DETACHED process via
 * `src/cli-daemon.ts`. Owns:
 *   - HTTP server for /whoami /status /wake /stop
 *   - Lockfile write + cleanup on shutdown
 *   - Session lifetime (one `Session.launch` on startup, `session.close`
 *     on shutdown)
 *   - Shared-queue claim loop with 15-min keepalive + orphan recovery
 *   - SIGINT/SIGTERM handlers fail the in-flight item (no peer to hand it
 *     to on a signal). The dashboard PER-INSTANCE stop (`/stop` with
 *     `reassign: true`) instead hands the in-flight item back to a surviving
 *     daemon when one exists, and only fails it when this is the last daemon
 *     (2026-06-07; supersedes the 2026-04-28 always-fail rule now that the
 *     operator runs a pool). Queued items are left for surviving peers, or
 *     failed by the last daemon's outer-finally cleanup.
 *
 * Does NOT install its own SIGINT handler via withBatchLifecycle —
 * we pass `ownSigint: false` so batch-lifecycle skips its
 * process.exit(130) and lets us run our own teardown first.
 */
export async function runWorkflowDaemon<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  opts: DaemonOpts = {},
): Promise<void> {
  // Spawned daemons receive their isolated tracker root via HRAUTO_TRACKER_DIR
  // (set in core/daemon/registry.ts::spawnDaemon); without this fallback the
  // daemon's lockfile/control-DB/emits land in `.tracker` while the spawner
  // watches the isolated root — the daemon never finds its queue.
  const trackerDir = opts.trackerDir ?? process.env.HRAUTO_TRACKER_DIR
  const settingsRoot = opts.repoRoot ?? process.cwd()
  const initialSettingsState = readOperatorSettingsFileState(settingsRoot)
  if (initialSettingsState.state === 'fault') {
    throw new OperatorSettingsFaultError(
      `Daemon ${wf.config.name} refused to start: ${initialSettingsState.error}`,
    )
  }
  const launchFn = opts.sessionLaunchFn ?? Session.launch.bind(Session)
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS
  const idleRepollMs = opts.idleRepollMs ?? DEFAULT_IDLE_REPOLL_MS

  ensureDaemonsDir(trackerDir)
  const instanceId = randomInstanceId(wf.config.name)
  enterDaemonLogContext(wf.config.name, instanceId, trackerDir)

  const state: DaemonState = {
    wakeResolve: null,
    shutdownResolve: null,
    wakePending: false,
    forceShutdown: false,
    drainOnlyShutdown: false,
    shuttingDown: false,
    reassignInFlight: false,
    // Contract 5 Phase 1 — `activeRun` collapses the legacy
    // `inFlight` / `cancelTarget` / `currentRunController` triple into a
    // single `RunHandle` reference. The daemon's claim loop sets this
    // alongside `runRegistry.register(handle)` on each claim and clears
    // it alongside `runRegistry.unregister(handle.runId)` in the per-item
    // finally — the registry's `list()` view is the global source of
    // truth; `state.activeRun` is the daemon's local fast-path lookup.
    activeRun: null,
    queueDepthCache: 0,
    lastActivity: Date.now(),
    phase: 'launching',
    // Session reference exposed to the /status handler so the dashboard
    // (and the spawn pre-check in `daemon-registry`) can inventory which
    // chromium PIDs belong to this daemon. Assigned inside the
    // `withBatchLifecycle` body once `Session.launch` resolves; remains
    // null during `phase === 'launching'`. Force-stop paths can also read
    // it to SIGTERM/SIGKILL chromium directly.
    activeSession: null,
    launchAbort: new AbortController(),
    workerStore: null,
    exitError: null,
    // Captured from the withBatchLifecycle body callback so the outer
    // finally cleanup can emit `item_cancelled` session events for any
    // in-flight or queued items it marks as cancelled. Stays null if the
    // body never ran (e.g. session.launch threw before the callback).
    workflowInstanceForCleanup: null,
  }
  const setPhase = (next: DaemonPhase): void => {
    if (state.phase === next) return
    const prev = state.phase
    state.phase = next
    log.step(`[Daemon ${wf.config.name}/${instanceId}] phase: ${prev} → ${next}`)
    if (state.workflowInstanceForCleanup && (next === 'idle' || next === 'keepalive')) {
      emitDaemonPhase(state.workflowInstanceForCleanup, next, trackerDir)
    }
  }

  const abortLaunchAndKillSession = createAbortLaunchAndKillSession(wf, instanceId, state)

  /**
   * Centralized cancel-request entry point (Contract 5 Phase 1). All three
   * triggers — HTTP `/cancel-current`, worker-command `cancel_task`, and
   * browser-disconnect — funnel through `runRegistry.cancel`, which:
   *   - aborts the active run's per-run `AbortController` (so any in-flight
   *     Playwright call rejects within ms via the Page proxy's
   *     signal-injection), and
   *   - schedules a watchdog that hard-kills chromium after
   *     `hardKillAfterMs` if the run hasn't unregistered by then (covers
   *     the rare case where nothing observes the signal — pre-handler
   *     launch hang, evaluate-only steps).
   *
   * Fire-and-forget: the worker-command poller marks `complete` immediately
   * so the heartbeat tick isn't blocked by the watchdog window. The
   * cancelled tracker row is emitted by the claim loop's per-item
   * cancellation branch once the controller's signal propagates through
   * the stepper.
   */
  const requestCancel = (
    target: { itemId: string; runId: string } | null,
    reason: 'http' | 'worker-command' | 'browser-disconnect',
  ): void => {
    if (!target) return
    if (state.activeRun?.runId !== target.runId) return
    void runRegistry
      .cancel(target.runId, { reason: `daemon_${reason.replace('-', '_')}` })
      .catch((err) => {
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] requestCancel failed for runId=${target.runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
  }
  const workerCtx: WorkerCommandContext<TData, TSteps> = {
    wf,
    instanceId,
    trackerDir,
    state,
    abortLaunchAndKillSession,
    requestCancel,
  }
  const { listenPromise } = startDaemonHttpServer({
    workflowName: wf.config.name,
    instanceId,
    getPhase: () => state.phase,
    getQueueDepthCache: () => state.queueDepthCache,
    getInFlight: () => daemonInFlight(state.activeRun),
    getLastActivity: () => state.lastActivity,
    getShuttingDown: () => state.shuttingDown,
    getActiveSession: () => state.activeSession,
    getWorkerStore: () => state.workerStore,
    setCancelTarget: (target) => {
      requestCancel(target, 'http')
    },
    setForceShutdown: (value) => { state.forceShutdown = value },
    setDrainOnlyShutdown: (value) => { state.drainOnlyShutdown = value },
    setShuttingDown: (value) => { state.shuttingDown = value },
    setReassignInFlight: (value) => { state.reassignInFlight = value },
    resolveWake: () => {
      // Latch the wake if no idle waiter is armed (ISS-008): a `/wake` that
      // lands while the claim loop is NOT parked (top-of-iteration await,
      // processing, or the claim→park window) would otherwise resolve into the
      // void and be lost until the keepalive tick. The check-before-park guard
      // consumes the latch and re-claims immediately.
      if (state.wakeResolve) state.wakeResolve()
      else state.wakePending = true
    },
    resolveShutdown: () => { state.shutdownResolve?.() },
    abortLaunchAndKillSession,
  })
  const httpHandle = await listenPromise
  const port = httpHandle.port

  // Allocate the session-drawer instance name HERE — at lockfile-write time,
  // before `withBatchLifecycle` emits `workflow_start` — and store it in the
  // lockfile (VS-003). A concurrently-spawning peer scans alive lockfiles
  // (`scanAliveDaemonInstanceNames`) to learn the names already claimed by
  // daemons that haven't emitted their `workflow_start` yet, so two daemons
  // spawned near-simultaneously never both pick "<wf> 1". The happens-before
  // edge that makes this deterministic is the PARENT's spawn gate, not the
  // local emit order: the parent's `spawnDaemon` (registry.ts) only resolves
  // once this daemon's lockfile is readable on disk AND `/whoami` answers
  // (`findAliveDaemons` reads the lockfile before probing). So the next daemon
  // cannot start its own allocation until this lockfile — WITH `instanceName`
  // — is durably on disk. (The HTTP listener serving `/whoami` actually comes
  // up earlier, at `await listenPromise` above; it's the lockfile-readable half
  // of the gate, not the listener, that orders allocation.) The name is threaded
  // into `withBatchLifecycle` via `preAssignedInstance` so it does NOT re-derive
  // a (possibly-colliding) name from session events.
  const reservedInstanceNames = scanAliveDaemonInstanceNames(wf.config.name, trackerDir)
  const instanceName = generateInstanceName(wf.config.name, trackerDir, reservedInstanceNames)

  const lock: DaemonLockfile = {
    workflow: wf.config.name,
    instanceId,
    pid: process.pid,
    parentPid: process.ppid,
    port,
    instanceName,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    version: 1,
  }
  const lockPath = lockfilePath(wf.config.name, instanceId, trackerDir)
  writeLockfile(lock, lockPath)
  const controlDb = openControlDb({ trackerDir })
  const taskStore = createTaskStore(controlDb)
  state.workerStore = createWorkerStore(controlDb)
  state.workerStore.registerWorker({
    workerId: instanceId,
    workflow: wf.config.name,
    kind: 'daemon',
    pid: process.pid,
    parentPid: process.ppid,
    hostname: hostname(),
    port,
    instanceId,
    lockfilePath: lockPath,
    phase: state.phase,
    // Short TTL so the dashboard's stale-daemon detection drops dead
    // workers from the session panel within ~15s instead of ~30s. Daemon
    // emits a heartbeat every 5s (heartbeatIntervalMs default), so 15s =
    // 3 heartbeats of margin before "stale" — covers normal GC pauses
    // without flagging a healthy daemon.
    heartbeatTtlMs: 15_000,
  })
  log.step(
    `[Daemon ${wf.config.name}/${instanceId}] listening on 127.0.0.1:${port} (pid=${process.pid})`,
  )

  // Self-heal: if anything (force-stop bypassing the unlink-via-finally,
  // an external cleanup script, a misbehaving sweep) deletes our lockfile
  // while we're still alive, rewrite it on the next tick. Without this, a
  // subsequent dashboard `findAliveDaemons` returns 0, `computeSpawnPlan`
  // recommends a fresh spawn, and the user ends up with a duplicate daemon
  // alongside this one (browsers x2, Duo x2, "Separation 1" recycled).
  // 10s is fast enough that the next dashboard retry sees a restored
  // lockfile within a beat; the writeLockfile cost is ~1KB synchronous
  // disk I/O on a 10s cadence — negligible.
  const lockHealInterval = setInterval(() => {
    if (state.shuttingDown) return
    try {
      if (!existsSync(lockPath)) {
        log.warn(
          `[Daemon ${wf.config.name}/${instanceId}] lockfile missing — restoring`,
        )
        writeLockfile(lock, lockPath)
      }
    } catch (err) {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] lockfile heal failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }, opts.lockHealIntervalMs ?? DEFAULT_LOCK_HEAL_MS)
  lockHealInterval.unref()

  const emitWorkerHeartbeat = createEmitWorkerHeartbeat(workerCtx, taskStore)
  emitWorkerHeartbeat()

  const browserRegistrationState = {
    browsersRegistered: false,
    lastRegisteredInFlight: undefined as import('./daemon-types.js').DaemonInFlight | null | undefined,
  }
  const registerBrowserProcesses = createRegisterBrowserProcesses(workerCtx, browserRegistrationState)
  const recoverClaimsFromDeadOrStaleWorkers = createRecoverClaimsFromDeadOrStaleWorkers(workerCtx)
  const workflowMutationsAllowed = (): boolean =>
    readOperatorSettingsFileState(settingsRoot).state !== 'fault'
  const handleCommand = createHandleWorkerCommand(workerCtx)
  const pollWorkerCommands = createPollWorkerCommands(workerCtx, handleCommand)
  const workerTickInterval = startWorkerTickInterval(
    workerCtx,
    emitWorkerHeartbeat,
    pollWorkerCommands,
    opts.commandPollIntervalMs ?? opts.heartbeatIntervalMs ?? 5_000,
  )

  const { onSigint, onSigterm, onSighup } = installDaemonSignalHandlers(
    wf,
    instanceId,
    state,
    abortLaunchAndKillSession,
  )

  try {
    await withBatchLifecycle(
      {
        workflow: wf.config.name,
        wf,
        archetype: wf.archetype,
        systems: wf.config.systems,
        perItem: [],
        trackerDir,
        ownSigint: false,
        preAssignedInstance: instanceName,
      },
      async ({ instance, markTerminated, makeObserver }) => {
        state.workflowInstanceForCleanup = instance
        // --- auth-timing region (startup) ----------------------------------------
        // Session launch + observer wiring + per-system auth completion live here.
        // auth-start/success/failed session events emit via createBatchObserver
        // (makeObserver); per-item synthetic auth rows are resolved in the claim
        // loop via createDaemonItemAuthTimingResolver (auth-timing.ts). Left
        // inline because launch error handling, phase transitions, and
        // activeSession/onReady hooks share this closure's state.
        const { observer, getAuthTimings } = makeObserver('1')
        setPhase('authenticating')
        let session: Session | undefined
        try {
          session = await launchFn(wf.config.systems, {
            observer,
            abortSignal: state.launchAbort.signal,
            // When the daemon runs at an isolated tracker root, route the
            // session's audit screenshots under it (instead of the real
            // `.tracker/`). Unset → Session falls back to PATHS.screenshotDir.
            ...(trackerDir ? { screenshotDir: screenshotsDir(trackerDir) } : {}),
            onReady: (readySession) => {
              state.activeSession = readySession
              registerBrowserProcesses()
            },
          })
          // Expose to the /status handler + force-stop path. Cleared in
          // the outer `finally` to avoid a stale reference outliving the
          // session's lifetime.
          state.activeSession = session
          registerBrowserProcesses()
          // Force every system's auth to complete at daemon startup so the
          // claim loop doesn't race with in-progress Duo prompts. Rejections
          // propagate to `withBatchLifecycle`'s catch so an auth failure
          // shuts the daemon down cleanly (lockfile unlink, in-flight
          // unclaim) instead of entering the claim loop with a broken
          // session and failing every queued item individually.
          for (const sys of wf.config.systems) {
            await session.page(sys.id)
          }
          for (const sys of wf.config.systems) {
            if (isIdleRefreshSystem(sys.id)) emitIdleSignal(instance, trackerDir, sys.id, 'touch')
          }
        } catch (e) {
          const failedSession = session ?? state.activeSession
          if (failedSession) {
            try {
              await failedSession.close()
            } catch (closeErr) {
              log.warn(
                `[Daemon ${wf.config.name}/${instanceId}] auth-failure session teardown also failed: ${
                  closeErr instanceof Error ? closeErr.message : String(closeErr)
                }`,
              )
            }
          }
          state.activeSession = null
          if (state.shuttingDown && state.launchAbort.signal.aborted) {
            log.warn(
              `[Daemon ${wf.config.name}/${instanceId}] auth/launch aborted by shutdown`,
            )
            state.activeSession = null
            return
          }
          // Surface the failure with structured context so `npm run <wf>:attach`
          // shows an actionable line instead of a silent daemon exit. Classify
          // via the Playwright error taxonomy when the error looks like a browser
          // launch fault (ProcessSingleton, etc.).
          const summary = e instanceof Error ? (e.message ?? String(e)) : String(e)
          log.error(
            `[Daemon ${wf.config.name}/${instanceId}] auth/launch failed during phase='${state.phase}' — ${summary}`,
          )
          throw e
        }

        if (!session) throw new Error(`[Daemon ${instanceId}] session launch returned no session`)

        const itemAuthTimingResolver = createDaemonItemAuthTimingResolver(
          getAuthTimings,
          wf.config.authSteps !== false,
          wf.config.systems,
        )
        // --- end auth-timing region (startup) ------------------------------------

        // Closing any window (user intent) or a browser crash should terminate
        // the daemon — a daemon whose browsers are gone can't serve queued
        // items anyway. Mirrors SIGTERM: set shuttingDown, resolve the idle
        // waiters so the loop exits. In-flight teardown runs in `finally`.
        const unsubscribeDisconnect = session.onBrowserDisconnect((systemId) => {
          // A daemon's lifetime is one Session.launch — there is no
          // re-launch path inside a single daemon process. So we don't
          // bother resetting browsersRegistered / lastRegisteredInFlight
          // here (they'd be dead-code resets). The disconnect just
          // triggers shutdown; the OS reclaims the daemon's state.
          if (state.shuttingDown) return
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] browser disconnected (${systemId}); shutting down`,
          )
          state.shuttingDown = true
          if (state.activeRun) {
            // Route through `requestCancel` so the per-run AbortController
            // is aborted via `runRegistry.cancel(runId)`. Without this, a
            // disconnect during a `waitForSelector` waited the full timeout
            // instead of failing fast. The stepper's catch then reclassifies
            // the AbortError as a cancelled outcome.
            requestCancel(
              {
                itemId: state.activeRun.itemId,
                runId: state.activeRun.runId,
              },
              'browser-disconnect',
            )
          }
          state.shutdownResolve?.()
          state.wakeResolve?.()
        })

        // Orphan recovery on startup: include self in alive set so we don't
        // accidentally unclaim items we just claimed on a previous (crashed)
        // run in the tiny window before writing our own lockfile. SQLite
        // heartbeat staleness wins over a lingering lockfile.
        const recovered = workflowMutationsAllowed()
          ? await recoverClaimsFromDeadOrStaleWorkers()
          : 0
        if (recovered > 0) {
          log.step(`[Daemon ${instanceId}] recovered ${recovered} orphan claim(s)`)
        }

        try {
          // Anchor for the keepalive cadence (ISS-008). The idle park now wakes
          // every `idleRepollMs` for a cheap re-claim, so the heavier keepalive
          // tick (healthCheck + orphan recovery) is gated on having been idle
          // for `idleTimeoutMs` since the last claim OR keepalive — preserving
          // the original ~15-min cadence rather than running it every re-poll.
          let lastIdleKeepaliveAt = Date.now()
          let configurationFaultActive = false
          setPhase('idle')
          emitWorkerHeartbeat()
          while (!state.shuttingDown) {
            await pollWorkerCommands()
            state.queueDepthCache = taskStore.countQueued(wf.config.name)

            const settingsState = readOperatorSettingsFileState(settingsRoot)
            if (settingsState.state === 'fault' && !configurationFaultActive) {
              log.error(
                `[Daemon ${instanceId}] configuration fault; leaving queued work unclaimed — ${settingsState.error}`,
              )
              configurationFaultActive = true
            } else if (settingsState.state !== 'fault' && configurationFaultActive) {
              log.step(`[Daemon ${instanceId}] operator settings repaired; queue claims resumed`)
              configurationFaultActive = false
            }

            const claimed: QueueItem | null | typeof CLAIM_ERROR = state.shuttingDown || configurationFaultActive
              ? null
              : await claimNextItem(
                  wf.config.name,
                  instanceId,
                  trackerDir,
                ).catch((e) => {
                  log.error(
                    `[Daemon ${instanceId}] claim error (queue may have work stuck unclaimed — NOT a genuinely empty queue): ${e instanceof Error ? e.message : String(e)}`,
                  )
                  return CLAIM_ERROR
                })

            if (claimed === CLAIM_ERROR) {
              // Distinguishable signal the caller checks (fail-loud): retry
              // soon on a short fixed delay instead of falling into the same
              // idle park a genuinely empty queue uses below, so a transient
              // fault recovers fast and a persistent one keeps logging loudly
              // every retry rather than going quiet for up to `idleRepollMs`.
              await new Promise<void>((resolve) => {
                setTimeout(resolve, CLAIM_ERROR_RETRY_MS).unref()
              })
              continue
            }
            const item = claimed

            if (item) {
              setPhase('processing')
              if (!item.runId) {
                throw new Error(`Queue invariant violated: task ${item.id} missing runId at claim time`)
              }
              const runId = item.runId
              // Build and register the ONE run handle before handler entry.
              // `runOneItem` receives this exact handle/controller, so a
              // cancel between claim and handler start cannot be lost through
              // a same-runId registry replacement.
              if (item.taskId && item.attemptId) {
                taskStore.markTaskRunning({
                  taskId: item.taskId,
                  attemptId: item.attemptId,
                  workerId: instanceId,
                })
              }
              const preHandle: RunHandle = {
                runId,
                itemId: item.id,
                workflow: wf.config.name,
                controller: new AbortController(),
                session,
                startedAt: Date.now(),
                source: 'daemon',
                ...(item.taskId ? { taskId: item.taskId } : {}),
                ...(item.attemptId ? { attemptId: item.attemptId } : {}),
                ...(item.claimGeneration !== undefined ? { claimGeneration: item.claimGeneration } : {}),
              }
              runRegistry.register(preHandle)
              state.activeRun = preHandle
              registerBrowserProcesses()
              emitWorkerHeartbeat()
              state.lastActivity = Date.now()
              // A claim is activity — reset the keepalive idle anchor so the
              // tick fires only after a genuine `idleTimeoutMs` gap (ISS-008).
              lastIdleKeepaliveAt = Date.now()
              const itemAuthTimings = itemAuthTimingResolver.resolveForNextItem()
              // Carry the run's frozen trace id onto the session card so its
              // subtitle shows the same id as the run's queue row. The pending
              // row (with `data.__traceId`) was pre-emitted at enqueue time, so
              // it's already on disk by the time we claim and start the item.
              const itemTraceId = findFrozenTraceId({
                workflow: wf.config.name,
                runId,
                ...(trackerDir ? { trackerDir } : {}),
              })
              emitItemStart(instance, item.id, trackerDir, runId, itemTraceId)
              let itemTransitionConfirmed = false
              try {
                const r = await runOneItem({
                  wf,
                  session,
                  // No cast: runOneItem validates `item` via wf.config.schema.parse
                  // before invoking the handler, so the claim loop hands the raw
                  // input straight through.
                  item: item.input,
                  itemId: item.id,
                  runId,
                  trackerDir,
                  callerPreEmits: false,
                  preAssignedInstance: instance,
                  authTimings: itemAuthTimings,
                  // Contract 5 Phase 1: the controller is the source of truth.
                  // `runOneItem` constructs its own + re-registers the handle
                  // with the registry; the worker-command path and HTTP
                  // /cancel-current call `runRegistry.cancel(runId)` which
                  // aborts that controller. The stepper's between-step probe
                  // reads `controller.signal.aborted` instead of a daemon
                  // state field.
                  ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                  ...(item.taskId ? { taskId: item.taskId } : {}),
                  ...(item.attemptId ? { attemptId: item.attemptId } : {}),
                  runHandleSource: 'daemon',
                  runHandle: preHandle,
                  runHandleOwner: 'caller',
                })
                emitItemComplete(instance, item.id, trackerDir, runId)
                for (const sys of wf.config.systems) {
                  if (isIdleRefreshSystem(sys.id)) emitIdleSignal(instance, trackerDir, sys.id, 'touch')
                }
                markTerminated(runId)
                const taskStateAfterRun = item.taskId ? taskStore.getTask(item.taskId)?.state : null
              // Cancellation precedence: if a cancel was requested at any
              // point during the run (signaled by the per-run controller
              // being aborted, OR by a SQLite task-state transition), the
              // item is cancelled — regardless of whether the step happened
              // to finish successfully or threw an unrelated error. Without
              // this, a step that completes in the same instant as the user
              // clicks cancel races: r.ok=true → marked Done → cancelled
              // tracker row from the dashboard gets overwritten. Cancel
              // always wins over both done and failure.
                const cancelRequestedForThisItem =
                  state.activeRun?.controller.signal.aborted === true ||
                  taskStateAfterRun === 'cancelled' ||
                  taskStateAfterRun === 'cancel_requested' ||
                  taskStateAfterRun === 'cancelling'
                const isCancelOutcome = cancelRequestedForThisItem || (!r.ok && r.kind === 'cancelled')

                const terminalizeNormalOutcome = async (
                  desiredState: 'done' | 'failed',
                  error?: string,
                ): Promise<TerminalizationResult> => {
                  if (!item.taskId || !item.attemptId || item.claimGeneration === undefined) {
                    return { kind: 'not-found' }
                  }
                  while (true) {
                    const outcome = await terminalizeWithReconciliation({
                      desiredState,
                      transition: () => desiredState === 'done'
                        ? markItemDone(
                            wf.config.name, item.id, runId, trackerDir,
                            item.claimGeneration, instanceId,
                          )
                        : markItemFailed(
                            wf.config.name, item.id, error ?? '', runId, trackerDir,
                            item.claimGeneration, instanceId,
                          ),
                      readTask: () => taskStore.getTask(item.taskId!),
                      blockUncertain: (reason) => taskStore.markTaskBlockedUncertain({
                        taskId: item.taskId!,
                        attemptId: item.attemptId!,
                        workerId: instanceId,
                        claimGeneration: item.claimGeneration!,
                        error: reason,
                      }),
                    })
                    if (outcome.kind === 'not-found') {
                      throw new Error(
                        `[Daemon ${instanceId}] terminalization target ${item.taskId} disappeared; ` +
                        `refusing to claim another item`,
                      )
                    }
                    if (outcome.kind === 'lease-lost') {
                      const current = taskStore.getTask(item.taskId)
                      const positivelyHandedOff = current !== null && (
                        current.state === 'queued' || current.state === 'done' ||
                        current.state === 'failed' || current.state === 'cancelled' ||
                        current.state === 'blocked' ||
                        (current.claimedByWorkerId !== undefined && current.claimedByWorkerId !== instanceId)
                      )
                      if (positivelyHandedOff) return outcome
                    } else if (outcome.kind !== 'unconfirmed') {
                      return outcome
                    }
                    log.error(
                      `[Daemon ${instanceId}] terminalization remains unconfirmed for ${item.id}; ` +
                      `retaining the run and retrying before another item can be claimed: ${
                        outcome.kind === 'unconfirmed'
                          ? outcome.error
                          : 'lease-lost outcome had no visible handoff or terminal state'
                      }`,
                    )
                    await new Promise<void>((resolve) => setTimeout(resolve, 250))
                  }
                }

                if (isCancelOutcome) {
                  // An aborted controller surfaces three distinct stop intents.
                  // Resolve the live peer set ONCE (only when a stop is in
                  // play — a deliberate /cancel-current leaves the daemon alive
                  // and never needs it). The lockfile is still on disk here
                  // (unlinked later in runDaemonShutdownCleanup), so self is in
                  // the alive set — filter it out to get true peers.
                  const peers =
                    state.reassignInFlight || state.forceShutdown
                      ? (await findAliveDaemons(wf.config.name, trackerDir)).filter(
                          (d) => d.instanceId !== instanceId,
                        )
                      : []
                  // Reassign is only SAFE if a peer will ACTUALLY claim the
                  // item. `findAliveDaemons` deliberately trusts an
                  // unreachable-but-PID-alive lockfile (a wedged/zombie daemon
                  // whose event loop never wakes), so requeuing to one parks
                  // the item `queued` forever. Use the SAME authority the queued
                  // sweep does (`filterPeersAvailableForHandoff`): responsive
                  // `/whoami` MATCH **and** not itself shutting down. A peer that
                  // already received `/stop` answers `/whoami` but will NOT claim
                  // new work, so two concurrent per-instance stops must not
                  // reassign to each other (it would park the item until this
                  // daemon's own queued sweep re-fails it). Otherwise fail loud
                  // below (F5). Only probe when reassign is actually requested.
                  const responsivePeers =
                    state.reassignInFlight && peers.length > 0 && Boolean(item.taskId)
                      ? await filterPeersAvailableForHandoff(peers)
                      : []
                  // Normalized identity for the shared reassign/fail helpers.
                  const shutdownItem = {
                    itemId: item.id,
                    runId,
                    ...(item.taskId ? { taskId: item.taskId } : {}),
                    ...(item.attemptId ? { attemptId: item.attemptId } : {}),
                    workerId: instanceId,
                    ...(item.claimGeneration !== undefined ? { claimGeneration: item.claimGeneration } : {}),
                    input: item.input,
                    ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                  }
                  // ONE decision authority shared with the shutdown sweep — see
                  // `teardown-transition.ts`. The bodies below stay per-site.
                  const action = resolveTeardownTransition({
                    reassignInFlight: state.reassignInFlight,
                    forceShutdown: state.forceShutdown,
                    hasTaskId: Boolean(item.taskId),
                    responsivePeerCount: responsivePeers.length,
                    pidAlivePeerCount: peers.length,
                  })
                  if (action.kind === 'reassign' && item.taskId) {
                    // Per-instance stop with a RESPONSIVE peer → hand the item
                    // back to the queue and wake the peers so an idle one
                    // finishes it. The attempt (and thus runId) is preserved by
                    // returnTaskToQueued, so the run continues under the same id
                    // on the new daemon. No terminal row, no dependency settle —
                    // the work isn't done, just moving.
                    await reassignInFlightItem({
                      wf,
                      item: { ...shutdownItem, taskId: item.taskId },
                      responsivePeers,
                      taskStore,
                      trackerDir,
                      logTag: `Daemon ${instanceId}`,
                    })
                  } else if (action.kind === 'fail') {
                    if (action.reason === 'no-responsive-peer') {
                      // Reassign requested, a peer LOOKS alive (PID + lockfile),
                      // but none answered `/whoami` — wedged/zombie. Fail the item
                      // loudly (red, retriable) rather than requeue it to a daemon
                      // that will never claim it. Same fail shape as a no-peer
                      // force-stop (F5 fail-loud).
                      log.warn(
                        `[Daemon ${instanceId}] per-instance stop — ${peers.length} peer(s) appeared alive but none responded to /whoami; failing in-flight item ${item.id} instead of parking it`,
                      )
                    }
                    // no-daemon: force-stop with no spare to absorb the item
                    // (stop-all, SIGINT/SIGTERM, or the last daemon stopped
                    // per-instance). Either way the operator asked to SEE these
                    // fail, so emit a real failed row (NO step:"cancelled"
                    // sentinel → red Failed badge, retriable), not the orange
                    // Cancelled used for a deliberate per-item cancel.
                    await failInFlightItem({
                      wf,
                      item: shutdownItem,
                      failReason:
                        action.reason === 'no-responsive-peer'
                          ? SHUTDOWN_NO_RESPONSIVE_PEER_FAIL_REASON
                          : SHUTDOWN_NO_DAEMON_FAIL_REASON,
                      taskStore,
                      trackerDir,
                      claimTerminalWrite: () => runRegistry.claimTerminalWrite(runId),
                      commitTerminalWrite: () => runRegistry.commitTerminalWrite(runId),
                      rollbackTerminalWrite: () => runRegistry.rollbackTerminalWrite(runId),
                    })
                  } else {
                    // Deliberate per-item cancel (/cancel-current); the daemon
                    // stays alive and claims the next item. Renders Cancelled
                    // (orange) via the step:"cancelled" sentinel.
                    const cancelError =
                      !r.ok && r.kind === 'cancelled'
                        ? r.error
                        : 'cancelled by user from dashboard'
                    const cancelOutcome = await markItemCancelled(
                      wf.config.name, item.id, cancelError, runId, trackerDir,
                      item.claimGeneration, instanceId,
                    )
                    if (item.taskId && cancelOutcome.kind === 'applied') {
                      const released = taskStore.markDependencyFromChildTerminal({
                        childTaskId: item.taskId,
                        childState: 'cancelled',
                      })
                      void wakeDaemonsForReleasedParents(released, trackerDir)
                    }
                    // E2E-101: this daemon branch owns the SINGLE rich terminal
                    // cancelled row. The kernel's `withTrackedWorkflow` catch
                    // SUPPRESSES its own (sparse) cancelled row for any
                    // daemon-path cancel (`cancelOrigin` is set — see
                    // `run-one-item`'s `suppressTerminalRowOnCancel`), so this
                    // row — rebuilt with full display data via
                    // `buildShutdownTrackerData` (e.g. OCR's file-kind title) —
                    // is the run's sole terminal. Claim the terminal token as
                    // defense in depth (if the kernel ever did write, we'd defer
                    // rather than double-write); under the suppression above the
                    // token is free here, so we write. Overwrites a racing
                    // `done` row (handler returned r.ok=true the same instant the
                    // cancel landed) so the badge shows Cancelled.
                    if (cancelOutcome.kind === 'applied' && runRegistry.claimTerminalWrite(runId)) {
                      try {
                        emitTrackerRow(
                          {
                          workflow: wf.config.name,
                          timestamp: new Date().toISOString(),
                          id: item.id,
                          runId,
                          status: 'failed',
                          step: 'cancelled',
                          // buildShutdownTrackerData always stamps `data.archetype`
                          // (via buildHttpPendingData or its fallback path) so the
                          // returned record satisfies StampedData at runtime.
                          data: buildShutdownTrackerData(wf, item.input, item.parentRunId, {
                            runId,
                            trackerDir,
                          }) as StampedData,
                          ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                          error: cancelError,
                        },
                          trackerDir,
                        )
                        runRegistry.commitTerminalWrite(runId)
                      } catch (emitErr) {
                        runRegistry.rollbackTerminalWrite(runId)
                        throw emitErr
                      }
                    }
                    emitItemCancelled(instance, item.id, cancelError, trackerDir, runId)
                  }
                } else if (r.ok) {
                  // Stale-completion guard (ISS-005): pass the lease this worker
                  // captured at claim time. If a Stop-All / per-instance-stop
                  // teardown re-pended this item and a peer re-claimed it, the
                  // task's `claim_generation` has advanced past `item.claimGeneration`
                  // — so this (stopped) instance's completion is a no-op in
                  // SQLite, and the peer's terminal is the single real one. The
                  // dependency settle is then skipped when the guarded mark did
                  // not actually terminalize this task.
                  const terminal = await terminalizeNormalOutcome('done')
                  if (terminal.kind === 'blocked-uncertain') {
                    // Intentional corrective terminal event: the kernel may
                    // already have emitted `done`, but SQLite could not confirm
                    // that terminal outcome. This later failed row must override
                    // it visibly; it is the one deliberate exception to the
                    // run-registry's single-terminal presentation fence.
                    emitTrackerRow({
                      workflow: wf.config.name,
                      timestamp: new Date().toISOString(),
                      id: item.id,
                      runId,
                      status: 'failed',
                      step: 'terminalization-uncertain',
                      data: buildShutdownTrackerData(wf, item.input, item.parentRunId, { runId, trackerDir }) as StampedData,
                      ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                      error: terminal.error,
                    }, trackerDir)
                  }
                  if (
                    item.taskId &&
                    (terminal.kind === 'applied' || terminal.kind === 'reconciled') &&
                    taskStore.getTask(item.taskId)?.state === 'done'
                  ) {
                    const released = taskStore.markDependencyFromChildTerminal({
                      childTaskId: item.taskId,
                      childState: 'done',
                    })
                    // Wake the released parents' daemons NOW — a parent on
                    // another workflow's daemon (oath-upload waiting on this
                    // signer) would otherwise sit queued until that daemon's
                    // 15-min keepalive tick (E2E-017).
                    void wakeDaemonsForReleasedParents(released, trackerDir)
                  }
                } else {
                  const terminal = await terminalizeNormalOutcome('failed', r.error)
                  if (terminal.kind === 'blocked-uncertain') {
                    // See the success branch above: this is a corrective
                    // terminal override, not a competing ordinary emitter.
                    emitTrackerRow({
                      workflow: wf.config.name,
                      timestamp: new Date().toISOString(),
                      id: item.id,
                      runId,
                      status: 'failed',
                      step: 'terminalization-uncertain',
                      data: buildShutdownTrackerData(wf, item.input, item.parentRunId, { runId, trackerDir }) as StampedData,
                      ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
                      error: terminal.error,
                    }, trackerDir)
                  }
                  if (
                    item.taskId &&
                    (terminal.kind === 'applied' || terminal.kind === 'reconciled') &&
                    taskStore.getTask(item.taskId)?.state === 'failed'
                  ) {
                    const released = taskStore.markDependencyFromChildTerminal({
                      childTaskId: item.taskId,
                      childState: 'failed',
                    })
                    void wakeDaemonsForReleasedParents(released, trackerDir)
                  }
                }
                // Reset every system's page to its `resetUrl` after a
                // cancelled item — leaves the daemon's auth intact but
                // returns the workflow surface to a clean starting state
                // for the next claim. Reset failures are best-effort: a
                // failed reset won't block the next item from claiming.
                // Fires only for a per-item cancel where the daemon STAYS
                // alive and will claim the next item. On a stop (reassign or
                // fail), the daemon is tearing chromium down, so resetting
                // pages is pointless and would just log best-effort warnings.
                if (isCancelOutcome && !state.shuttingDown) {
                  for (const sys of wf.config.systems) {
                    try {
                      await session.reset(sys.id)
                    } catch (resetErr) {
                      log.warn(
                        `[Daemon ${instanceId}] post-cancel reset(${sys.id}) failed: ${
                          resetErr instanceof Error ? resetErr.message : String(resetErr)
                        }`,
                      )
                    }
                  }
                }
              } finally {
                // Per-item cleanup MUST run on both happy and throw paths
                // (Finding #9). If `runOneItem` throws — e.g. the schema
                // validation error at run-one-item.ts that fires BEFORE the
                // controller setup — `state.activeRun` would otherwise stay
                // populated, and a late `/cancel-current` would abort the
                // dead controller from the previous item.
                //
                // Daemon calls pass a caller-owned RunHandle, so this claim
                // loop owns unregistering it. Keep it registered until the
                // task store confirms the terminal/requeue/peer transition;
                // the outer shutdown sweep can still abort a retained handle.
                const taskAfterCleanup = item.taskId ? taskStore.getTask(item.taskId) : null
                const transitionConfirmed = !item.taskId || (
                  taskAfterCleanup !== null && (
                    taskAfterCleanup.state === 'done' ||
                    taskAfterCleanup.state === 'failed' ||
                    taskAfterCleanup.state === 'cancelled' ||
                    taskAfterCleanup.state === 'blocked' ||
                    taskAfterCleanup.state === 'queued' ||
                    (taskAfterCleanup.claimedByWorkerId !== undefined && taskAfterCleanup.claimedByWorkerId !== instanceId)
                  )
                )
                if (!transitionConfirmed) {
                  log.error(
                    `[Daemon ${instanceId}] retaining RunHandle ${runId}: task transition is not confirmed ` +
                    `(state=${taskAfterCleanup?.state ?? 'missing'})`,
                  )
                } else {
                  itemTransitionConfirmed = true
                  runRegistry.unregister(runId)
                  // Release the single-terminal token now that this item's
                  // three-way teardown/cancel branch has had its chance to read
                  // it (E2E-101). Deferred to here — not `unregister` — because
                  // the kernel claims+emits INSIDE `runOneItem` and the daemon
                  // branch reads the token AFTER `runOneItem` returns; clearing it
                  // any earlier would let the daemon branch double-write.
                  runRegistry.releaseTerminalWrite(runId)
                  state.activeRun = null
                }
              }
              if (!itemTransitionConfirmed) {
                throw new Error(
                  `[Daemon ${instanceId}] refusing to return idle after unconfirmed transition for ${item.id}`,
                )
              }
              setPhase('idle')
              emitWorkerHeartbeat()
              continue
            }

            // Idle: wait for a wake, a bounded re-poll tick, or shutdown. Park
            // for the SOONER of `idleRepollMs` (cheap re-claim backstop) and
            // `idleTimeoutMs` (keepalive cadence); the keepalive itself is gated
            // below so the shorter re-poll doesn't run it every tick (ISS-008).
            const parkMs = Math.max(1, Math.min(idleRepollMs, idleTimeoutMs))
            await new Promise<void>((resolve) => {
              // Check-before-park (ISS-006): `/stop` (and the worker stop
              // command) set `state.shuttingDown` then call
              // `resolveWake()`/`resolveShutdown()` — but those resolves are
              // NO-OPS whenever the waiters are null, which they ARE while the
              // loop was suspended at the top-of-iteration awaits
              // (`pollWorkerCommands` / `claimNextItem`) just before this
              // re-park. If shutdown landed in that window, the resolves
              // already fired into the void; without this synchronous guard
              // we'd arm fresh waiters and park for the FULL `idleTimeoutMs`
              // before the next `if (state.shuttingDown) break` ever runs.
              // Mirror the browser-disconnect handler above (which resolves
              // these same waiters) and the e2e abort-signal gate
              // (`core/e2e/gates.ts`): observe the terminal flag BEFORE arming.
              if (state.shuttingDown) {
                resolve()
                return
              }
              // Latched wake (ISS-008): a `/wake` arrived with no waiter armed
              // (resolveWake set `wakePending` instead of resolving into the
              // void). Consume it here and resolve so the loop re-polls +
              // re-claims immediately rather than parking past the new work.
              if (state.wakePending) {
                state.wakePending = false
                resolve()
                return
              }
              state.wakeResolve = (): void => {
                state.wakeResolve = null
                resolve()
              }
              state.shutdownResolve = (): void => {
                state.shutdownResolve = null
                resolve()
              }
              setTimeout(() => {
                state.wakeResolve = null
                state.shutdownResolve = null
                resolve()
              }, parkMs).unref()
            })

            if (state.shuttingDown) break
            await pollWorkerCommands()

            // Keepalive tick (recover orphans + healthCheck each system) runs on
            // the long idle cadence only — the park wakes every `idleRepollMs`
            // for a cheap re-claim, so only run the heavier keepalive once the
            // daemon has been genuinely idle for `idleTimeoutMs` (ISS-008).
            if (Date.now() - lastIdleKeepaliveAt >= idleTimeoutMs) {
              setPhase('keepalive')
              await runKeepaliveTick({
                instanceId,
                session,
                systems: wf.config.systems,
                recoverOrphanedClaims: async () => workflowMutationsAllowed()
                  ? recoverClaimsFromDeadOrStaleWorkers()
                  : 0,
              })
              setPhase('idle')
              lastIdleKeepaliveAt = Date.now()
            }
          }
        } finally {
          setPhase('draining')
          unsubscribeDisconnect()
          try {
            await session.close()
          } catch {
            /* best-effort */
          }
          // Clear the /status reference so a request that races between
          // session close and lockfile unlink doesn't see a stale Session
          // and try to read its (now-empty) chromePids.
          state.activeSession = null
        }
      },
    )
  } catch (err) {
    state.exitError = err
    throw err
  } finally {
    await runDaemonShutdownCleanup({
      wf,
      instanceId,
      trackerDir,
      state,
      taskStore,
      lockPath,
      lockHealInterval,
      workerTickInterval,
      onSigint,
      onSigterm,
      onSighup,
      httpHandle,
      setPhase,
    })
  }
}
