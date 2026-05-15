import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type TaskState,
  type AttemptState,
  type ChildFailurePolicy,
  type TaskRow,
  type AttemptRow,
  type ClaimedTask,
  type EnqueuedTask,
  type EnqueueTasksRequest,
  type TaskDbRow,
  type AttemptDbRow,
  mapTaskRow,
  mapAttemptRow,
  parseJson,
} from './types.js'
import { enqueueTasks } from './enqueue.js'
import {
  claimNextTask,
  markTaskRunning,
  returnTaskToQueued,
  recoverClaimsForDeadWorkers,
} from './claim.js'
import {
  markTaskDone,
  markTaskFailed,
  markTaskCancelled,
  requestCancelTask,
  requestCancelParentAndChildren,
} from './terminal.js'
import {
  createDependency,
  markDependencyFromChildTerminal,
  releaseParentsIfDependenciesSatisfied,
  waitForDependencies,
} from './child-state.js'
import { retryTaskFromAttempt } from './retry.js'

export type {
  TaskState,
  AttemptState,
  ChildFailurePolicy,
  TaskRow,
  AttemptRow,
  ClaimedTask,
  EnqueuedTask,
  EnqueueTasksRequest,
}

export interface ControlTaskStore {
  control: ControlDb
  db: Database
  close(): void
  enqueueTasks<T>(request: EnqueueTasksRequest<T>): EnqueuedTask[]
  claimNextTask(request: { workflow: string; workerId: string; now?: string; leaseMs?: number }): ClaimedTask | null
  markTaskRunning(request: { taskId: string; attemptId: string; workerId: string; now?: string }): void
  markTaskDone(request: { taskId: string; attemptId: string; now?: string }): void
  markTaskFailed(request: { taskId: string; attemptId: string; error: string; now?: string }): void
  markTaskCancelled(request: { taskId: string; attemptId?: string; reason?: string; now?: string }): void
  requestCancelTask(request: { taskId: string; reason?: string; now?: string }): TaskRow | null
  retryTaskFromAttempt(request: { runId: string; now?: string }): EnqueuedTask
  createDependency(request: {
    parentTaskId: string
    childTaskId: string
    onChildFailed: ChildFailurePolicy
    cascadeCancel?: boolean
    resumeParentAfterChildRetry?: boolean
    now?: string
  }): string
  markDependencyFromChildTerminal(request: { childTaskId: string; childState: 'done' | 'failed' | 'cancelled'; now?: string }): void
  releaseParentsIfDependenciesSatisfied(request: { childTaskId: string; now?: string }): void
  requestCancelParentAndChildren(request: { parentTaskId: string; reason?: string; now?: string }): void
  waitForDependencies(request: { parentTaskId: string; timeoutMs?: number; pollMs?: number }): Promise<void>
  getTask(taskId: string): TaskRow | null
  getAttempt(attemptId: string): AttemptRow | null
  getTaskByRunId(runId: string): TaskRow | null
  findTaskByIdentity(request: { workflow: string; itemId: string; runId?: string }): TaskRow | null
  findInputForRunId(runId: string): unknown | null
  listTasksForWorkflow(workflow: string): TaskRow[]
  listAttemptsForTask(taskId: string): AttemptRow[]
  returnTaskToQueued(request: { taskId: string; now?: string }): void
  recoverClaimsForDeadWorkers(request: { workflow: string; aliveWorkerIds: Set<string>; now?: string }): TaskRow[]
  countQueued(workflow: string): number
}

