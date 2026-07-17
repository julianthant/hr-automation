import { hostname } from 'node:os'
import type { RegisteredWorkflow } from '../kernel/types.js'
import { Session } from '../kernel/session.js'
import { errorMessage } from '../../utils/errors.js'
import { log } from '../../utils/log.js'
import { openControlDb } from '../control-db.js'
import { createTaskStore } from '../task-store/index.js'
import { createWorkerStore } from './worker-store.js'
import type { RunControlAudit } from '../run-registry.js'

function swallowSqliteErr<T>(label: string, fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch (err) {
    log.warn(`SQLite ${label} skipped: ${String(err)}`)
    return fallback
  }
}

export function registerInProcessControl<TData>(
  wf: RegisteredWorkflow<TData, readonly string[]>,
  input: TData,
  itemId: string,
  runId: string,
  trackerDir: string | undefined,
): RunControlAudit | null {
  if (!trackerDir) return null
  const workerId = `dashboard:${process.pid}`
  return swallowSqliteErr(`in-process control registration for ${wf.config.name}/${itemId}`, () => {
    const controlDb = openControlDb({ trackerDir })
    const taskStore = createTaskStore(controlDb)
    const workerStore = createWorkerStore(controlDb)
    workerStore.registerWorker({
      workerId,
      workflow: wf.config.name,
      kind: 'dashboard',
      pid: process.pid,
      parentPid: process.ppid,
      hostname: hostname(),
      phase: 'processing',
      status: 'alive',
      heartbeatTtlMs: 30_000,
    })
    const existing = taskStore.getTaskByRunId(runId)
    const task = existing && existing.workflow === wf.config.name && existing.itemId === itemId
      ? {
          taskId: existing.taskId,
          attemptId: existing.currentAttemptId,
        }
      : taskStore.enqueueTasks({
          workflow: wf.config.name,
          inputs: [input],
          deriveItemId: () => itemId,
          runIds: [runId],
          source: 'in-process',
          metadata: { workerId },
        })[0]
    if (!task?.attemptId) {
      controlDb.close()
      return null
    }
    taskStore.markTaskRunning({ taskId: task.taskId, attemptId: task.attemptId, workerId })
    return {
      trackerDir,
      workerId,
      taskId: task.taskId,
      attemptId: task.attemptId,
      controlDb,
      taskStore,
      workerStore,
    }
  }, null)
}

export function registerInProcessBrowsers<TData>(
  wf: RegisteredWorkflow<TData, readonly string[]>,
  session: Session,
  control: RunControlAudit | null,
): void {
  if (!control) return
  swallowSqliteErr(`in-process browser registration for ${wf.config.name}`, () => {
    for (const [systemId, pid] of Object.entries(session.chromePids)) {
      const sys = wf.config.systems.find((s) => s.id === systemId)
      control.workerStore.upsertBrowserProcess({
        workerId: control.workerId,
        workflow: wf.config.name,
        taskId: control.taskId,
        attemptId: control.attemptId,
        systemId,
        browserId: systemId,
        pid,
        ...(sys?.sessionDir ? { sessionDir: sys.sessionDir } : {}),
      })
    }
  }, undefined)
}

export function markInProcessControlTerminal(
  control: RunControlAudit | null,
  ok: boolean,
  error?: unknown,
): void {
  if (!control) return
  swallowSqliteErr(`in-process terminal update for task=${control.taskId}`, () => {
    if (ok) {
      control.taskStore.markTaskDone({ taskId: control.taskId, attemptId: control.attemptId })
    } else {
      control.taskStore.markTaskFailed({
        taskId: control.taskId,
        attemptId: control.attemptId,
        error: error == null ? 'in-process run failed' : errorMessage(error),
      })
    }
  }, undefined)
}
