import type { RegisteredWorkflow } from '../kernel/types.js'
import { log } from '../../utils/log.js'
import { findAliveDaemons } from './registry.js'
import { recoverOrphanedClaims } from './queue.js'
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