export function createTaskStore(control: ControlDb): ControlTaskStore {
  const db = control.db

  const store: ControlTaskStore = {
    control,
    db,
    close: () => control.close(),
    enqueueTasks: (request) => enqueueTasks(db, control, request),
    claimNextTask: (request) => claimNextTask(db, control, request),
    markTaskRunning: (request) => markTaskRunning(db, control, request),
    markTaskDone: (request) => markTaskDone(db, control, request),
    markTaskFailed: (request) => markTaskFailed(db, control, request),
    markTaskCancelled: (request) => markTaskCancelled(db, control, request),
    requestCancelTask: (request) => requestCancelTask(db, control, request),
    retryTaskFromAttempt: (request) => retryTaskFromAttempt(db, control, request),
    createDependency: (request) => createDependency(db, control, request),
    markDependencyFromChildTerminal: (request) => markDependencyFromChildTerminal(db, control, request),
    releaseParentsIfDependenciesSatisfied: (request) => releaseParentsIfDependenciesSatisfied(db, control, request),
    requestCancelParentAndChildren: (request) => requestCancelParentAndChildren(db, control, request),
    waitForDependencies: (request) => waitForDependencies(db, request),
    getTask: (taskId) => {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskDbRow | undefined
      return row ? mapTaskRow(row) : null
    },
    getAttempt: (attemptId) => {
      const row = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(attemptId) as AttemptDbRow | undefined
      return row ? mapAttemptRow(row) : null
    },
    getTaskByRunId: (runId) => getTaskByRunId(db, runId),
    findTaskByIdentity: (request) => findTaskByIdentity(db, request),
    findInputForRunId: (runId) => {
      const row = db.prepare(`
        SELECT t.input_json
        FROM task_attempts a
        JOIN tasks t ON t.id = a.task_id
        WHERE a.run_id = ?
        LIMIT 1
      `).get(runId) as { input_json: string } | undefined
      return row ? parseJson(row.input_json) : null
    },
    listTasksForWorkflow: (workflow) => listTasksForWorkflow(db, workflow),
    listAttemptsForTask: (taskId) => {
      const rows = db.prepare(`
        SELECT *
        FROM task_attempts
        WHERE task_id = ?
        ORDER BY attempt_no ASC
      `).all(taskId) as AttemptDbRow[]
      return rows.map(mapAttemptRow)
    },
    returnTaskToQueued: (request) => returnTaskToQueued(db, control, request),
    recoverClaimsForDeadWorkers: (request) => recoverClaimsForDeadWorkers(db, control, request),
    countQueued: (workflow) => countQueued(db, workflow),
  }
  return store
}

function getTaskByRunId(db: Database, runId: string): TaskRow | null {
  const row = db.prepare(`
    SELECT t.*
    FROM task_attempts a
    JOIN tasks t ON t.id = a.task_id
    WHERE a.run_id = ?
    LIMIT 1
  `).get(runId) as TaskDbRow | undefined
  return row ? mapTaskRow(row) : null
}

function findTaskByIdentity(
  db: Database,
  request: { workflow: string; itemId: string; runId?: string },
): TaskRow | null {
  const row = request.runId
    ? db.prepare(`
        SELECT t.*
        FROM task_attempts a
        JOIN tasks t ON t.id = a.task_id
        WHERE t.workflow = @workflow
          AND t.item_id = @itemId
          AND a.run_id = @runId
        ORDER BY a.attempt_no DESC
        LIMIT 1
      `).get(request) as TaskDbRow | undefined
    : db.prepare(`
        SELECT *
        FROM tasks
        WHERE workflow = @workflow AND item_id = @itemId
        ORDER BY COALESCE(enqueued_at, created_at) DESC
        LIMIT 1
      `).get(request) as TaskDbRow | undefined
  return row ? mapTaskRow(row) : null
}

function listTasksForWorkflow(db: Database, workflow: string): TaskRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = ?
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as TaskDbRow[]
  return rows.map(mapTaskRow)
}

function countQueued(db: Database, workflow: string): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS depth
    FROM tasks
    WHERE workflow = @workflow
      AND task_kind = 'workflow_item'
      AND source = 'daemon'
      AND control_state = 'queued'
  `).get({ workflow }) as { depth: number } | undefined
  return row?.depth ?? 0
}
