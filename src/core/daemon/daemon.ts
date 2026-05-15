import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, unlinkSync } from 'node:fs'
import type { RegisteredWorkflow } from '../kernel/types.js'
import { Session } from '../kernel/session.js'
import { runOneItem } from '../kernel/workflow.js'
import { withBatchLifecycle } from '../kernel/batch-lifecycle.js'
import { log } from '../../utils/log.js'
import {
  lockfilePath,
  randomInstanceId,
  writeLockfile,
  findAliveDaemons,
  ensureDaemonsDir,
} from './registry.js'
import {
  claimNextItem,
  markItemCancelled,
  markItemDone,
  markItemFailed,
  recoverOrphanedClaims,
  readQueueState,
} from './queue.js'
import type { DaemonLockfile } from './types.js'
import {
  emitItemStart,
  emitItemComplete,
  emitItemCancelled,
  emitDaemonPhase,
  emitUcpathIdleSignal,
} from '../../tracker/session-events.js'
import {
  trackEvent,
  dateLocal,
  DEFAULT_DIR,
  findLatestEntryForRunOnDate,
  isTerminalTrackerEntryStatus,
} from '../../tracker/jsonl.js'
import { buildTrackerDataForInput } from './enqueue-dispatch.js'
import { openControlDb } from '../control-db.js'
import { createTaskStore } from '../task-store/index.js'
import { isStateDbReady, openStateDb } from '../../tracker/state/db.js'
import { createWorkerStore, type ControlWorkerStore, type WorkerCommandRow } from './worker-store.js'
import { startDaemonHttpServer } from './http.js'
import { runKeepaliveTick } from './keepalive.js'

export interface DaemonOpts {
  trackerDir?: string
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
}

const DEFAULT_IDLE_MS = 15 * 60 * 1000
const DEFAULT_LOCK_HEAL_MS = 10_000

/**
 * Daemon lifecycle phases — exposed via /status so CLI callers and
 * `npm run daemon-attach` can see what the daemon is doing at any moment.
 * Helps diagnose "browsers don't launch" (stuck in `authenticating`) vs
 * "queue isn't processing" (stuck in `idle` with queueDepth > 0) vs
 * "healthCheck hung" (stuck in `keepalive`).
 */
export type DaemonPhase =
  | 'launching'      // before session.launch
  | 'authenticating' // during session.launch + per-system page() waits
  | 'idle'           // claim loop, no item in flight
  | 'processing'     // runOneItem in progress
  | 'keepalive'      // 15min idle tick: healthCheck + orphan recovery
  | 'draining'       // shutdown, finishing in-flight teardown
  | 'exited'         // terminal

type DaemonInFlight = { itemId: string; runId: string; taskId?: string; attemptId?: string }

interface DaemonState {
  wakeResolve: (() => void) | null
  shutdownResolve: (() => void) | null
  forceShutdown: boolean
  drainOnlyShutdown: boolean
  shuttingDown: boolean
  inFlight: DaemonInFlight | null
  queueDepthCache: number
  lastActivity: number
  phase: DaemonPhase
  activeSession: Session | null
  launchAbort: AbortController
  workerStore: ControlWorkerStore | null
  exitError: unknown
  cancelTarget: { itemId: string; runId: string } | null
  workflowInstanceForCleanup: string | null
}

/**
 * Long-running daemon loop. Must be invoked from a DETACHED process via
 * `src/cli-daemon.ts`. Owns:
 *   - HTTP server for /whoami /status /wake /stop
 *   - Lockfile write + cleanup on shutdown
 *   - Session lifetime (one `Session.launch` on startup, `session.close`
 *     on shutdown)
 *   - Shared-queue claim loop with 15-min keepalive + orphan recovery
 *   - SIGINT/SIGTERM handlers — in-flight item always marked failed
 *     (no graceful re-queue path as of 2026-04-28; per Cluster A spec
 *     every shutdown is force semantics). Queued items also fail via
 *     the outer-finally cleanup.
 *
 * Does NOT install its own SIGINT handler via withBatchLifecycle —
 * we pass `ownSigint: false` so batch-lifecycle skips its
 * process.exit(130) and lets us run our own teardown first.
 */
