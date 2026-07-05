import type { RegisteredWorkflow } from '../kernel/types.js'
import { log } from '../../utils/log.js'
import { findAliveDaemons } from './registry.js'
import { recoverOrphanedClaims } from './queue.js'
import type { ControlTaskStore } from '../task-store/index.js'
import type { ControlWorkerStore, WorkerCommandRow } from './worker-store.js'
import type { DaemonInFlight, DaemonState } from './daemon-types.js'

/**
 * Resolve the target systemId for a per-browser command (`refresh_browser` /
 * `focus_browser` / scoped `health_check`). The dashboard enqueues `systemId`
 * in the command payload; fall back to the browser-process row keyed by
 * `targetBrowserProcessId` (the same row `kill_browser` targets). Returns null
 * when neither resolves — the handler then fails the command loudly.
 */
function resolveCommandSystemId(workerStore: ControlWorkerStore, command: WorkerCommandRow): string | null {
  const fromPayload = command.payload?.['systemId']
  if (typeof fromPayload === 'string' && fromPayload) return fromPayload
  if (command.targetBrowserProcessId) {
    const browser = workerStore.findBrowserProcessById(command.targetBrowserProcessId)
    if (browser?.systemId) return browser.systemId
  }
  return null
}

export interface WorkerCommandContext<TData, TSteps extends readonly string[]> {
  wf: RegisteredWorkflow<TData, TSteps>
  instanceId: string
  trackerDir: string | undefined
  state: DaemonState
  abortLaunchAndKillSession: (reason: string) => void
  /**
   * Centralized cancel-request entry — calls `runRegistry.cancel(runId)`
   * which aborts the per-run `AbortController` and schedules a watchdog
   * hard-kill fallback. Daemon owner constructs this so all three cancel
   * triggers (HTTP /cancel-current, worker `cancel_task` command,
   * browser-disconnect) share one mutation path and cannot drift.
   */
  requestCancel: (
    target: { itemId: string; runId: string } | null,
    reason: 'http' | 'worker-command' | 'browser-disconnect',
  ) => void
}

