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
  type CancelTaskResult,
  type TaskTransitionOutcome,
} from './types.js'
import { enqueueTasks } from './enqueue.js'
import {
  claimNextTask,
  renewClaim,
  markTaskRunning,
  returnTaskToQueued,
  recoverClaimsForDeadWorkers,
} from './claim.js'
import {
  markTaskDone,
  markTaskFailed,
  markTaskBlockedUncertain,
  markTaskFailedIfActive,
  markTaskCancelled,
  requestCancelTask,
  requestCancelParentAndChildren,
} from './terminal.js'
import {
  createDependency,
  markDependencyFromChildTerminal,
  releaseParentsIfDependenciesSatisfied,
  type ReleasedParentTask,
} from './child-state.js'
import { retryTaskFromAttempt, RetryTaskBecameActiveError } from './retry.js'
import {
  getTask,
  getAttempt,
  getTaskByRunId,
  findTaskByIdentity,
  findInputForRunId,
  findOriginalInputForRunId,
  listActiveRootTasksForItem,
  listTasksForWorkflow,
  listTaskTreeByRunIds,
  listAttemptsForTask,
  countQueued,
  type ActiveTaskRef,
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
  CancelTaskResult,
  TaskTransitionOutcome,
  ReleasedParentTask,
  ActiveTaskRef,
}

export { RetryTaskBecameActiveError }

export interface ControlTaskStore {
  control: ControlDb
  db: Database
  close(): void
  enqueueTasks<T>(request: EnqueueTasksRequest<T>): EnqueuedTask[]
  claimNextTask(request: { workflow: string; workerId: string; now?: string; leaseMs?: number }): ClaimedTask | null
  /** Extend a still-held claim's lease (worker heartbeat); returns whether a row matched. */
  renewClaim(request: { taskId: string; workerId: string; now?: string; leaseMs?: number }): boolean
  markTaskRunning(request: { taskId: string; attemptId: string; workerId: string; now?: string }): void
  markTaskDone(request: { taskId: string; attemptId: string; workerId?: string; claimGeneration?: number; now?: string }): TaskTransitionOutcome
  markTaskFailed(request: { taskId: string; attemptId: string; error: string; workerId?: string; claimGeneration?: number; now?: string }): TaskTransitionOutcome
  markTaskBlockedUncertain(request: { taskId: string; attemptId: string; workerId: string; claimGeneration: number; error: string; now?: string }): TaskTransitionOutcome
  /** Fail only if not already terminal (terminal_at IS NULL); returns whether THIS call won. Cross-process queued-orphan dedup (E2E-105). */
  markTaskFailedIfActive(request: { taskId: string; attemptId?: string; error: string; now?: string }): boolean
  markTaskCancelled(request: { taskId: string; attemptId?: string; reason?: string; workerId?: string; claimGeneration?: number; now?: string }): TaskTransitionOutcome
  requestCancelTask(request: { taskId: string; reason?: string; now?: string }): CancelTaskResult
  /**
   * Re-enqueue a failed/terminal task as a fresh attempt. `blockedControlStates`
   * (when supplied) guards the reset UPDATE atomically: if the task became one
   * of those states between the caller's pre-check and this call, it throws
   * `RetryTaskBecameActiveError` instead of resetting a row a daemon is actively
   * running. Always bumps `claim_generation` so a racing stale worker's terminal
   * write no-ops.
   */
  retryTaskFromAttempt(request: { runId: string; now?: string; blockedControlStates?: readonly string[] }): EnqueuedTask
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
  getTask(taskId: string): TaskRow | null
  getAttempt(attemptId: string): AttemptRow | null
  getTaskByRunId(runId: string): TaskRow | null
  findTaskByIdentity(request: { workflow: string; itemId: string; runId?: string }): TaskRow | null
  findInputForRunId(runId: string): unknown | null
  /** Contract 2 (Uniform Retry): pristine first-enqueue input; `null` for legacy rows. */
  findOriginalInputForRunId(runId: string): unknown | null
  /** Non-terminal root (non-delegated) tasks for one item — backs enqueue supersede. */
  listActiveRootTasksForItem(request: { workflow: string; itemId: string }): ActiveTaskRef[]
  listTasksForWorkflow(workflow: string): TaskRow[]
  /** Recursive descendants linked by tasks.parent_run_id; roots are excluded. */
  listTaskTreeByRunIds(request: { rootRunIds: readonly string[] }): TaskRow[]
  listAttemptsForTask(taskId: string): AttemptRow[]
  returnTaskToQueued(request: { taskId: string; attemptId?: string; workerId?: string; claimGeneration?: number; now?: string }): TaskTransitionOutcome
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
    renewClaim: bindControl(renewClaim),
    markTaskRunning: bindControl(markTaskRunning),
    markTaskDone: bindControl(markTaskDone),
    markTaskFailed: bindControl(markTaskFailed),
    markTaskBlockedUncertain: bindControl(markTaskBlockedUncertain),
    markTaskFailedIfActive: bindControl(markTaskFailedIfActive),
    markTaskCancelled: bindControl(markTaskCancelled),
    requestCancelTask: bindControl(requestCancelTask),
    retryTaskFromAttempt: bindControl(retryTaskFromAttempt),
    createDependency: bindControl(createDependency),
    markDependencyFromChildTerminal: bindControl(markDependencyFromChildTerminal),
    releaseParentsIfDependenciesSatisfied: bindControl(releaseParentsIfDependenciesSatisfied),
    requestCancelParentAndChildren: bindControl(requestCancelParentAndChildren),
    getTask: bindDb(getTask),
    getAttempt: bindDb(getAttempt),
    getTaskByRunId: bindDb(getTaskByRunId),
    findTaskByIdentity: bindDb(findTaskByIdentity),
    findInputForRunId: bindDb(findInputForRunId),
    findOriginalInputForRunId: bindDb(findOriginalInputForRunId),
    listActiveRootTasksForItem: bindDb(listActiveRootTasksForItem),
    listTasksForWorkflow: bindDb(listTasksForWorkflow),
    listTaskTreeByRunIds: bindDb(listTaskTreeByRunIds),
    listAttemptsForTask: bindDb(listAttemptsForTask),
    returnTaskToQueued: bindControl(returnTaskToQueued),
    recoverClaimsForDeadWorkers: bindControl(recoverClaimsForDeadWorkers),
    countQueued: bindDb(countQueued),
  }
  return store
}
