import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

import type { ControlDb } from './control-db.js'

export type TaskState =
  | 'queued'
  | 'waiting_dependencies'
  | 'claimed'
  | 'running'
  | 'cancel_requested'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'failed'
  | 'blocked'

export type AttemptState =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'cancel_requested'
  | 'cancelled'
  | 'done'
  | 'failed'

export type ChildFailurePolicy = 'fail_parent' | 'block_parent' | 'allow_partial'

export interface TaskRow {
  taskId: string
  workflow: string
  itemId: string
  input: unknown
  state: TaskState
  runId?: string
  parentTaskId?: string
  parentRunId?: string
  currentAttemptId?: string
  currentRunId?: string
  claimedByWorkerId?: string
  enqueuedAt?: string
  claimedAt?: string
  terminalAt?: string
  error?: string
}

export interface AttemptRow {
  attemptId: string
  taskId: string
  attemptNo: number
  runId: string
  state: AttemptState
  workerId?: string
}

export interface ClaimedTask {
  taskId: string
  attemptId: string
  workflow: string
  itemId: string
  input: unknown
  runId: string
  workerId: string
  parentRunId?: string
}

export interface EnqueuedTask {
  id: string
  itemId: string
  taskId: string
  attemptId: string
  runId: string
  position: number
}

export interface EnqueueTasksRequest<T> {
  workflow: string
  inputs: T[]
  deriveItemId: (input: T, index: number) => string
  parentTaskId?: string
  parentRunId?: string
  now?: string
  runIds?: ReadonlyArray<string>
  source?: string
  metadata?: Record<string, unknown>
}

export interface ControlTaskStore {
  control: ControlDb
  db: Database.Database
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
  recoverClaimsForDeadWorkers(request: { workflow: string; aliveWorkerIds: Set<string>; now?: string }): number
}

interface TaskDbRow {
  id: string
  workflow: string
  item_id: string
  run_id: string | null
  parent_task_id: string | null
  parent_run_id: string | null
  input_json: string
  control_state: TaskState | null
  status: string
  current_attempt_id: string | null
  claimed_by_worker_id: string | null
  enqueued_at: string | null
  claimed_at: string | null
  terminal_at: string | null
  terminal_error: string | null
}

interface AttemptDbRow {
  id: string
  task_id: string
  attempt_no: number
  run_id: string
  control_state: AttemptState | null
  status: string
  worker_id: string | null
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
  }
  return store
}

