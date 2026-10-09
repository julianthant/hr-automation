import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type TaskRow,
  type TaskState,
  type AttemptState,
  type TaskDbRow,
  type CancelTaskResult,
  type TaskTransitionOutcome,
  getTaskRaw,
  getMappedTask,
  normalizeTaskState,
  isTerminalTaskState,
} from './types.js'
import { returnTaskToQueued } from './claim.js'

export function markTaskDone(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; workerId?: string; claimGeneration?: number; now?: string },
): TaskTransitionOutcome {
  return markTerminal(db, control, { ...request, taskState: 'done', attemptState: 'done' })
}

export function markTaskFailed(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; error: string; workerId?: string; claimGeneration?: number; now?: string },
): TaskTransitionOutcome {
  return markTerminal(db, control, { ...request, taskState: 'failed', attemptState: 'failed', error: request.error })
}

export function markTaskBlockedUncertain(
  db: Database,
  control: ControlDb,
  request: {
    taskId: string
    attemptId: string
    workerId: string
    claimGeneration: number
    error: string
    now?: string
  },
): TaskTransitionOutcome {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const result = db.prepare(`
      UPDATE tasks
      SET control_state = 'blocked',
          terminal_error = @error,
          terminal_at = COALESCE(terminal_at, @now),
          claimed_by_worker_id = NULL,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId
        AND control_state IN ('claimed', 'running')
        AND current_attempt_id = @attemptId
        AND claimed_by_worker_id = @workerId
        AND claim_generation = @claimGeneration
        AND terminal_at IS NULL
    `).run({ ...request, now })
    if (result.changes === 0) {
      const current = getTaskRaw(db, request.taskId)
      if (!current) return { kind: 'not-found' }
      const state = normalizeTaskState(current)
      if (isTerminalTaskState(state)) return { kind: 'already-terminal', state }
      return { kind: 'lease-lost' }
    }
    const attempt = db.prepare(`
      UPDATE task_attempts
      SET control_state = 'failed',
          failed_at = COALESCE(failed_at, @now),
          terminal_at = COALESCE(terminal_at, @now),
          error = @error,
          updated_at = @now
      WHERE id = @attemptId AND task_id = @taskId
    `).run({ ...request, now })
    if (attempt.changes === 0) {
      throw new Error(`markTaskBlockedUncertain: attempt ${request.attemptId} did not update; rolling back`)
    }
    return { kind: 'applied' }
  })
}

/**
 * Fail a task ONLY if it is not already terminal, returning whether THIS call
 * won the transition (the guarded UPDATE changed a row). For the cross-process
 * queued-orphan sweep (E2E-105): on a simultaneous workflow-scoped stop-all,
 * several dying daemons can each elect themselves the queue owner, but the
 * run-registry single-terminal-write token is per-PROCESS and can't dedupe
 * across daemon processes. SQLite `control_state` is the only cross-process
 * authority — the `terminal_at IS NULL` guard lets exactly ONE daemon transition
 * the task; the losers get `false` and skip their duplicate audit/tracker rows.
 * (Distinct from the `markTask*` family's COALESCE(terminal_at) idempotency,
 * which keeps the WHERE matching the row — so changes>0 can't tell winner from
 * loser.)
 */
export function markTaskFailedIfActive(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId?: string; error: string; now?: string },
): boolean {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const result = db.prepare(`
      UPDATE tasks
      SET control_state = 'failed',
          terminal_error = @error,
          terminal_at = @now,
          claimed_by_worker_id = NULL,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId AND terminal_at IS NULL
    `).run({ taskId: request.taskId, error: request.error, now })
    if (result.changes === 0) return false
    if (request.attemptId) {
      const attemptResult = db.prepare(`
        UPDATE task_attempts
        SET control_state = 'failed',
            failed_at = COALESCE(failed_at, @now),
            terminal_at = COALESCE(terminal_at, @now),
            error = @error,
            updated_at = @now
        WHERE id = @attemptId
      `).run({ attemptId: request.attemptId, error: request.error, now })
      if (attemptResult.changes === 0) {
        throw new Error(`markTaskFailedIfActive: attempt ${request.attemptId} did not update; rolling back`)
      }
    }
    return true
  })
}

export function markTaskCancelled(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId?: string; reason?: string; workerId?: string; claimGeneration?: number; now?: string },
): TaskTransitionOutcome {
  const task = getTaskRaw(db, request.taskId)
  const attemptId = request.attemptId ?? task?.current_attempt_id ?? undefined
  return markTerminal(db, control, {
    taskId: request.taskId,
    ...(attemptId ? { attemptId } : {}),
    taskState: 'cancelled',
    attemptState: 'cancelled',
    error: request.reason,
    ...(request.claimGeneration !== undefined ? { claimGeneration: request.claimGeneration } : {}),
    ...(request.workerId !== undefined ? { workerId: request.workerId } : {}),
    now: request.now,
  })
}

