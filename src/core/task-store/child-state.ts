import { randomUUID } from 'node:crypto'

import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type TaskState,
  type ChildFailurePolicy,
  getTaskRaw,
  legacyFailurePolicy,
  normalizeTaskState,
} from './types.js'

export function createDependency(
  db: Database,
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

export function markDependencyFromChildTerminal(
  db: Database,
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

export function releaseParentsIfDependenciesSatisfied(
  db: Database,
  control: ControlDb,
  request: { childTaskId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => releaseParentsForChildren(db, [request.childTaskId], now))
}

export async function waitForDependencies(
  db: Database,
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

function markParentTerminal(
  db: Database,
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
  db: Database,
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

function releaseParentsForChildren(db: Database, childTaskIds: string[], now: string): void {
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
