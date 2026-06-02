import { hostname } from 'node:os'
import { existsSync } from 'node:fs'
import type { RegisteredWorkflow } from '../kernel/types.js'
import { Session } from '../kernel/session.js'
import { runOneItem } from '../kernel/run-one-item.js'
import { withBatchLifecycle } from '../kernel/batch-lifecycle.js'
import { log, enterDaemonLogContext } from '../../utils/log.js'
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
  enterDaemonLogContext(wf.config.name, instanceId, trackerDir)

  const state: DaemonState = {
    wakeResolve: null,
    shutdownResolve: null,
    forceShutdown: false,
    drainOnlyShutdown: false,
    shuttingDown: false,
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
              // Pre-build the `RunHandle` and register with `runRegistry`
              // BEFORE `runOneItem` runs so a `cancel_task` worker command
              // that arrives between claim and handler-start can still
              // reach the controller. `runOneItem` constructs its own
              // controller internally and registers the same runId; the
              // second `register` overwrites the first, leaving the
              // canonical handle (with the controller the stepper observes)
              // in place. We keep `state.activeRun` pointing at the
              // post-runOneItem handle by reading back from the registry.
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
              }
              runRegistry.register(preHandle)
              state.activeRun = preHandle
              registerBrowserProcesses()
              emitWorkerHeartbeat()
              state.lastActivity = Date.now()
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
                  onCancelController: (controller) => {
                    // Keep `state.activeRun` in sync with the controller
                    // `runOneItem` actually uses inside its stepper. The
                    // pre-registered handle (above) is replaced by the
                    // registry when `runOneItem` re-registers; mirror that
                    // into `state.activeRun` so cancel paths read the same
                    // controller everywhere.
                    const fresh = runRegistry.get(runId)
                    if (fresh) {
                      state.activeRun = fresh
                    } else {
                      state.activeRun = { ...preHandle, controller }
                    }
                  },
                })
                emitItemComplete(instance, item.id, trackerDir, runId)
                if (wf.config.systems.some((s) => s.id === 'ucpath')) {
                  emitUcpathIdleSignal(instance, trackerDir, 'touch')
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
                      data: buildShutdownTrackerData(wf, item.input, item.parentRunId, {
                        runId,
                        trackerDir,
                      }) as StampedData,
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
                // controller setup — `state.activeRun` would otherwise stay
                // populated, and a late `/cancel-current` would abort the
                // dead controller from the previous item.
                //
                // `runOneItem`'s own finally also calls
                // `runRegistry.unregister(runId)`; calling it again here is
                // idempotent (Map.delete on a missing key is a no-op) and
                // covers the pre-handler-throw case where `runOneItem`
                // rejected before reaching its register/unregister window
                // and our pre-registered handle is still in the registry.
                runRegistry.unregister(runId)
                state.activeRun = null
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
