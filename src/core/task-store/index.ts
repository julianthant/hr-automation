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
  type ReleasedParentTask,
} from './child-state.js'
import { retryTaskFromAttempt } from './retry.js'
import {
  getTask,
  getAttempt,
  getTaskByRunId,
  findTaskByIdentity,
  findInputForRunId,
  findOriginalInputForRunId,
  listTasksForWorkflow,
  listAttemptsForTask,
  countQueued,
} from './queries.js'

export type {
  TaskState,
  AttemptState,
  ChildFailurePolicy,
  TaskRow,
  AttemptRow,
  ClaimedTask,
  EnqueuedTask,
  EnqueueTasksRequest,
  ReleasedParentTask,
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
  /** Returns parents flipped waiting_dependencies→queued — callers wake those workflows' daemons (E2E-017). */
  markDependencyFromChildTerminal(request: { childTaskId: string; childState: 'done' | 'failed' | 'cancelled'; now?: string }): ReleasedParentTask[]
  /** Returns parents flipped waiting_dependencies→queued — callers wake those workflows' daemons (E2E-017). */
  releaseParentsIfDependenciesSatisfied(request: { childTaskId: string; now?: string }): ReleasedParentTask[]
  requestCancelParentAndChildren(request: { parentTaskId: string; reason?: string; now?: string }): void
  waitForDependencies(request: { parentTaskId: string; timeoutMs?: number; pollMs?: number }): Promise<void>
  getTask(taskId: string): TaskRow | null
  getAttempt(attemptId: string): AttemptRow | null
  getTaskByRunId(runId: string): TaskRow | null
  findTaskByIdentity(request: { workflow: string; itemId: string; runId?: string }): TaskRow | null
  findInputForRunId(runId: string): unknown | null
  /** Contract 2 (Uniform Retry): pristine first-enqueue input; `null` for legacy rows. */
  findOriginalInputForRunId(runId: string): unknown | null
  listTasksForWorkflow(workflow: string): TaskRow[]
  listAttemptsForTask(taskId: string): AttemptRow[]
  returnTaskToQueued(request: { taskId: string; now?: string }): void
  recoverClaimsForDeadWorkers(request: { workflow: string; aliveWorkerIds: Set<string>; now?: string }): TaskRow[]
  countQueued(workflow: string): number
}

export function createTaskStore(control: ControlDb): ControlTaskStore {
  const db = control.db
  const bindControl = <TRequest, TResult>(
    fn: (db: Database, control: ControlDb, request: TRequest) => TResult,
  ) => (request: TRequest) => fn(db, control, request)
  const bindDb = <TRequest, TResult>(
    fn: (db: Database, request: TRequest) => TResult,
  ) => (request: TRequest) => fn(db, request)

  const store: ControlTaskStore = {
    control,
    db,
    close: () => control.close(),
    enqueueTasks: <T>(request: EnqueueTasksRequest<T>) => enqueueTasks(db, control, request),
    claimNextTask: bindControl(claimNextTask),
    markTaskRunning: bindControl(markTaskRunning),
    markTaskDone: bindControl(markTaskDone),
    markTaskFailed: bindControl(markTaskFailed),
    markTaskCancelled: bindControl(markTaskCancelled),
    requestCancelTask: bindControl(requestCancelTask),
    retryTaskFromAttempt: bindControl(retryTaskFromAttempt),
    createDependency: bindControl(createDependency),
    markDependencyFromChildTerminal: bindControl(markDependencyFromChildTerminal),
    releaseParentsIfDependenciesSatisfied: bindControl(releaseParentsIfDependenciesSatisfied),
    requestCancelParentAndChildren: bindControl(requestCancelParentAndChildren),
    waitForDependencies: bindDb(waitForDependencies),
    getTask: bindDb(getTask),
    getAttempt: bindDb(getAttempt),
    getTaskByRunId: bindDb(getTaskByRunId),
    findTaskByIdentity: bindDb(findTaskByIdentity),
    findInputForRunId: bindDb(findInputForRunId),
    findOriginalInputForRunId: bindDb(findOriginalInputForRunId),
    listTasksForWorkflow: bindDb(listTasksForWorkflow),
    listAttemptsForTask: bindDb(listAttemptsForTask),
    returnTaskToQueued: bindControl(returnTaskToQueued),
    recoverClaimsForDeadWorkers: bindControl(recoverClaimsForDeadWorkers),
    countQueued: bindDb(countQueued),
  }
  return store
}