export async function runWorkflowDaemon<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  opts: DaemonOpts = {},
): Promise<void> {
  const trackerDir = opts.trackerDir
  const launchFn = opts.sessionLaunchFn ?? Session.launch.bind(Session)
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_MS

  ensureDaemonsDir(trackerDir)
  const instanceId = randomInstanceId(wf.config.name)

  const state: DaemonState = {
    wakeResolve: null,
    shutdownResolve: null,
    forceShutdown: false,
    drainOnlyShutdown: false,
    shuttingDown: false,
    inFlight: null,
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
    // Cooperative-cancel signal for the in-flight item. Set by the
    // POST /cancel-current handler when itemId+runId match the current
    // in-flight item; cleared after the next item starts. Stepper checks
    // this at every step boundary and throws CancelledError.
    cancelTarget: null,
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

  const abortLaunchAndKillSession = (reason: string): void => {
    if (!state.launchAbort.signal.aborted) {
      state.launchAbort.abort(new Error(reason))
    }
    const session = state.activeSession
    if (!session) return
    session.killChromeHard(2_000).catch((err) => {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] killChromeHard after abort failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }

  /**
   * Chrome-preserving interrupt of in-flight Playwright work. Navigates each
   * system's active page to about:blank, which causes any pending await
   * (click, fill, waitForSelector, navigation, etc.) to reject with a
   * navigation/closed error. Browser context (auth/cookies) survives, so
   * the daemon stays usable for the next item. Best-effort: errors
   * swallowed because the caller's only job is "do not let the in-flight
   * work continue silently."
   */
  const interruptInFlightWork = (): void => {
    const session = state.activeSession
    if (!session) return
    for (const sys of wf.config.systems) {
      ;(async (): Promise<void> => {
        try {
          const page = await session.page(sys.id)
          // 2s timeout — about:blank is essentially instant when chrome is
          // healthy. Longer waits hold up the cancel response unnecessarily.
          await page.goto('about:blank', { timeout: 2_000 }).catch(() => {})
        } catch {
          /* best-effort */
        }
      })().catch(() => {
        /* best-effort */
      })
    }
  }

  const { listenPromise } = startDaemonHttpServer({
    workflowName: wf.config.name,
    instanceId,
    getPhase: () => state.phase,
    getQueueDepthCache: () => state.queueDepthCache,
    getInFlight: () => state.inFlight,
    getLastActivity: () => state.lastActivity,
    getActiveSession: () => state.activeSession,
    getWorkerStore: () => state.workerStore,
    setCancelTarget: (target) => { state.cancelTarget = target },
    setForceShutdown: (value) => { state.forceShutdown = value },
    setDrainOnlyShutdown: (value) => { state.drainOnlyShutdown = value },
    setShuttingDown: (value) => { state.shuttingDown = value },
    resolveWake: () => { state.wakeResolve?.() },
    resolveShutdown: () => { state.shutdownResolve?.() },
    abortLaunchAndKillSession,
    interruptInFlightWork,
  })
  const httpHandle = await listenPromise
  const port = httpHandle.port

  const lock: DaemonLockfile = {
    workflow: wf.config.name,
    instanceId,
    pid: process.pid,
    parentPid: process.ppid,
    port,
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
  const emitWorkerHeartbeat = (): void => {
    try {
      state.workerStore?.heartbeatWorker({
        workerId: instanceId,
        phase: state.phase,
        currentTaskId: state.inFlight?.taskId ?? null,
        currentAttemptId: state.inFlight?.attemptId ?? null,
        queueDepth: state.queueDepthCache,
        payload: { itemId: state.inFlight?.itemId ?? null, runId: state.inFlight?.runId ?? null },
      })
    } catch (err) {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] heartbeat failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  emitWorkerHeartbeat()

  const sigHandler = (sig: string): void => {
    log.warn(`[Daemon ${wf.config.name}/${instanceId}] received ${sig}; shutting down`)
    state.shuttingDown = true
    state.forceShutdown = true
    state.drainOnlyShutdown = false
    abortLaunchAndKillSession(`Daemon received ${sig}`)
    state.shutdownResolve?.()
    state.wakeResolve?.()
  }
  const onSigint = (): void => sigHandler('SIGINT')
  const onSigterm = (): void => sigHandler('SIGTERM')
  // SIGHUP: closing the parent terminal sends SIGHUP to its foreground
  // process group. Detached daemons usually ignore it, but spawning
  // configurations that don't fully detach (or that share a session id)
  // will see it. Treat it identically to SIGTERM so the daemon runs its
  // teardown instead of being orphaned with stale lockfile + worker rows.
  const onSighup = (): void => sigHandler('SIGHUP')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  process.on('SIGHUP', onSighup)

  // Track the last inFlight state when browser PIDs were registered. chromePids
  // don't change between claims, so skip redundant upserts unless the inFlight
  // task changed (a new claim brings a new taskId/attemptId that must be
  // stamped onto the existing browser_process row). Reset to null on browser
  // disconnect so the next Session.launch re-registers fresh PIDs.
  // Initialized to a sentinel (undefined, distinct from null) so the first call
  // always runs even when inFlight is null (pre-claim startup registrations).
  let lastRegisteredInFlight: { itemId: string; runId: string; taskId?: string; attemptId?: string } | null | undefined = undefined
  let browsersRegistered = false
  const registerBrowserProcesses = (): void => {
    if (!state.activeSession || !state.workerStore) return
    // Skip if pids are already registered for the same inFlight task.
    if (browsersRegistered && state.inFlight === lastRegisteredInFlight) return
    for (const [systemId, pid] of Object.entries(state.activeSession.chromePids)) {
      const sys = wf.config.systems.find((s) => s.id === systemId)
      state.workerStore.upsertBrowserProcess({
        workerId: instanceId,
        workflow: wf.config.name,
        systemId,
        browserId: systemId,
        pid,
        ...(state.inFlight?.taskId ? { taskId: state.inFlight.taskId } : {}),
        ...(state.inFlight?.attemptId ? { attemptId: state.inFlight.attemptId } : {}),
        ...(sys?.sessionDir ? { sessionDir: sys.sessionDir } : {}),
      })
    }
    browsersRegistered = true
    lastRegisteredInFlight = state.inFlight
  }

  const handleCommand = async (command: WorkerCommandRow): Promise<void> => {
    const workerStore = state.workerStore
    if (!workerStore) return
    try {
      if (command.commandType === 'cancel_task') {
        if (
          !state.inFlight ||
          (command.targetTaskId && command.targetTaskId !== state.inFlight.taskId) ||
          (command.targetAttemptId && command.targetAttemptId !== state.inFlight.attemptId)
        ) {
          workerStore.failCommand(command.commandId, 'task not in flight on this worker')
          return
        }
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        state.cancelTarget = { itemId: state.inFlight.itemId, runId: state.inFlight.runId }
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'force_stop_task') {
        if (
          !state.inFlight ||
          (command.targetTaskId && command.targetTaskId !== state.inFlight.taskId) ||
          (command.targetAttemptId && command.targetAttemptId !== state.inFlight.attemptId)
        ) {
          workerStore.failCommand(command.commandId, 'task not in flight on this worker')
          return
        }
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        state.cancelTarget = { itemId: state.inFlight.itemId, runId: state.inFlight.runId }
        state.forceShutdown = true
        state.drainOnlyShutdown = false
        state.shuttingDown = true
        workerStore.markWorkerStatus({ workerId: instanceId, status: 'draining', phase: 'draining' })
        abortLaunchAndKillSession('Daemon force-stop task requested')
        state.shutdownResolve?.()
        state.wakeResolve?.()
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'drain_worker') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        workerStore.markWorkerStatus({ workerId: instanceId, status: 'draining', phase: 'draining' })
        state.drainOnlyShutdown = true
        state.shuttingDown = true
        state.wakeResolve?.()
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'stop_worker') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        state.forceShutdown = true
        state.drainOnlyShutdown = false
        state.shuttingDown = true
        state.wakeResolve?.()
        state.shutdownResolve?.()
        abortLaunchAndKillSession('Daemon worker stop requested')
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'kill_browser') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        const browser = command.targetBrowserProcessId
          ? workerStore.findBrowserProcessById(command.targetBrowserProcessId)
          : null
        if (!browser) {
          workerStore.failCommand(command.commandId, 'browser process not found')
          return
        }
        workerStore.markBrowserProcessKillRequested({
          browserProcessId: browser.browserProcessId,
          commandId: command.commandId,
        })
        try {
          process.kill(browser.pid, 'SIGTERM')
          workerStore.markBrowserProcessTerminated({ browserProcessId: browser.browserProcessId })
          workerStore.completeCommand(command.commandId)
        } catch (err) {
          workerStore.markBrowserProcessLost({ browserProcessId: browser.browserProcessId })
          workerStore.failCommand(command.commandId, err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (command.commandType === 'health_check') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        if (!state.activeSession) throw new Error('session not ready')
        for (const sys of wf.config.systems) {
          await state.activeSession.healthCheck(sys.id)
        }
        workerStore.completeCommand(command.commandId)
      }
    } catch (err) {
      workerStore.failCommand(command.commandId, err instanceof Error ? err.message : String(err))
    }
  }

  const pollWorkerCommands = async (): Promise<void> => {
    if (!state.workerStore) return
    const commands = state.workerStore.listQueuedCommandsForWorker(instanceId)
    for (const command of commands) {
      await handleCommand(command)
    }
  }

  const recoverClaimsFromDeadOrStaleWorkers = async (): Promise<number> => {
    const alive = await findAliveDaemons(wf.config.name, trackerDir)
    const aliveSet = new Set(alive.map((d) => d.instanceId))
    aliveSet.add(instanceId)
    const staleWorkers = state.workerStore
      ? state.workerStore.listStaleWorkers({}).filter((w) => w.workflow === wf.config.name && w.workerId !== instanceId)
      : []
    for (const stale of staleWorkers) {
      state.workerStore?.markWorkerStatus({ workerId: stale.workerId, status: 'stale', phase: stale.phase })
      aliveSet.delete(stale.workerId)
    }
    return recoverOrphanedClaims(wf.config.name, aliveSet, trackerDir)
  }

  const workerTickInterval = setInterval(() => {
    emitWorkerHeartbeat()
    void pollWorkerCommands().catch((err) => {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] command poll failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }, opts.commandPollIntervalMs ?? opts.heartbeatIntervalMs ?? 5_000)
  workerTickInterval.unref()

  try {
    await withBatchLifecycle(
      {
        workflow: wf.config.name,
        systems: wf.config.systems,
        perItem: [],
        trackerDir,
        ownSigint: false,
      },
      async ({ instance, markTerminated, makeObserver }) => {
        state.workflowInstanceForCleanup = instance
        const { observer, getAuthTimings } = makeObserver('1')
        setPhase('authenticating')
        let session: Session
        try {
          session = await launchFn(wf.config.systems, {
            authChain: wf.config.authChain,
            observer,
            abortSignal: state.launchAbort.signal,
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
          if (wf.config.systems.some((s) => s.id === 'ucpath')) {
            emitUcpathIdleSignal(instance, trackerDir, 'touch')
          }
        } catch (e) {
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

        // Snapshot the real auth timings now that every system has finished
        // authenticating. We inject these into the FIRST queued item only so
        // its step pipeline shows the actual per-system Duo durations. Every
        // subsequent item gets synthesized zero-duration timings anchored at
        // its own claim time — auth really was free for those items (the
        // daemon reuses the session), so "Authenticating (4) — 0s" is the
        // truthful display. Passing the real startup timings to item #N would
        // re-stamp synthetic auth rows at daemon-start time and drag the
        // entry's firstLogTs minutes/hours into the past, inflating its
        // elapsed timer by the full queue-wait gap.
        const startupAuthTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined
        let firstItemClaimed = false

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
          state.shutdownResolve?.()
          state.wakeResolve?.()
        })

        // Orphan recovery on startup: include self in alive set so we don't
        // accidentally unclaim items we just claimed on a previous (crashed)
        // run in the tiny window before writing our own lockfile. SQLite
        // heartbeat staleness wins over a lingering lockfile.
        const recovered = await recoverClaimsFromDeadOrStaleWorkers()
        if (recovered > 0) {
          log.step(`[Daemon ${instanceId}] recovered ${recovered} orphan claim(s)`)
        }

        try {
          setPhase('idle')
          emitWorkerHeartbeat()
          while (!state.shuttingDown) {
            await pollWorkerCommands()
            state.queueDepthCache = taskStore.countQueued(wf.config.name)

            const item = state.shuttingDown
              ? null
              : await claimNextItem(
                  wf.config.name,
                  instanceId,
                  trackerDir,
                ).catch((e) => {
                  log.warn(
                    `[Daemon ${instanceId}] claim error: ${e instanceof Error ? e.message : String(e)}`,
                  )
                  return null
                })

            if (item) {
              setPhase('processing')
              if (!item.runId) {
                throw new Error(`Queue invariant violated: task ${item.id} missing runId at claim time`)
              }
              const runId = item.runId
              state.inFlight = {
                itemId: item.id,
                runId,
                ...(item.taskId ? { taskId: item.taskId } : {}),
                ...(item.attemptId ? { attemptId: item.attemptId } : {}),
              }
              if (item.taskId && item.attemptId) {
                taskStore.markTaskRunning({
                  taskId: item.taskId,
                  attemptId: item.attemptId,
                  workerId: instanceId,
                })
              }
              registerBrowserProcesses()
              emitWorkerHeartbeat()
              state.lastActivity = Date.now()
              // First item gets the real startup auth timings; subsequent
              // items get zero-duration synthetic timings anchored at claim
              // time so the step pipeline tiles "Authenticating (4) — 0s"
              // instead of "—" without dragging the entry's anchor back to
              // daemon-start.
              let itemAuthTimings = startupAuthTimings
              if (firstItemClaimed && wf.config.authSteps !== false) {
                const claimTs = Date.now()
                itemAuthTimings = wf.config.systems.map((sys) => ({
                  systemId: sys.id,
                  startTs: claimTs,
                  endTs: claimTs,
                }))
              }
              firstItemClaimed = true
              emitItemStart(instance, item.id, trackerDir, runId)
              const r = await runOneItem({
                wf,
                session,
                item: item.input as TData,
                itemId: item.id,
                runId,
                trackerDir,
                callerPreEmits: false,
                preAssignedInstance: instance,
                authTimings: itemAuthTimings,
                isCancelRequested: () =>
                  state.cancelTarget?.itemId === item.id && state.cancelTarget?.runId === runId,
                ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
              })
              emitItemComplete(instance, item.id, trackerDir, runId)
              if (wf.config.systems.some((s) => s.id === 'ucpath')) {
                emitUcpathIdleSignal(instance, trackerDir, 'touch')
              }
              markTerminated(runId)
              const taskStateAfterRun = item.taskId ? taskStore.getTask(item.taskId)?.state : null
              // Cancellation precedence: if a cancel was requested at any
              // point during the run (via cancelTarget OR SQLite task state
              // transition), the item is cancelled — regardless of whether
              // the step happened to finish successfully or threw an
              // unrelated error. Without this, a step that completes in
              // the same instant as the user clicks cancel races: r.ok=true
              // → marked Done → cancelled tracker row from the dashboard
              // gets overwritten. Cancel always wins over both done and
              // failure.
              const cancelRequestedForThisItem =
                (state.cancelTarget?.itemId === item.id && state.cancelTarget?.runId === runId) ||
                taskStateAfterRun === 'cancelled' ||
                taskStateAfterRun === 'cancel_requested' ||
                taskStateAfterRun === 'cancelling'
              const isCancelOutcome = cancelRequestedForThisItem || (!r.ok && r.kind === 'cancelled')

              if (isCancelOutcome) {
                const cancelError =
                  !r.ok && r.kind === 'cancelled'
                    ? r.error
                    : 'cancelled by user from dashboard'
                await markItemCancelled(wf.config.name, item.id, cancelError, runId, trackerDir)
                if (item.taskId) {
                  taskStore.markDependencyFromChildTerminal({
                    childTaskId: item.taskId,
                    childState: 'cancelled',
                  })
                }
                // Always overwrite with a cancelled tracker row, even if
                // the handler returned r.ok=true (which would have written
                // a status:done row). The latest tracker entry wins on
                // dedup, so this row makes the badge show Cancelled.
                trackEvent(
                  {
                    workflow: wf.config.name,
                    timestamp: new Date().toISOString(),
                    id: item.id,
                    runId,
                    status: 'failed',
                    step: 'cancelled',
                    error: cancelError,
                  },
                  trackerDir,
                )
                emitItemCancelled(instance, item.id, cancelError, trackerDir, runId)
              } else if (r.ok) {
                await markItemDone(wf.config.name, item.id, runId, trackerDir)
                if (item.taskId) {
                  taskStore.markDependencyFromChildTerminal({
                    childTaskId: item.taskId,
                    childState: 'done',
                  })
                }
              } else {
                await markItemFailed(wf.config.name, item.id, r.error, runId, trackerDir)
                if (item.taskId) {
                  taskStore.markDependencyFromChildTerminal({
                    childTaskId: item.taskId,
                    childState: 'failed',
                  })
                }
              }
              // Reset every system's page to its `resetUrl` after a
              // cancelled item — leaves the daemon's auth intact but
              // returns the workflow surface to a clean starting state
              // for the next claim. Reset failures are best-effort: a
              // failed reset won't block the next item from claiming.
              // Fires for both cooperative + force-cancel paths (force
              // navigates pages to about:blank, so reset is required to
              // restore the resetUrl before the next claim).
              if (isCancelOutcome) {
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
              state.cancelTarget = null
              state.inFlight = null
              setPhase('idle')
              emitWorkerHeartbeat()
              continue
            }

            // Idle: wait for wake OR keepalive OR shutdown.
            await new Promise<void>((resolve) => {
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
              }, idleTimeoutMs).unref()
            })

            if (state.shuttingDown) break
            await pollWorkerCommands()

            // Keepalive tick: recover orphans + healthCheck each system.
            setPhase('keepalive')
            await runKeepaliveTick({
              instanceId,
              session,
              systems: wf.config.systems,
              recoverOrphanedClaims: recoverClaimsFromDeadOrStaleWorkers,
            })
            setPhase('idle')
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
    // Orphan-queue cleanup runs here (outer finally) instead of inside the
    // body so it executes on EVERY exit path, including when `Session.launch`
    // throws before the claim loop even starts (user closes browser during
    // Duo, ProcessSingleton collision, etc.). Previously this only ran when
    // the body's inner try/finally was reached, so launch-phase failures left
    // pre-emitted `pending` tracker rows hanging forever.
    //
    // Order matters: cleanup BEFORE lockfile unlink so `findAliveDaemons`
    // still includes self in the alive set — `otherAlive.length === 0`
    // correctly identifies "this is the last alive daemon, no one else will
    // process these items".
    try {
      // Snapshot inFlight into a local — TypeScript's flow analysis can't
      // see assignments inside the async body callback (different closure),
      // so without the local + cast it narrows `inFlight` to `null` here
      // even though the body may have set it.
      const inFlightSnapshot = state.inFlight
      if (inFlightSnapshot) {
        const existingTask = inFlightSnapshot.taskId ? taskStore.getTask(inFlightSnapshot.taskId) : null
        const trackerRoot = trackerDir ?? DEFAULT_DIR
        let skipShutdownEmit = existingTask?.state === 'done'
        if (
          !skipShutdownEmit &&
          (existingTask?.state === 'cancelled' || existingTask?.state === 'failed')
        ) {
          // Prefer SQLite projection over a full-day JSONL scan: shutdown
          // runs inside the SIGINT grace window, and today's JSONL can be
          // tens of MB on a busy daemon. The indexed `run_events` query
          // returns the latest terminal status in O(log N).
          const today = dateLocal()
          let latestTerminal = false
          if (isStateDbReady(trackerRoot)) {
            try {
              const stateDb = openStateDb(trackerRoot)
              const row = stateDb.prepare(`
                SELECT status FROM run_events
                WHERE workflow = @workflow AND tracker_date = @date
                  AND item_id = @itemId AND run_id = @runId
                ORDER BY event_ms DESC, id DESC
                LIMIT 1
              `).get({
                workflow: wf.config.name,
                date: today,
                itemId: inFlightSnapshot.itemId,
                runId: inFlightSnapshot.runId,
              }) as { status?: string } | undefined
              if (row?.status === 'done' || row?.status === 'failed' || row?.status === 'skipped') {
                latestTerminal = true
              }
            } catch {
              /* fall through to JSONL */
            }
          }
          if (!latestTerminal) {
            const latest = findLatestEntryForRunOnDate(
              wf.config.name,
              inFlightSnapshot.itemId,
              inFlightSnapshot.runId,
              today,
              trackerRoot,
            )
            if (latest && isTerminalTrackerEntryStatus(latest)) latestTerminal = true
          }
          if (latestTerminal) skipShutdownEmit = true
        }
        // Successful SQLite completion (`done`): never emit shutdown cancel.
        // SQLite `cancelled` / `failed` with a terminal JSONL row for this run:
        // suppress duplicate tracker/session churn (avoid layering shutdown
        // `cancelled` on top of an authoritative failure row).
        // Otherwise emit shutdown cleanup — including repair when SQLite is
        // terminal but JSONL still shows pending/running (crash window).
        if (skipShutdownEmit) {
          state.inFlight = null
        } else {
          // Daemon shutdown while processing — mark the in-flight item as
          // cancelled (not failed). All shutdown paths are user-initiated
          // (force-stop, terminal close, SIGINT, browser disconnect), so
          // semantically these are intentional cancellations rather than
          // crashes. Cancelled rows display with the orange Cancelled badge
          // (status:failed + step:cancelled is the existing tracker
          // convention dashboards already render that way).
          const nowIso = new Date().toISOString()
          const cancelReason = state.forceShutdown
            ? 'Daemon force-stopped while processing this item.'
            : 'Daemon stopped while processing this item (browser closed or crashed).'
          try {
            await markItemCancelled(
              wf.config.name,
              inFlightSnapshot.itemId,
              cancelReason,
              inFlightSnapshot.runId,
              trackerDir,
            )
          } catch {
            /* best-effort — queue event append; tracker row below is the user-visible signal */
          }
          try {
            trackEvent(
              {
                workflow: wf.config.name,
                timestamp: nowIso,
                id: inFlightSnapshot.itemId,
                runId: inFlightSnapshot.runId,
                status: 'failed',
                step: 'cancelled',
                error: cancelReason,
              },
              trackerDir,
            )
          } catch {
            /* best-effort */
          }
          try {
            // Best-effort emit; if the daemon never reached the
            // withBatchLifecycle body (e.g. session.launch threw), the
            // closure variable was never assigned and we skip the event —
            // the tracker row above is the authoritative user-visible signal.
            if (state.workflowInstanceForCleanup) {
              emitItemCancelled(
                state.workflowInstanceForCleanup,
                inFlightSnapshot.itemId,
                cancelReason,
                trackerDir,
                inFlightSnapshot.runId,
              )
            }
          } catch {
            /* best-effort */
          }
          state.inFlight = null
        }
      }

      const otherAlive = (await findAliveDaemons(wf.config.name, trackerDir))
        .filter((d) => d.instanceId !== instanceId)
      if (otherAlive.length === 0 && !state.drainOnlyShutdown) {
        const queueState = await readQueueState(wf.config.name, trackerDir)
        if (queueState.queued.length > 0) {
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] last daemon exiting with ${queueState.queued.length} unclaimed queue item(s); marking cancelled`,
          )
          const nowIso = new Date().toISOString()
          const cancelReason =
            'Daemon stopped before this item could be processed (browser closed).'
          // Re-read the queue state right before iterating so a concurrent
          // /api/cancel-queued (which also writes a tracker row with
          // step="cancelled") wins the race: items that the user just
          // cancelled are no longer in `freshState.queued`, so we skip
          // them and their cancel reason is preserved on the dashboard.
          const freshState = await readQueueState(wf.config.name, trackerDir).catch(
            () => queueState,
          )
          const stillQueued = new Set(freshState.queued.map((q) => q.id))
          for (const item of queueState.queued) {
            if (!stillQueued.has(item.id)) {
              // Concurrent cancel-queued already terminated this item.
              // Don't overwrite — the cancel handler's tracker row stays
              // as the latest authoritative status.
              continue
            }
            const runId = item.runId ?? randomUUID()
            try {
              await markItemCancelled(wf.config.name, item.id, cancelReason, runId, trackerDir)
              if (item.taskId) {
                taskStore.markDependencyFromChildTerminal({
                  childTaskId: item.taskId,
                  childState: 'cancelled',
                })
              }
            } catch {
              /* best-effort — queue event append; tracker row below is the user-visible signal */
            }
            try {
              // Reuse the same data-shape helper that `onPreEmitPending`
              // uses so prefilledData (edit-and-resume) gets hoisted onto
              // top-level keys. Without this, the cancelled row's `data`
              // would override the pending row's hoisted fields with
              // `docId` + an opaque `prefilledData` JSON blob, hiding the
              // user's edits in the dashboard detail grid.
              const data = buildTrackerDataForInput(item.input)
              trackEvent(
                {
                  workflow: wf.config.name,
                  timestamp: nowIso,
                  id: item.id,
                  runId,
                  status: 'failed',
                  step: 'cancelled',
                  data,
                  error: cancelReason,
                },
                trackerDir,
              )
            } catch {
              /* best-effort */
            }
            try {
              if (state.workflowInstanceForCleanup) {
                emitItemCancelled(
                  state.workflowInstanceForCleanup,
                  item.id,
                  cancelReason,
                  trackerDir,
                  runId,
                )
              }
            } catch {
              /* best-effort */
            }
          }
        }
      }
    } catch (e) {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] orphan-queue cleanup failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }

    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    process.off('SIGHUP', onSighup)
    clearInterval(lockHealInterval)
    clearInterval(workerTickInterval)
    try {
      unlinkSync(lockPath)
    } catch {
      /* best-effort */
    }
    await httpHandle.stop()
    setPhase('exited')
    try {
      state.workerStore?.markWorkerStatus({
        workerId: instanceId,
        status: state.forceShutdown || state.exitError ? 'dead' : 'stopped',
        phase: 'exited',
      })
    } catch {
      /* best-effort */
    }
    log.step(`[Daemon ${wf.config.name}/${instanceId}] exited cleanly`)
  }
}