function enqueueTasks<T>(db: Database.Database, control: ControlDb, request: EnqueueTasksRequest<T>): EnqueuedTask[] {
  if (request.runIds && request.runIds.length !== request.inputs.length) {
    throw new Error(`enqueueTasks: runIds length ${request.runIds.length} does not match inputs length ${request.inputs.length}`)
  }
  if (request.inputs.length === 0) return []
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const basePosition = (db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE workflow = ? AND control_state = 'queued'
    `).get(request.workflow) as { n: number }).n

    return request.inputs.map((input, index) => {
      const itemId = request.deriveItemId(input, index)
      const taskId = randomUUID()
      const attemptId = randomUUID()
      const runId = request.runIds?.[index] ?? randomUUID()
      const inputJson = JSON.stringify(input)
      db.prepare(`
        INSERT INTO tasks (
          id, workflow, item_id, run_id, task_kind, status, parent_task_id,
          data_json, input_json, control_state, priority, available_at,
          enqueued_at, current_attempt_id, parent_run_id, source, metadata_json,
          created_at, updated_at, terminal_at
        ) VALUES (
          @taskId, @workflow, @itemId, @runId, 'workflow_item', 'queued', @parentTaskId,
          '{}', @inputJson, 'queued', 0, @now,
          @now, NULL, @parentRunId, @source, @metadataJson,
          @now, @now, NULL
        )
      `).run({
        taskId,
        workflow: request.workflow,
        itemId,
        runId,
        parentTaskId: request.parentTaskId ?? null,
        inputJson,
        now,
        attemptId,
        parentRunId: request.parentRunId ?? null,
        source: request.source ?? 'daemon',
        metadataJson: request.metadata ? JSON.stringify(request.metadata) : null,
      })
      db.prepare(`
        INSERT INTO task_attempts (
          id, task_id, attempt_no, run_id, status, control_state,
          tracker_workflow, tracker_item_id, data_json, created_at, updated_at
        ) VALUES (
          @attemptId, @taskId, 1, @runId, 'queued', 'pending',
          @workflow, @itemId, '{}', @now, @now
        )
      `).run({ attemptId, taskId, runId, workflow: request.workflow, itemId, now })
      db.prepare(`
        UPDATE tasks
        SET current_attempt_id = @attemptId
        WHERE id = @taskId
      `).run({ taskId, attemptId })
      return {
        id: itemId,
        itemId,
        taskId,
        attemptId,
        runId,
        position: basePosition + index + 1,
      }
    })
  })
}

function claimNextTask(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now?: string; leaseMs?: number },
): ClaimedTask | null {
  const now = request.now ?? new Date().toISOString()
  const claimExpiresAt = new Date(Date.parse(now) + (request.leaseMs ?? 60_000)).toISOString()
  const canReturn = control.supportsUpdateReturning()
  return canReturn
    ? claimNextTaskReturning(db, control, { ...request, now, claimExpiresAt })
    : claimNextTaskFallback(db, control, { ...request, now, claimExpiresAt })
}

function claimNextTaskReturning(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now: string; claimExpiresAt: string },
): ClaimedTask | null {
  return control.transaction(() => {
    const row = db.prepare(`
      WITH next_task AS (
        SELECT id
        FROM tasks
        WHERE workflow = @workflow
          AND control_state = 'queued'
          AND COALESCE(available_at, created_at) <= @now
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies d
            WHERE d.parent_task_id = tasks.id
              AND d.status NOT IN ('satisfied', 'cancelled')
          )
        ORDER BY priority DESC, COALESCE(enqueued_at, created_at) ASC, rowid ASC
        LIMIT 1
      )
      UPDATE tasks
      SET control_state = 'claimed',
          claimed_by_worker_id = @workerId,
          claimed_at = @now,
          claim_expires_at = @claimExpiresAt,
          updated_at = @now
      WHERE id = (SELECT id FROM next_task)
      RETURNING *
    `).get(request) as TaskDbRow | undefined
    if (!row?.current_attempt_id) return null
    markAttemptClaimed(db, row.current_attempt_id, request.workerId, request.now)
    return claimedFromTaskRow(db, row, request.workerId)
  })
}

function claimNextTaskFallback(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now: string; claimExpiresAt: string },
): ClaimedTask | null {
  return control.transaction(() => {
    const next = db.prepare(`
      SELECT *
      FROM tasks
      WHERE workflow = @workflow
        AND control_state = 'queued'
        AND COALESCE(available_at, created_at) <= @now
        AND NOT EXISTS (
          SELECT 1
          FROM task_dependencies d
          WHERE d.parent_task_id = tasks.id
            AND d.status NOT IN ('satisfied', 'cancelled')
        )
      ORDER BY priority DESC, COALESCE(enqueued_at, created_at) ASC, rowid ASC
      LIMIT 1
    `).get(request) as TaskDbRow | undefined
    if (!next?.current_attempt_id) return null
    const info = db.prepare(`
      UPDATE tasks
      SET control_state = 'claimed',
          claimed_by_worker_id = @workerId,
          claimed_at = @now,
          claim_expires_at = @claimExpiresAt,
          updated_at = @now
      WHERE id = @taskId AND control_state = 'queued'
    `).run({ ...request, taskId: next.id })
    if (info.changes !== 1) return null
    markAttemptClaimed(db, next.current_attempt_id, request.workerId, request.now)
    const claimed = db.prepare('SELECT * FROM tasks WHERE id = ?').get(next.id) as TaskDbRow
    return claimedFromTaskRow(db, claimed, request.workerId)
  })
}

function markAttemptClaimed(db: Database.Database, attemptId: string, workerId: string, now: string): void {
  db.prepare(`
    UPDATE task_attempts
    SET control_state = 'claimed',
        worker_id = @workerId,
        claimed_at = @now,
        updated_at = @now
    WHERE id = @attemptId
  `).run({ attemptId, workerId, now })
}

function markTaskRunning(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; workerId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET control_state = 'running',
          status = 'running',
          claimed_by_worker_id = @workerId,
          current_attempt_id = @attemptId,
          updated_at = @now
      WHERE id = @taskId
    `).run({ ...request, now })
    db.prepare(`
      UPDATE task_attempts
      SET control_state = 'running',
          status = 'running',
          worker_id = @workerId,
          started_at = COALESCE(started_at, @now),
          updated_at = @now
      WHERE id = @attemptId
    `).run({ ...request, now })
  })
}

