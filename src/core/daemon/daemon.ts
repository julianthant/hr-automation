import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import type { RegisteredWorkflow } from '../kernel/types.js'
import { Session } from '../kernel/session.js'
import { runOneItem } from '../kernel/run-one-item.js'
import { withBatchLifecycle } from '../kernel/batch-lifecycle.js'
import { log } from '../../utils/log.js'
import {
  lockfilePath,
  randomInstanceId,
  writeLockfile,
  ensureDaemonsDir,
} from './registry.js'
import {
  claimNextItem,
  markItemCancelled,
  markItemDone,
  markItemFailed,
} from './queue.js'
import type { DaemonLockfile } from './types.js'
import {
  emitItemStart,
  emitItemComplete,
  emitItemCancelled,
  emitDaemonPhase,
  emitUcpathIdleSignal,
} from '../../tracker/session-events.js'
import { emitTrackerRow, type StampedData } from '../../tracker/jsonl.js'
import { openControlDb } from '../control-db.js'
import { createTaskStore } from '../task-store/index.js'
import { createWorkerStore } from './worker-store.js'
import { startDaemonHttpServer } from './http.js'
import { runKeepaliveTick } from './keepalive.js'
import type { DaemonPhase, DaemonState } from './daemon-types.js'
export type { DaemonPhase } from './daemon-types.js'
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
    // Per-run AbortController (Contract 5). Set by runOneItem's
    // `onCancelController` callback at item start; cleared in the claim
    // loop's per-item cleanup along with cancelTarget. A daemon-side
    // cancel-task command calls .abort() on this controller, which
    // propagates into the in-flight Playwright call via the signal the
    // Page proxy injected.
    currentRunController: null,
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
   * Centralized cancel-request entry point — all three triggers
   * (HTTP /cancel-current, worker `cancel_task` command, browser-disconnect)
   * MUST flow through here so they cannot drift. Drops a `cancelTarget` on
   * the state (the between-step probe reads it) AND aborts the per-run
   * `AbortController` so any in-flight Playwright call rejects within ms
   * instead of waiting on its declared timeout (Contract 5).
   *
   * Pre-Contract-5-cleanup the browser-disconnect handler only set
   * `cancelTarget` and skipped the controller abort, causing disconnect
   * during a `waitForSelector` to wait the full ~30s timeout. This helper
   * collapses the three paths so that gap can't reappear.
   *
   * `target` of null clears the cancelTarget without touching the controller
   * (used by the per-item finalize sweep so the next item starts clean).
   */
  const requestCancel = (
    target: { itemId: string; runId: string } | null,
    reason: 'http' | 'worker-command' | 'browser-disconnect',
  ): void => {
    state.cancelTarget = target
    if (target && state.currentRunController && !state.currentRunController.signal.aborted) {
      state.currentRunController.abort(new Error(`cancel requested (${reason})`))
    }
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
    getInFlight: () => state.inFlight,
    getLastActivity: () => state.lastActivity,
    getActiveSession: () => state.activeSession,
    getWorkerStore: () => state.workerStore,
    setCancelTarget: (target) => {
      requestCancel(target, 'http')
    },
    setForceShutdown: (value) => { state.forceShutdown = value },
    setDrainOnlyShutdown: (value) => { state.drainOnlyShutdown = value },
    setShuttingDown: (value) => { state.shuttingDown = value },
    resolveWake: () => { state.wakeResolve?.() },
    resolveShutdown: () => { state.shutdownResolve?.() },
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

  const emitWorkerHeartbeat = createEmitWorkerHeartbeat(workerCtx)
  emitWorkerHeartbeat()

  const browserRegistrationState = {
    browsersRegistered: false,
    lastRegisteredInFlight: undefined as import('./daemon-types.js').DaemonInFlight | null | undefined,
  }
  const registerBrowserProcesses = createRegisterBrowserProcesses(workerCtx, browserRegistrationState)
  const recoverClaimsFromDeadOrStaleWorkers = createRecoverClaimsFromDeadOrStaleWorkers(workerCtx)
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
          if (state.inFlight) {
            // Set cancelTarget so the stepper reclassifies the in-flight step
            // as cancelled rather than failed; the outer finally still writes
            // the cancelled row. Route through `requestCancel` so the per-run
            // AbortController is also aborted — without this, a disconnect
            // during a `waitForSelector` waited the full timeout instead of
            // failing fast.
            requestCancel(
              {
                itemId: state.inFlight.itemId,
                runId: state.inFlight.runId,
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
              const itemAuthTimings = itemAuthTimingResolver.resolveForNextItem()
              emitItemStart(instance, item.id, trackerDir, runId)
              try {
                const r = await runOneItem({
                  wf,
                  session,
                  // No cast: runOneItem validates `item` via wf.config.schema.parse
                  // before invoking the handler, so the claim loop hands the raw
                  // input straight through.
                  item: item.input as TData,
                  itemId: item.id,
                  runId,
                  trackerDir,
                  callerPreEmits: false,
                  preAssignedInstance: instance,
                  authTimings: itemAuthTimings,
                  isCancelRequested: () =>
                    state.cancelTarget?.itemId === item.id && state.cancelTarget?.runId === runId,
                  onCancelController: (controller) => {
                    // Stash the per-run AbortController so cancel_task /
                    // /cancel-current can abort in-flight Playwright work
                    // immediately (Contract 5) instead of waiting on the
                    // step-boundary probe. Cleared below after the item
                    // finishes so a late command can't poison the next item.
                    state.currentRunController = controller
                  },
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
                      data: buildShutdownTrackerData(wf, item.input, item.parentRunId) as StampedData,
                      ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
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
              } finally {
                // Per-item cleanup MUST run on both happy and throw paths
                // (Finding #9). If `runOneItem` throws — e.g. the schema
                // validation error at run-one-item.ts that fires BEFORE the
                // controller setup — these fields would otherwise stay
                // populated, and a late `/cancel-current` would abort the
                // dead controller from the previous item and stamp a stale
                // `cancelTarget`. Only null the cancelTarget if it was for
                // THIS just-finished item; a cancel that arrived for a
                // future run (unlikely given single-claim semantics, but
                // robust) is preserved.
                if (
                  state.cancelTarget?.itemId === item.id
                  && state.cancelTarget?.runId === runId
                ) {
                  state.cancelTarget = null
                }
                state.currentRunController = null
                state.inFlight = null
              }
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