export function createEmitWorkerHeartbeat<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
  taskStore?: Pick<ControlTaskStore, 'renewClaim'>,
): () => void {
  const { instanceId, state } = ctx
  return (): void => {
    try {
      const inFlight = state.activeRun
      state.workerStore?.heartbeatWorker({
        workerId: instanceId,
        phase: state.phase,
        currentTaskId: inFlight?.taskId ?? null,
        currentAttemptId: inFlight?.attemptId ?? null,
        queueDepth: state.queueDepthCache,
        payload: { itemId: inFlight?.itemId ?? null, runId: inFlight?.runId ?? null },
      })
      // Renew the in-flight claim's lease alongside the worker heartbeat (same
      // cadence). Without this a live worker processing an item longer than the
      // lease window (a separation easily exceeds 60s) looks "expired" to a
      // peer's recoverClaimsForDeadWorkers sweep, which re-pends the item and
      // lets a freshly added worker claim and run it concurrently. Scoped to
      // THIS worker's current task (renewClaim's WHERE), so a reassigned or
      // terminalized task is never kept alive here.
      if (inFlight?.taskId) {
        // `renewClaim` returns `false` (no throw) when its WHERE clause
        // matches no row — a peer already reclaimed this task's lease, or it
        // went terminal. A THROWN error is a separate, genuine DB fault — not
        // a confirmed loss, but we still cannot verify the lease is held.
        // Fail loud in both cases: do not let "renewal unverified" look like
        // "renewal succeeded" and keep running an item a peer may already be
        // executing (double execution against a real HR transaction). Abort
        // THIS worker's in-flight run directly (see below) so it stops
        // treating the lease as held.
        let renewed: boolean
        let renewErrorMessage: string | undefined
        try {
          renewed = taskStore?.renewClaim({ taskId: inFlight.taskId, workerId: instanceId }) ?? true
        } catch (renewErr) {
          renewed = false
          renewErrorMessage = renewErr instanceof Error ? renewErr.message : String(renewErr)
        }
        if (!renewed) {
          log.error(
            `[Daemon ${ctx.wf.config.name}/${instanceId}] lease renewal failed for task ${inFlight.taskId} (runId=${inFlight.runId})${
              renewErrorMessage ? `: ${renewErrorMessage}` : ' — lease no longer held (reassigned or terminal)'
            }; aborting in-flight run to prevent double execution`,
          )
          // Abort THIS worker's own run handle DIRECTLY — the AbortController
          // reference already held on `state.activeRun` — instead of routing
          // through `requestCancel` → `runRegistry.cancel(runId)` (a registry-wide
          // lookup keyed by runId). In production each daemon owns a separate
          // `runRegistry` instance (a distinct OS process — see run-registry.ts's
          // module doc), so a by-runId lookup can only ever resolve to this
          // worker's own handle and the two approaches are equivalent there.
          // But a lost lease means a PEER has re-claimed this EXACT runId
          // (reassign preserves runId/attemptId across the hand-off), and
          // `runRegistry.unregister` clears the per-runId cancel bookkeeping the
          // instant this worker's own prior cancel (if any) unwinds — so a
          // later by-runId `cancel(runId)` call no longer sees "already
          // cancelled" and falls through to whatever handle is CURRENTLY
          // registered for that key. If a runRegistry is ever shared across
          // simulated daemons in one process (as
          // `tests/delegation/daemon-teardown-soak.test.ts` does to model
          // multiple daemons without multiple OS processes), the peer's fresh
          // registration overwrites this runId's map entry, and that by-runId
          // cancel would abort the PEER's run instead of this worker's own
          // stale one — the reassigned run then never completes. Aborting the
          // local `RunHandle` object this worker already holds can never
          // target anyone else's run, no matter what the shared registry maps
          // that runId to; it's also a no-op (guarded below) when this
          // worker's run was already aborted via an explicit stop/reassign,
          // which is the common case this heartbeat check races against.
          if (!inFlight.controller.signal.aborted) {
            inFlight.controller.abort(
              new Error(
                `lease lost for task ${inFlight.taskId} (runId=${inFlight.runId}) — reassigned or terminal`,
              ),
            )
          }
        }
      }
    } catch (err) {
      log.warn(
        `[Daemon ${ctx.wf.config.name}/${instanceId}] heartbeat failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}

export function createRegisterBrowserProcesses<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
  registrationState: {
    browsersRegistered: boolean
    lastRegisteredInFlight: DaemonInFlight | null | undefined
  },
): () => void {
  const { wf, instanceId, state } = ctx
  return (): void => {
    if (!state.activeSession || !state.workerStore) return
    // Build a stable `DaemonInFlight` snapshot for the registration-skip
    // identity comparison. We can't compare `state.activeRun` references
    // directly because they're full `RunHandle` objects that may have
    // different identity between pre-registration and post-`runOneItem`
    // re-registration (see daemon claim-loop `onCancelController` hook).
    const inFlight: DaemonInFlight | null = state.activeRun
      ? {
          itemId: state.activeRun.itemId,
          runId: state.activeRun.runId,
          ...(state.activeRun.taskId ? { taskId: state.activeRun.taskId } : {}),
          ...(state.activeRun.attemptId ? { attemptId: state.activeRun.attemptId } : {}),
        }
      : null
    if (
      registrationState.browsersRegistered &&
      sameInFlight(inFlight, registrationState.lastRegisteredInFlight ?? null)
    ) {
      return
    }
    for (const [systemId, pid] of Object.entries(state.activeSession.chromePids)) {
      const sys = wf.config.systems.find((s) => s.id === systemId)
      state.workerStore.upsertBrowserProcess({
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
    registrationState.browsersRegistered = true
    registrationState.lastRegisteredInFlight = inFlight
  }
}

function sameInFlight(a: DaemonInFlight | null, b: DaemonInFlight | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.itemId === b.itemId &&
    a.runId === b.runId &&
    a.taskId === b.taskId &&
    a.attemptId === b.attemptId
  )
}

export function createRecoverClaimsFromDeadOrStaleWorkers<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
): () => Promise<number> {
  const { wf, instanceId, trackerDir, state } = ctx
  return async (): Promise<number> => {
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
}

export function createHandleWorkerCommand<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
): (command: WorkerCommandRow) => Promise<void> {
  const { wf, instanceId, state, abortLaunchAndKillSession, requestCancel } = ctx
  return async (command: WorkerCommandRow): Promise<void> => {
    const workerStore = state.workerStore
    if (!workerStore) return
    try {
      if (command.commandType === 'cancel_task') {
        const inFlight = state.activeRun
        if (
          !inFlight ||
          (command.targetTaskId && command.targetTaskId !== inFlight.taskId) ||
          (command.targetAttemptId && command.targetAttemptId !== inFlight.attemptId)
        ) {
          workerStore.failCommand(command.commandId, 'task not in flight on this worker')
          return
        }
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        // Contract 5: route through `requestCancel` (→ `runRegistry.cancel`)
        // so the three cancel triggers (HTTP, worker command, browser
        // disconnect) share one mutation path. Aborts the per-run
        // AbortController — any in-flight Playwright call rejects within
        // ms via the Page proxy signal-injection. Fire-and-forget; the
        // watchdog hard-kill handles the rare case where nothing observes
        // the signal (pre-handler launch hang).
        requestCancel(
          { itemId: inFlight.itemId, runId: inFlight.runId },
          'worker-command',
        )
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
      if (command.commandType === 'refresh_browser') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        const systemId = resolveCommandSystemId(workerStore, command)
        if (!systemId) {
          workerStore.failCommand(command.commandId, 'systemId not resolved for refresh_browser')
          return
        }
        if (!state.activeSession) throw new Error('session not ready')
        // Operator-triggered refresh (the panel's Refresh button) — reload this
        // ONE system's page through the same guarded path the auto-recovery
        // uses; emits the browser_health lifecycle so the tile reflects it.
        await state.activeSession.refreshSystem(systemId)
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'reopen_browser') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        const systemId = resolveCommandSystemId(workerStore, command)
        if (!systemId) {
          workerStore.failCommand(command.commandId, 'systemId not resolved for reopen_browser')
          return
        }
        if (!state.activeSession) throw new Error('session not ready')
        // Tiered-recovery escalation: open a FRESH tab on the same authenticated
        // context and swap it in for the wedged one (no Duo). Emits the
        // browser_health lifecycle so the tile reflects the outcome.
        await state.activeSession.reopenSystem(systemId)
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'set_auto_recovery') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        const systemId = resolveCommandSystemId(workerStore, command)
        if (!systemId) {
          workerStore.failCommand(command.commandId, 'systemId not resolved for set_auto_recovery')
          return
        }
        if (!state.activeSession) throw new Error('session not ready')
        // payload.paused === 'true' pauses the monitor's auto-refresh/reopen for
        // this system (manual controls still work); anything else resumes it.
        if (command.payload?.['paused'] === true || command.payload?.['paused'] === 'true') {
          state.activeSession.pauseAutoRecovery(systemId)
        } else {
          state.activeSession.resumeAutoRecovery(systemId)
        }
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'focus_browser') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        const systemId = resolveCommandSystemId(workerStore, command)
        if (!systemId) {
          workerStore.failCommand(command.commandId, 'systemId not resolved for focus_browser')
          return
        }
        if (!state.activeSession) throw new Error('session not ready')
        // "Which browser is this?" — bring the system's Chromium window to front.
        await state.activeSession.focusSystem(systemId)
        workerStore.completeCommand(command.commandId)
        return
      }
      if (command.commandType === 'health_check') {
        workerStore.acknowledgeCommand(command.commandId, instanceId)
        if (!state.activeSession) throw new Error('session not ready')
        // Probe every system and EMIT each result (browser_health) so a manual
        // "check now" lands fresh tile state — the old loop probed silently.
        const targetSystem = resolveCommandSystemId(workerStore, command)
        for (const sys of wf.config.systems) {
          if (targetSystem && sys.id !== targetSystem) continue
          await state.activeSession.probeSystemHealth(sys.id)
        }
        workerStore.completeCommand(command.commandId)
        return
      }
      // Unknown command type — terminalize so it doesn't sit in `queued`
      // forever and block orphan recovery (claim.ts NOT EXISTS filter
      // includes legacy `force_stop_task` rows; without this fallback
      // they pin tasks in claimed-but-unrecoverable state).
      workerStore.failCommand(command.commandId, `unsupported command type: ${command.commandType}`)
    } catch (err) {
      workerStore.failCommand(command.commandId, err instanceof Error ? err.message : String(err))
    }
  }
}

export function createPollWorkerCommands<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
  handleCommand: (command: WorkerCommandRow) => Promise<void>,
): () => Promise<void> {
  const { instanceId, state } = ctx
  return async (): Promise<void> => {
    if (!state.workerStore) return
    const commands = state.workerStore.listQueuedCommandsForWorker(instanceId)
    for (const command of commands) {
      await handleCommand(command)
    }
  }
}

export function startWorkerTickInterval<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
  emitWorkerHeartbeat: () => void,
  pollWorkerCommands: () => Promise<void>,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  const { wf, instanceId } = ctx
  const workerTickInterval = setInterval(() => {
    emitWorkerHeartbeat()
    void pollWorkerCommands().catch((err) => {
      log.warn(
        `[Daemon ${wf.config.name}/${instanceId}] command poll failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    })
  }, intervalMs)
  workerTickInterval.unref()
  return workerTickInterval
}
