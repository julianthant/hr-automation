import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type TaskRow,
  type TaskState,
  type AttemptState,
  type TaskDbRow,
  getTaskRaw,
  getMappedTask,
  normalizeTaskState,
  isTerminalTaskState,
} from './types.js'
import { returnTaskToQueued } from './claim.js'

export function markTaskDone(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; now?: string },
): void {
  markTerminal(db, control, { ...request, taskState: 'done', attemptState: 'done' })
}

export function markTaskFailed(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; error: string; now?: string },
): void {
  markTerminal(db, control, { ...request, taskState: 'failed', attemptState: 'failed', error: request.error })
}

export function markTaskCancelled(
  db: Database,
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
  db: Database,
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
  control.transaction(() => {
    db.prepare(`
      UPDATE tasks
      SET control_state = @taskState,
          terminal_error = @error,
          terminal_at = COALESCE(terminal_at, @now),
          claimed_by_worker_id = CASE WHEN @taskState IN ('done', 'failed', 'cancelled') THEN NULL ELSE claimed_by_worker_id END,
          claim_expires_at = NULL,
          updated_at = @now
      WHERE id = @taskId
    `).run({ ...request, error: request.error ?? null, now })
    if (request.attemptId) {
      db.prepare(`
        UPDATE task_attempts
        SET control_state = @attemptState,
            failed_at = CASE WHEN @attemptState = 'failed' THEN COALESCE(failed_at, @now) ELSE failed_at END,
            terminal_at = COALESCE(terminal_at, @now),
            error = @error,
            updated_at = @now
        WHERE id = @attemptId
      `).run({ ...request, error: request.error ?? null, now })
    }
  })
}

export function requestCancelTask(
  db: Database,
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
