import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { existsSync, unlinkSync } from 'node:fs'
import type { RegisteredWorkflow } from './types.js'
import { Session } from './session.js'
import { runOneItem } from './workflow.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { log } from '../utils/log.js'
import {
  lockfilePath,
  randomInstanceId,
  writeLockfile,
  findAliveDaemons,
  ensureDaemonsDir,
} from './daemon-registry.js'
import {
  claimNextItem,
  markItemCancelled,
  markItemDone,
  markItemFailed,
  recoverOrphanedClaims,
  readQueueState,
} from './daemon-queue.js'
import type { DaemonLockfile } from './daemon-types.js'
import { emitItemStart, emitItemComplete } from '../tracker/session-events.js'
import { trackEvent } from '../tracker/jsonl.js'
import { buildTrackerDataForInput } from './enqueue-dispatch.js'
import { openControlDb } from './control-db.js'
import { createTaskStore } from './task-store/index.js'
import { createWorkerStore, type ControlWorkerStore, type WorkerCommandRow } from './worker-store.js'
import { startDaemonHttpServer } from './daemon-http.js'
import { runKeepaliveTick } from './daemon-keepalive.js'

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

  let wakeResolve: (() => void) | null = null
  let shutdownResolve: (() => void) | null = null
  let forceShutdown = false
  let drainOnlyShutdown = false
  let shuttingDown = false
  let inFlight: { itemId: string; runId: string; taskId?: string; attemptId?: string } | null = null
  let queueDepthCache = 0
  let lastActivity = Date.now()
  let phase: DaemonPhase = 'launching'
  // Session reference exposed to the /status handler so the dashboard
  // (and the spawn pre-check in `daemon-registry`) can inventory which
  // chromium PIDs belong to this daemon. Assigned inside the
  // `withBatchLifecycle` body once `Session.launch` resolves; remains
  // null during `phase === 'launching'`. Force-stop paths can also read
  // it to SIGTERM/SIGKILL chromium directly.
  let activeSession: Session | null = null
  const launchAbort = new AbortController()
  let workerStore: ControlWorkerStore | null = null
  let exitError: unknown = null
  // Cooperative-cancel signal for the in-flight item. Set by the
  // POST /cancel-current handler when itemId+runId match the current
  // in-flight item; cleared after the next item starts. Stepper checks
  // this at every step boundary and throws CancelledError.
  let cancelTarget: { itemId: string; runId: string } | null = null
  const setPhase = (next: DaemonPhase): void => {
    if (phase === next) return
    const prev = phase
    phase = next
    log.step(`[Daemon ${wf.config.name}/${instanceId}] phase: ${prev} → ${next}`)
  }

  const abortLaunchAndKillSession = (reason: string): void => {
    if (!launchAbort.signal.aborted) {
      launchAbort.abort(new Error(reason))
    }
    const session = activeSession
    if (!session) return
    session.killChromeHard(2_000).catch((err) => {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] killChromeHard after abort failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }

  const { listenPromise } = startDaemonHttpServer({
    workflowName: wf.config.name,
    instanceId,
    getPhase: () => phase,
    getQueueDepthCache: () => queueDepthCache,
    getInFlight: () => inFlight,
    getLastActivity: () => lastActivity,
    getActiveSession: () => activeSession,
    getWorkerStore: () => workerStore,
    setCancelTarget: (target) => { cancelTarget = target },
    setForceShutdown: (value) => { forceShutdown = value },
    setDrainOnlyShutdown: (value) => { drainOnlyShutdown = value },
    setShuttingDown: (value) => { shuttingDown = value },
    resolveWake: () => { wakeResolve?.() },
    resolveShutdown: () => { shutdownResolve?.() },
    abortLaunchAndKillSession,
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
  workerStore = createWorkerStore(controlDb)
  workerStore.registerWorker({
    workerId: instanceId,
    workflow: wf.config.name,
    kind: 'daemon',
    pid: process.pid,
    parentPid: process.ppid,
    hostname: hostname(),
    port,
    instanceId,
    lockfilePath: lockPath,
    phase,
    heartbeatTtlMs: 30_000,
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
    if (shuttingDown) return
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
      workerStore?.heartbeatWorker({
        workerId: instanceId,
        phase,
        currentTaskId: inFlight?.taskId ?? null,
        currentAttemptId: inFlight?.attemptId ?? null,
        queueDepth: queueDepthCache,
        payload: { itemId: inFlight?.itemId ?? null, runId: inFlight?.runId ?? null },
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
  const heartbeatInterval = setInterval(emitWorkerHeartbeat, opts.heartbeatIntervalMs ?? 5_000)
  heartbeatInterval.unref()

  const sigHandler = (sig: string): void => {
    log.warn(`[Daemon ${wf.config.name}/${instanceId}] received ${sig}; shutting down`)
    shuttingDown = true
    forceShutdown = true
    drainOnlyShutdown = false
    abortLaunchAndKillSession(`Daemon received ${sig}`)
    shutdownResolve?.()
    wakeResolve?.()
  }
  const onSigint = (): void => sigHandler('SIGINT')
  const onSigterm = (): void => sigHandler('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  const registerBrowserProcesses = (): void => {
    if (!activeSession || !workerStore) return
    for (const [systemId, pid] of Object.entries(activeSession.chromePids)) {
      const sys = wf.config.systems.find((s) => s.id === systemId)
      workerStore.upsertBrowserProcess({
        workerId: instanceId,
        workflow: wf.config.name,
        systemId,
        browserId: systemId,
        pid,
        ...(inFlight?.taskId ? { taskId: inFlight.taskId } : {}),
        ...(inFlight?.attemptId ? { attemptId: inFlight.attemptId } : {}),
        ...(sys?.sessionDir ? { sessionDir: sys.sessionDir } : {}),
      })
    }
  }

  const handleCommand = async (command: WorkerCommandRow): Promise<void> => {
    if (!workerStore) return
    try {
      if (command.commandType === 'cancel_task') {
        if (
          !inFlight ||
          (command.targetTaskId && command.targetTaskId !== inFlight.taskId) ||
          (command.targetAttemptId && command.targetAttemptId !== inFlight.attemptId)
        ) {
          workerStore.failCommand(command.commandId, 'task not in flight on this worker')
          return
        }
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        cancelTarget = { itemId: inFlight.itemId, runId: inFlight.runId }
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'force_stop_task') {
        if (
          !inFlight ||
          (command.targetTaskId && command.targetTaskId !== inFlight.taskId) ||
          (command.targetAttemptId && command.targetAttemptId !== inFlight.attemptId)
        ) {
          workerStore.failCommand(command.commandId, 'task not in flight on this worker')
          return
        }
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        cancelTarget = { itemId: inFlight.itemId, runId: inFlight.runId }
        forceShutdown = true
        drainOnlyShutdown = false
        shuttingDown = true
        workerStore.markWorkerStatus({ workerId: instanceId, status: 'draining', phase: 'draining' })
        abortLaunchAndKillSession('Daemon force-stop task requested')
        shutdownResolve?.()
        wakeResolve?.()
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'drain_worker') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        workerStore.markWorkerStatus({ workerId: instanceId, status: 'draining', phase: 'draining' })
        drainOnlyShutdown = true
        shuttingDown = true
        wakeResolve?.()
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'stop_worker') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        forceShutdown = true
        drainOnlyShutdown = false
        shuttingDown = true
        wakeResolve?.()
        shutdownResolve?.()
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
        if (!activeSession) throw new Error('session not ready')
        for (const sys of wf.config.systems) {
          await activeSession.healthCheck(sys.id)
        }
        workerStore.completeCommand(command.commandId)
      }
    } catch (err) {
      workerStore.failCommand(command.commandId, err instanceof Error ? err.message : String(err))
    }
  }

  const pollWorkerCommands = async (): Promise<void> => {
    if (!workerStore) return
    const commands = workerStore.listQueuedCommandsForWorker(instanceId)
    for (const command of commands) {
      await handleCommand(command)
    }
  }

  const recoverClaimsFromDeadOrStaleWorkers = async (): Promise<number> => {
    const alive = await findAliveDaemons(wf.config.name, trackerDir)
    const aliveSet = new Set(alive.map((d) => d.instanceId))
    aliveSet.add(instanceId)
    const staleWorkers = workerStore
      ? workerStore.listStaleWorkers({}).filter((w) => w.workflow === wf.config.name && w.workerId !== instanceId)
      : []
    for (const stale of staleWorkers) {
      workerStore?.markWorkerStatus({ workerId: stale.workerId, status: 'stale', phase: stale.phase })
      aliveSet.delete(stale.workerId)
    }
    return recoverOrphanedClaims(wf.config.name, aliveSet, trackerDir)
  }

  const commandPollInterval = setInterval(() => {
    void pollWorkerCommands().catch((err) => {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] command poll failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }, opts.commandPollIntervalMs ?? opts.heartbeatIntervalMs ?? 5_000)
  commandPollInterval.unref()

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
        const { observer, getAuthTimings } = makeObserver('1')
        setPhase('authenticating')
        let session: Session
        try {
          session = await launchFn(wf.config.systems, {
            authChain: wf.config.authChain,
            observer,
            abortSignal: launchAbort.signal,
            onReady: (readySession) => {
              activeSession = readySession
              registerBrowserProcesses()
            },
          })
          // Expose to the /status handler + force-stop path. Cleared in
          // the outer `finally` to avoid a stale reference outliving the
          // session's lifetime.
          activeSession = session
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
        } catch (e) {
          if (shuttingDown && launchAbort.signal.aborted) {
            log.warn(
              `[Daemon ${wf.config.name}/${instanceId}] auth/launch aborted by shutdown`,
            )
            activeSession = null
            return
          }
          // Surface the failure with structured context so `npm run <wf>:attach`
          // shows an actionable line instead of a silent daemon exit. Classify
          // via the Playwright error taxonomy when the error looks like a browser
          // launch fault (ProcessSingleton, etc.).
          const summary = e instanceof Error ? (e.message ?? String(e)) : String(e)
          log.error(
            `[Daemon ${wf.config.name}/${instanceId}] auth/launch failed during phase='${phase}' — ${summary}`,
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
          if (shuttingDown) return
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] browser disconnected (${systemId}); shutting down`,
          )
          shuttingDown = true
          shutdownResolve?.()
          wakeResolve?.()
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
          while (!shuttingDown) {
            await pollWorkerCommands()
            const state = await readQueueState(wf.config.name, trackerDir)
            queueDepthCache = state.queued.length

            const item = shuttingDown
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
              const runId = item.runId ?? randomUUID()
              inFlight = {
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
              lastActivity = Date.now()
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
              emitItemStart(instance, item.id, trackerDir)
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
                  cancelTarget?.itemId === item.id && cancelTarget?.runId === runId,
                ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
              })
              emitItemComplete(instance, item.id, trackerDir)
              markTerminated(runId)
              const taskStateAfterRun = item.taskId ? taskStore.getTask(item.taskId)?.state : null
              if (r.ok) {
                await markItemDone(wf.config.name, item.id, runId, trackerDir)
                if (item.taskId) {
                  taskStore.markDependencyFromChildTerminal({
                    childTaskId: item.taskId,
                    childState: 'done',
                  })
                }
              } else if (r.kind === 'cancelled' || taskStateAfterRun === 'cancelled') {
                const cancelError = r.kind === 'cancelled' ? r.error : 'cancelled by user from dashboard'
                await markItemCancelled(wf.config.name, item.id, cancelError, runId, trackerDir)
                if (item.taskId) {
                  taskStore.markDependencyFromChildTerminal({
                    childTaskId: item.taskId,
                    childState: 'cancelled',
                  })
                }
                if (r.kind !== 'cancelled') {
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
              if (r.ok === false && r.kind === 'cancelled') {
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
              cancelTarget = null
              inFlight = null
              setPhase('idle')
              emitWorkerHeartbeat()
              continue
            }

            // Idle: wait for wake OR keepalive OR shutdown.
            await new Promise<void>((resolve) => {
              wakeResolve = (): void => {
                wakeResolve = null
                resolve()
              }
              shutdownResolve = (): void => {
                shutdownResolve = null
                resolve()
              }
              setTimeout(() => {
                wakeResolve = null
                shutdownResolve = null
                resolve()
              }, idleTimeoutMs).unref()
            })

            if (shuttingDown) break
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
          activeSession = null
        }
      },
    )
  } catch (err) {
    exitError = err
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
      const inFlightSnapshot = inFlight as {
        itemId: string
        runId: string
        taskId?: string
        attemptId?: string
      } | null
      if (inFlightSnapshot) {
        const existingTask = inFlightSnapshot.taskId ? taskStore.getTask(inFlightSnapshot.taskId) : null
        if (
          existingTask?.state === 'cancelled' ||
          existingTask?.state === 'done' ||
          existingTask?.state === 'failed'
        ) {
          inFlight = null
        } else {
        // 2026-04-28 Cluster A: every shutdown path is force semantics.
        // Mark in-flight failed in BOTH the queue and the tracker — never
        // re-queue. Per user direction: "I don't want graceful. I don't
        // want the requeue. I want to see it fail when daemon dies."
        const nowIso = new Date().toISOString()
        const failError = forceShutdown
          ? 'Daemon force-stopped while processing this item.'
          : 'Daemon stopped while processing this item (browsers closed or crashed).'
        try {
          await markItemFailed(
            wf.config.name,
            inFlightSnapshot.itemId,
            failError,
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
              error: failError,
            },
            trackerDir,
          )
        } catch {
          /* best-effort */
        }
        inFlight = null
        }
      }

      const otherAlive = (await findAliveDaemons(wf.config.name, trackerDir))
        .filter((d) => d.instanceId !== instanceId)
      if (otherAlive.length === 0 && !drainOnlyShutdown) {
        const state = await readQueueState(wf.config.name, trackerDir)
        if (state.queued.length > 0) {
          log.warn(
            `[Daemon ${wf.config.name}/${instanceId}] last daemon exiting with ${state.queued.length} unclaimed queue item(s); marking failed`,
          )
          const nowIso = new Date().toISOString()
          const failError =
            'Daemon stopped before this item could be processed (browsers closed).'
          // Re-read the queue state right before iterating so a concurrent
          // /api/cancel-queued (which also writes a `failed` queue event +
          // a tracker row with step="cancelled") wins the race: items that
          // the user just cancelled are no longer in `freshState.queued`,
          // so we skip them and their cancel reason is preserved on the
          // dashboard. Without this, the daemon-stop reason ("Daemon
          // stopped before this item could be processed") would overwrite
          // the user's "cancelled" intent — which the user explicitly
          // flagged as a bug ("the queue doesn't cancel").
          const freshState = await readQueueState(wf.config.name, trackerDir).catch(
            () => state,
          )
          const stillQueued = new Set(freshState.queued.map((q) => q.id))
          for (const item of state.queued) {
            if (!stillQueued.has(item.id)) {
              // Concurrent cancel-queued already terminated this item.
              // Don't overwrite — the cancel handler's tracker row stays
              // as the latest authoritative status.
              continue
            }
            const runId = item.runId ?? randomUUID()
            try {
              await markItemFailed(wf.config.name, item.id, failError, runId, trackerDir)
              if (item.taskId) {
                taskStore.markDependencyFromChildTerminal({
                  childTaskId: item.taskId,
                  childState: 'failed',
                })
              }
            } catch {
              /* best-effort — queue event append; tracker row below is the user-visible signal */
            }
            try {
              // Reuse the same data-shape helper that `onPreEmitPending`
              // uses so prefilledData (edit-and-resume) gets hoisted onto
              // top-level keys. Without this, the failed row's `data` would
              // override the pending row's hoisted fields with `docId` +
              // an opaque `prefilledData` JSON blob, hiding the user's
              // edits in the dashboard detail grid.
              const data = buildTrackerDataForInput(item.input)
              trackEvent(
                {
                  workflow: wf.config.name,
                  timestamp: nowIso,
                  id: item.id,
                  runId,
                  status: 'failed',
                  data,
                  error: failError,
                },
                trackerDir,
              )
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
    clearInterval(lockHealInterval)
    clearInterval(heartbeatInterval)
    clearInterval(commandPollInterval)
    try {
      unlinkSync(lockPath)
    } catch {
      /* best-effort */
    }
    await httpHandle.stop()
    setPhase('exited')
    try {
      workerStore?.markWorkerStatus({
        workerId: instanceId,
        status: forceShutdown || exitError ? 'dead' : 'stopped',
        phase: 'exited',
      })
    } catch {
      /* best-effort */
    }
    log.step(`[Daemon ${wf.config.name}/${instanceId}] exited cleanly`)
  }
}