function markTaskDone(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; now?: string },
): void {
  markTerminal(db, control, { ...request, taskState: 'done', attemptState: 'done' })
}

function markTaskFailed(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; error: string; now?: string },
): void {
  markTerminal(db, control, { ...request, taskState: 'failed', attemptState: 'failed', error: request.error })
}

function markTaskCancelled(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; attemptId?: string; reason?: string; now?: string },
): void {
  const task = getTaskRaw(db, request.taskId)
  const attemptId = request.attemptId ?? task?.current_attempt_id ?? undefined
  markTerminal(db, control, {
    taskId: request.taskId,
    ...(attemptId ? { attemptId } : {}),
    taskState: 'cancelled',
    attemptState: 'cancelled',
    error: request.reason,
    now: request.now,
  })
}

function markTerminal(
  db: Database.Database,
  control: ControlDb,
  request: {
    taskId: string
    attemptId?: string
    taskState: Extract<TaskState, 'done' | 'failed' | 'cancelled'>
    attemptState: Extract<AttemptState, 'done' | 'failed' | 'cancelled'>
    error?: string
    now?: string
  },
): void {
  const now = request.now ?? new Date().toISOString()
  const legacyStatus = request.taskState
  control.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET control_state = @taskState,
          status = @legacyStatus,
          terminal_error = @error,
          terminal_at = COALESCE(terminal_at, @now),
          claimed_by_worker_id = CASE WHEN @taskState IN ('done', 'failed', 'cancelled') THEN NULL ELSE claimed_by_worker_id END,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId
    `).run({ ...request, legacyStatus, error: request.error ?? null, now })
    if (request.attemptId) {
      db.prepare(`
        UPDATE task_attempts
        SET control_state = @attemptState,
            status = @legacyStatus,
            failed_at = CASE WHEN @attemptState = 'failed' THEN COALESCE(failed_at, @now) ELSE failed_at END,
            terminal_at = COALESCE(terminal_at, @now),
            error = @error,
            updated_at = @now
        WHERE id = @attemptId
      `).run({ ...request, legacyStatus, error: request.error ?? null, now })
    }
  })
}

function requestCancelTask(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; reason?: string; now?: string },
): TaskRow | null {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const task = getTaskRaw(db, request.taskId)
    if (!task) return null
    const state = normalizeTaskState(task)
    if (state === 'queued' || state === 'waiting_dependencies' || state === 'blocked') {
      markTaskCancelled(db, control, {
        taskId: request.taskId,
        ...(task.current_attempt_id ? { attemptId: task.current_attempt_id } : {}),
        reason: request.reason,
        now,
      })
      return getMappedTask(db, request.taskId)
    }
    db.prepare(`
      UPDATE tasks
      SET control_state = 'cancel_requested',
          cancel_requested_at = @now,
          cancel_reason = @reason,
          updated_at = @now
      WHERE id = @taskId
    `).run({ taskId: request.taskId, reason: request.reason ?? null, now })
    if (task.current_attempt_id) {
      db.prepare(`
        UPDATE task_attempts
        SET control_state = 'cancel_requested',
            updated_at = @now
        WHERE id = @attemptId
      `).run({ attemptId: task.current_attempt_id, now })
    }
    return getMappedTask(db, request.taskId)
  })
}

function retryTaskFromAttempt(
  db: Database.Database,
  control: ControlDb,
  request: { runId: string; now?: string },
): EnqueuedTask {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const prior = db.prepare(`
      SELECT a.*, t.workflow, t.item_id, t.input_json
      FROM task_attempts a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.run_id = @runId
      LIMIT 1
    `).get({ runId: request.runId }) as (AttemptDbRow & { workflow: string; item_id: string; input_json: string }) | undefined
    if (!prior) throw new Error(`No task attempt found for runId ${request.runId}`)
    const nextAttemptNo = ((db.prepare(`
      SELECT COALESCE(MAX(attempt_no), 0) AS n
      FROM task_attempts
      WHERE task_id = ?
    `).get(prior.task_id) as { n: number }).n) + 1
    const attemptId = randomUUID()
    const runId = randomUUID()
    db.prepare(`
      INSERT INTO task_attempts (
        id, task_id, attempt_no, run_id, status, control_state,
        tracker_workflow, tracker_item_id, data_json, created_at, updated_at
      ) VALUES (
        @attemptId, @taskId, @attemptNo, @runId, 'queued', 'pending',
        @workflow, @itemId, '{}', @now, @now
      )
    `).run({
      attemptId,
      taskId: prior.task_id,
      attemptNo: nextAttemptNo,
      runId,
      workflow: prior.workflow,
      itemId: prior.item_id,
      now,
    })
    db.prepare(`
      UPDATE tasks
      SET control_state = 'queued',
          status = 'queued',
          run_id = @runId,
          current_attempt_id = @attemptId,
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          cancel_requested_at = NULL,
          cancel_reason = NULL,
          terminal_at = NULL,
          terminal_error = NULL,
          updated_at = @now
      WHERE id = @taskId
    `).run({ taskId: prior.task_id, runId, attemptId, now })
    const position = (db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE workflow = ? AND control_state = 'queued'
    `).get(prior.workflow) as { n: number }).n
    return {
      id: prior.item_id,
      itemId: prior.item_id,
      taskId: prior.task_id,
      attemptId,
      runId,
      position,
    }
  })
}

