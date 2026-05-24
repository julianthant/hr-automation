import type { RegisteredWorkflow } from '../kernel/types.js'
import { log } from '../../utils/log.js'
import { findAliveDaemons } from './registry.js'
import { recoverOrphanedClaims } from './queue.js'
import type { WorkerCommandRow } from './worker-store.js'
import type { DaemonInFlight, DaemonState } from './daemon-types.js'

export interface WorkerCommandContext<TData, TSteps extends readonly string[]> {
  wf: RegisteredWorkflow<TData, TSteps>
  instanceId: string
  trackerDir: string | undefined
  state: DaemonState
  abortLaunchAndKillSession: (reason: string) => void
}

export function createEmitWorkerHeartbeat<TData, TSteps extends readonly string[]>(
  ctx: WorkerCommandContext<TData, TSteps>,
): () => void {
  const { instanceId, state } = ctx
  return (): void => {
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
    // Skip if pids are already registered for the same inFlight task.
    if (registrationState.browsersRegistered && state.inFlight === registrationState.lastRegisteredInFlight) return
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
    registrationState.browsersRegistered = true
    registrationState.lastRegisteredInFlight = state.inFlight
  }
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
  const { wf, instanceId, state, abortLaunchAndKillSession } = ctx
  return async (command: WorkerCommandRow): Promise<void> => {
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
        // Contract 5: aborting the per-run AbortController propagates into
        // any in-flight Playwright call (via the signal injected by
        // ctx.page(id)'s proxy), so cancel completes in ms rather than at
        // the next ctx.step boundary. The stepper still sees `cancelTarget`
        // set and emits step="cancelled" via its mapEscapedHandlerError
        // path; without controller.abort() the dashboard would wait up to
        // ~30s for the active waitForSelector to time out.
        if (!state.currentRunController?.signal.aborted) {
          state.currentRunController?.abort(new Error('cancel requested'))
        }
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