function markTerminal(
  db: Database,
  control: ControlDb,
  request: {
    taskId: string
    attemptId?: string
    taskState: Extract<TaskState, 'done' | 'failed' | 'cancelled'>
    attemptState: Extract<AttemptState, 'done' | 'failed' | 'cancelled'>
    error?: string
    /**
     * The claim lease the completing worker holds (ISS-005). When provided, the
     * task is terminalized ONLY if its `claim_generation` still equals this
     * value — so a worker whose item was re-pended and re-claimed by a peer
     * (its lease now stale) cannot complete the run the peer owns. The attempt
     * row is only stamped when the guarded task UPDATE actually fired, keeping
     * the attempt + task in lockstep on a rejected stale write. Omitted (legacy
     * / non-daemon callers) → unconditional, the prior behavior.
     */
    claimGeneration?: number
    workerId?: string
    now?: string
  },
): TaskTransitionOutcome {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const generationGuard = request.claimGeneration !== undefined ? 'AND claim_generation = @claimGeneration' : ''
    const attemptGuard = request.attemptId !== undefined ? 'AND current_attempt_id = @attemptId' : ''
    const workerGuard = request.workerId !== undefined ? 'AND claimed_by_worker_id = @workerId' : ''
    const result = db.prepare(`
      UPDATE tasks
      SET control_state = @taskState,
          terminal_error = @error,
          terminal_at = COALESCE(terminal_at, @now),
          claimed_by_worker_id = CASE WHEN @taskState IN ('done', 'failed', 'cancelled') THEN NULL ELSE claimed_by_worker_id END,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId AND terminal_at IS NULL
      ${generationGuard}
      ${attemptGuard}
      ${workerGuard}
    `).run({
      ...request,
      error: request.error ?? null,
      ...(request.claimGeneration !== undefined ? { claimGeneration: request.claimGeneration } : {}),
      ...(request.workerId !== undefined ? { workerId: request.workerId } : {}),
      now,
    })
    if (result.changes === 0) {
      const current = getTaskRaw(db, request.taskId)
      if (!current) return { kind: 'not-found' }
      const state = normalizeTaskState(current)
      if (isTerminalTaskState(state)) return { kind: 'already-terminal', state }
      return { kind: 'lease-lost' }
    }
    if (request.attemptId) {
      const attemptResult = db.prepare(`
        UPDATE task_attempts
        SET control_state = @attemptState,
            failed_at = CASE WHEN @attemptState = 'failed' THEN COALESCE(failed_at, @now) ELSE failed_at END,
            terminal_at = COALESCE(terminal_at, @now),
            error = @error,
            updated_at = @now
        WHERE id = @attemptId
      `).run({ ...request, error: request.error ?? null, now })
      if (attemptResult.changes === 0) {
        throw new Error(
          `markTerminal: task ${request.taskId} updated but attempt ${request.attemptId} did not update; rolling back`,
        )
      }
    }
    return { kind: 'applied' }
  })
}

export function requestCancelTask(
  db: Database,
  control: ControlDb,
  request: { taskId: string; reason?: string; now?: string },
): CancelTaskResult {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const task = getTaskRaw(db, request.taskId)
    if (!task) return { kind: 'not-found' }
    const state = normalizeTaskState(task)
    if (isTerminalTaskState(state)) {
      return { kind: 'already-terminal', task: mapRequiredTask(db, request.taskId) }
    }
    if (state === 'cancel_requested' || state === 'cancelling') {
      return {
        kind: 'accepted',
        disposition: 'already-requested',
        task: mapRequiredTask(db, request.taskId),
      }
    }
    if (state === 'queued' || state === 'waiting_dependencies' || state === 'blocked') {
      markTaskCancelled(db, control, {
        taskId: request.taskId,
        ...(task.current_attempt_id ? { attemptId: task.current_attempt_id } : {}),
        reason: request.reason,
        now,
      })
      return {
        kind: 'accepted',
        disposition: 'cancelled-before-run',
        task: mapRequiredTask(db, request.taskId),
      }
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
    return {
      kind: 'accepted',
      disposition: 'requested',
      task: mapRequiredTask(db, request.taskId),
    }
  })
}

function mapRequiredTask(db: Database, taskId: string): TaskRow {
  const task = getMappedTask(db, taskId)
  if (!task) throw new Error(`requestCancelTask: task ${taskId} disappeared inside its transaction`)
  return task
}

export function requestCancelParentAndChildren(
  db: Database,
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

// Re-export for use by child-state.ts which needs returnTaskToQueued indirectly
export { returnTaskToQueued }