function createDependency(
  db: Database.Database,
  control: ControlDb,
  request: {
    parentTaskId: string
    childTaskId: string
    onChildFailed: ChildFailurePolicy
    cascadeCancel?: boolean
    resumeParentAfterChildRetry?: boolean
    now?: string
  },
): string {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const id = randomUUID()
    db.prepare(`
      INSERT INTO task_dependencies (
        id, parent_task_id, child_task_id, kind, status, failure_policy,
        on_child_failed, cascade_cancel, resume_parent_after_child_retry,
        metadata_json, result_json, created_at, updated_at, terminal_at
      ) VALUES (
        @id, @parentTaskId, @childTaskId, 'control', 'pending', @failurePolicy,
        @onChildFailed, @cascadeCancel, @resumeParentAfterChildRetry,
        '{}', '{}', @now, @now, NULL
      )
      ON CONFLICT(parent_task_id, child_task_id, kind) DO UPDATE SET
        status = 'pending',
        failure_policy = excluded.failure_policy,
        on_child_failed = excluded.on_child_failed,
        cascade_cancel = excluded.cascade_cancel,
        resume_parent_after_child_retry = excluded.resume_parent_after_child_retry,
        updated_at = excluded.updated_at,
        terminal_at = NULL
    `).run({
      id,
      parentTaskId: request.parentTaskId,
      childTaskId: request.childTaskId,
      failurePolicy: legacyFailurePolicy(request.onChildFailed),
      onChildFailed: request.onChildFailed,
      cascadeCancel: request.cascadeCancel === false ? 0 : 1,
      resumeParentAfterChildRetry: request.resumeParentAfterChildRetry === false ? 0 : 1,
      now,
    })
    db.prepare(`
      UPDATE tasks
      SET control_state = 'waiting_dependencies',
          status = 'waiting_on_children',
          updated_at = @now
      WHERE id = @parentTaskId AND control_state IN ('queued', 'waiting_dependencies')
    `).run({ parentTaskId: request.parentTaskId, now })
    const row = db.prepare(`
      SELECT id
      FROM task_dependencies
      WHERE parent_task_id = @parentTaskId AND child_task_id = @childTaskId AND kind = 'control'
    `).get(request) as { id: string }
    return row.id
  })
}

function markDependencyFromChildTerminal(
  db: Database.Database,
  control: ControlDb,
  request: { childTaskId: string; childState: 'done' | 'failed' | 'cancelled'; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    const deps = db.prepare(`
      SELECT id, parent_task_id, on_child_failed
      FROM task_dependencies
      WHERE child_task_id = @childTaskId AND status = 'pending'
    `).all({ childTaskId: request.childTaskId }) as Array<{
      id: string
      parent_task_id: string
      on_child_failed: ChildFailurePolicy
    }>
    for (const dep of deps) {
      if (request.childState === 'done') {
        setDependencyStatus(db, dep.id, 'satisfied', now)
        continue
      }
      if (request.childState === 'cancelled') {
        setDependencyStatus(db, dep.id, 'cancelled', now)
        continue
      }
      if (dep.on_child_failed === 'allow_partial') {
        setDependencyStatus(db, dep.id, 'satisfied', now)
      } else if (dep.on_child_failed === 'fail_parent') {
        setDependencyStatus(db, dep.id, 'failed', now)
        markParentTerminal(db, dep.parent_task_id, 'failed', now, 'child task failed')
      } else {
        setDependencyStatus(db, dep.id, 'failed', now)
        db.prepare(`
          UPDATE tasks
          SET control_state = 'blocked',
              status = 'failed',
              terminal_error = 'child task blocked parent',
              updated_at = @now
          WHERE id = @parentTaskId
        `).run({ parentTaskId: dep.parent_task_id, now })
      }
    }
    releaseParentsForChildren(db, [request.childTaskId], now)
  })
}

function releaseParentsIfDependenciesSatisfied(
  db: Database.Database,
  control: ControlDb,
  request: { childTaskId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => releaseParentsForChildren(db, [request.childTaskId], now))
}

function requestCancelParentAndChildren(
  db: Database.Database,
  control: ControlDb,
  request: { parentTaskId: string; reason?: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET control_state = 'cancelling',
          cancel_requested_at = @now,
          cancel_reason = @reason,
          updated_at = @now
      WHERE id = @parentTaskId
    `).run({ parentTaskId: request.parentTaskId, reason: request.reason ?? null, now })
    const children = db.prepare(`
      SELECT c.*
      FROM task_dependencies d
      JOIN tasks c ON c.id = d.child_task_id
      WHERE d.parent_task_id = @parentTaskId
        AND d.cascade_cancel = 1
        AND d.status = 'pending'
    `).all({ parentTaskId: request.parentTaskId }) as TaskDbRow[]
    for (const child of children) {
      const state = normalizeTaskState(child)
      if (isTerminalTaskState(state)) continue
      if (state === 'queued' || state === 'waiting_dependencies' || state === 'blocked') {
        markTaskCancelled(db, control, {
          taskId: child.id,
          ...(child.current_attempt_id ? { attemptId: child.current_attempt_id } : {}),
          reason: request.reason,
          now,
        })
      } else {
        requestCancelTask(db, control, { taskId: child.id, reason: request.reason, now })
      }
    }
    db.prepare(`
      UPDATE task_dependencies
      SET status = 'cancelled',
          updated_at = @now,
          terminal_at = COALESCE(terminal_at, @now)
      WHERE parent_task_id = @parentTaskId
        AND cascade_cancel = 1
        AND status = 'pending'
    `).run({ parentTaskId: request.parentTaskId, now })
    markTaskCancelled(db, control, { taskId: request.parentTaskId, reason: request.reason, now })
  })
}

async function waitForDependencies(
  db: Database.Database,
  request: { parentTaskId: string; timeoutMs?: number; pollMs?: number },
): Promise<void> {
  const started = Date.now()
  const timeoutMs = request.timeoutMs ?? 60_000
  const pollMs = request.pollMs ?? 500
  for (;;) {
    const parent = getTaskRaw(db, request.parentTaskId)
    if (!parent) throw new Error(`Parent task ${request.parentTaskId} not found`)
    const parentState = normalizeTaskState(parent)
    if (parentState === 'cancelled' || parentState === 'failed' || parentState === 'blocked') {
      throw new Error(`Parent task ${request.parentTaskId} is ${parentState}`)
    }
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM task_dependencies
      WHERE parent_task_id = ?
        AND status NOT IN ('satisfied', 'cancelled')
    `).get(request.parentTaskId) as { n: number }
    if (row.n === 0) return
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for dependencies for task ${request.parentTaskId}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

function returnTaskToQueued(
  db: Database.Database,
  control: ControlDb,
  request: { taskId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    const task = getTaskRaw(db, request.taskId)
    if (!task?.current_attempt_id) return
    db.prepare(`
      UPDATE tasks
      SET control_state = 'queued',
          status = 'queued',
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId AND control_state IN ('claimed', 'running')
    `).run({ taskId: request.taskId, now })
    db.prepare(`
      UPDATE task_attempts
      SET control_state = 'pending',
          status = 'queued',
          worker_id = NULL,
          claimed_at = NULL,
          updated_at = @now
      WHERE id = @attemptId AND control_state IN ('claimed', 'running')
    `).run({ attemptId: task.current_attempt_id, now })
  })
}

function recoverClaimsForDeadWorkers(
  db: Database.Database,
  control: ControlDb,
  request: { workflow: string; aliveWorkerIds: Set<string>; now?: string },
): number {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const rows = db.prepare(`
      SELECT id, claimed_by_worker_id
      FROM tasks
      WHERE workflow = @workflow
        AND control_state IN ('claimed', 'running')
        AND claimed_by_worker_id IS NOT NULL
        AND cancel_requested_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM worker_commands c
          WHERE c.target_task_id = tasks.id
            AND c.command_type IN ('cancel_task', 'force_stop_task')
            AND c.state IN ('queued', 'acknowledged')
        )
    `).all({ workflow: request.workflow }) as Array<{ id: string; claimed_by_worker_id: string }>
    let recovered = 0
    for (const row of rows) {
      if (request.aliveWorkerIds.has(row.claimed_by_worker_id)) continue
      returnTaskToQueued(db, control, { taskId: row.id, now })
      recovered++
    }
    return recovered
  })
}

function claimedFromTaskRow(db: Database.Database, row: TaskDbRow, workerId: string): ClaimedTask {
  if (!row.current_attempt_id) throw new Error(`Task ${row.id} has no current attempt`)
  const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(row.current_attempt_id) as AttemptDbRow
  const result: ClaimedTask = {
    taskId: row.id,
    attemptId: attempt.id,
    workflow: row.workflow,
    itemId: row.item_id,
    input: parseJson(row.input_json),
    runId: attempt.run_id,
    workerId,
  }
  if (row.parent_run_id) result.parentRunId = row.parent_run_id
  return result
}

function getTaskByRunId(db: Database.Database, runId: string): TaskRow | null {
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
  db: Database.Database,
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

function listTasksForWorkflow(db: Database.Database, workflow: string): TaskRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM tasks
    WHERE workflow = ?
    ORDER BY COALESCE(enqueued_at, created_at) ASC, rowid ASC
  `).all(workflow) as TaskDbRow[]
  return rows.map(mapTaskRow)
}

function getMappedTask(db: Database.Database, taskId: string): TaskRow | null {
  const row = getTaskRaw(db, taskId)
  return row ? mapTaskRow(row) : null
}

function getTaskRaw(db: Database.Database, taskId: string): TaskDbRow | null {
  return (db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskDbRow | undefined) ?? null
}

function markParentTerminal(
  db: Database.Database,
  parentTaskId: string,
  state: Extract<TaskState, 'failed' | 'cancelled'>,
  now: string,
  error?: string,
): void {
  db.prepare(`
    UPDATE tasks
    SET control_state = @state,
        status = @state,
        terminal_error = @error,
        terminal_at = COALESCE(terminal_at, @now),
        updated_at = @now
    WHERE id = @parentTaskId
  `).run({ parentTaskId, state, error: error ?? null, now })
  const row = getTaskRaw(db, parentTaskId)
  if (row?.current_attempt_id) {
    db.prepare(`
      UPDATE task_attempts
      SET control_state = @state,
          status = @state,
          terminal_at = COALESCE(terminal_at, @now),
          error = @error,
          updated_at = @now
      WHERE id = @attemptId
    `).run({ attemptId: row.current_attempt_id, state, error: error ?? null, now })
  }
}

function setDependencyStatus(
  db: Database.Database,
  dependencyId: string,
  status: 'satisfied' | 'failed' | 'cancelled',
  now: string,
): void {
  db.prepare(`
    UPDATE task_dependencies
    SET status = @status,
        updated_at = @now,
        terminal_at = COALESCE(terminal_at, @now)
    WHERE id = @dependencyId
  `).run({ dependencyId, status, now })
}

function releaseParentsForChildren(db: Database.Database, childTaskIds: string[], now: string): void {
  for (const childTaskId of childTaskIds) {
    const parents = db.prepare(`
      SELECT DISTINCT parent_task_id
      FROM task_dependencies
      WHERE child_task_id = ?
    `).all(childTaskId) as Array<{ parent_task_id: string }>
    for (const parent of parents) {
      const pending = db.prepare(`
        SELECT COUNT(*) AS n
        FROM task_dependencies
        WHERE parent_task_id = ?
          AND status NOT IN ('satisfied', 'cancelled')
      `).get(parent.parent_task_id) as { n: number }
      if (pending.n !== 0) continue
      db.prepare(`
        UPDATE tasks
        SET control_state = 'queued',
            status = 'queued',
            updated_at = @now
        WHERE id = @parentTaskId
          AND control_state = 'waiting_dependencies'
      `).run({ parentTaskId: parent.parent_task_id, now })
    }
  }
}

function mapTaskRow(row: TaskDbRow): TaskRow {
  const task: TaskRow = {
    taskId: row.id,
    workflow: row.workflow,
    itemId: row.item_id,
    input: parseJson(row.input_json),
    state: normalizeTaskState(row),
  }
  if (row.run_id) {
    task.runId = row.run_id
    task.currentRunId = row.run_id
  }
  if (row.parent_task_id) task.parentTaskId = row.parent_task_id
  if (row.parent_run_id) task.parentRunId = row.parent_run_id
  if (row.current_attempt_id) task.currentAttemptId = row.current_attempt_id
  if (row.claimed_by_worker_id) task.claimedByWorkerId = row.claimed_by_worker_id
  if (row.enqueued_at) task.enqueuedAt = row.enqueued_at
  if (row.claimed_at) task.claimedAt = row.claimed_at
  if (row.terminal_at) task.terminalAt = row.terminal_at
  if (row.terminal_error) task.error = row.terminal_error
  return task
}

function mapAttemptRow(row: AttemptDbRow): AttemptRow {
  const attempt: AttemptRow = {
    attemptId: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    runId: row.run_id,
    state: row.control_state ?? legacyAttemptState(row.status),
  }
  if (row.worker_id) attempt.workerId = row.worker_id
  return attempt
}

function normalizeTaskState(row: TaskDbRow): TaskState {
  return row.control_state ?? legacyTaskState(row.status)
}

function legacyTaskState(status: string): TaskState {
  if (status === 'waiting_on_children' || status === 'awaiting_child_results') return 'waiting_dependencies'
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'queued'
}

function legacyAttemptState(status: string): AttemptState {
  if (status === 'running') return 'running'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return 'pending'
}

function legacyFailurePolicy(policy: ChildFailurePolicy): 'record_unresolved' | 'fail_parent' | 'ignore' {
  if (policy === 'fail_parent') return 'fail_parent'
  if (policy === 'allow_partial') return 'ignore'
  return 'record_unresolved'
}

function isTerminalTaskState(state: TaskState): boolean {
  return state === 'done' || state === 'failed' || state === 'cancelled'
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}
