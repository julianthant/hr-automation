import { randomUUID } from 'node:crypto'

import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type TaskState,
  type ChildFailurePolicy,
  getTaskRaw,
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
    existingPolicy?: 'reset' | 'idempotent'
    now?: string
  },
): string {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const existing = db.prepare(`
      SELECT id, failure_policy, on_child_failed, cascade_cancel, resume_parent_after_child_retry
      FROM task_dependencies
      WHERE parent_task_id = @parentTaskId AND child_task_id = @childTaskId AND kind = 'control'
    `).get(request) as {
      id: string
      failure_policy: string
      on_child_failed: string
      cascade_cancel: number
      resume_parent_after_child_retry: number
    } | undefined
    const expectedFailurePolicy =
      request.onChildFailed === 'fail_parent'
        ? 'fail_parent'
        : request.onChildFailed === 'allow_partial'
          ? 'ignore'
          : 'record_unresolved'
    const expectedCascade = request.cascadeCancel === false ? 0 : 1
    const expectedResume = request.resumeParentAfterChildRetry === false ? 0 : 1
    if (existing && request.existingPolicy === 'idempotent') {
      if (
        existing.failure_policy !== expectedFailurePolicy ||
        existing.on_child_failed !== request.onChildFailed ||
        existing.cascade_cancel !== expectedCascade ||
        existing.resume_parent_after_child_retry !== expectedResume
      ) {
        throw new Error(
          `createDependency idempotent replay disagrees with persisted dependency ${existing.id}`,
        )
      }
      return existing.id
    }
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
      failurePolicy: expectedFailurePolicy,
      onChildFailed: request.onChildFailed,
      cascadeCancel: expectedCascade,
      resumeParentAfterChildRetry: expectedResume,
      now,
    })
    db.prepare(`
      UPDATE tasks
      SET control_state = 'waiting_dependencies',
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

/**
 * A parent task flipped `waiting_dependencies → queued` by a dependency
 * release. The CALLER must wake the parent workflow's daemons: the flip is
 * pure SQLite, and an idle daemon's claim loop only re-polls on a /wake or
 * its 15-min keepalive tick — without the wake a released task sat queued
 * for up to that whole window (E2E-017).
 */
export interface ReleasedParentTask {
  taskId: string
  workflow: string
}

export function markDependencyFromChildTerminal(
  db: Database,
  control: ControlDb,
  request: { childTaskId: string; childState: 'done' | 'failed' | 'cancelled'; now?: string },
): ReleasedParentTask[] {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
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
              terminal_error = 'child task blocked parent',
              updated_at = @now
          WHERE id = @parentTaskId
        `).run({ parentTaskId: dep.parent_task_id, now })
      }
    }
    return releaseParentsForChildren(db, [request.childTaskId], now)
  })
}

export function releaseParentsIfDependenciesSatisfied(
  db: Database,
  control: ControlDb,
  request: { childTaskId: string; now?: string },
): ReleasedParentTask[] {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => releaseParentsForChildren(db, [request.childTaskId], now))
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

function releaseParentsForChildren(
  db: Database,
  childTaskIds: string[],
  now: string,
): ReleasedParentTask[] {
  if (childTaskIds.length === 0) return []
  const released: ReleasedParentTask[] = []
  // ONE grouped query for the releasable set: candidate parents of ANY of these
  // children whose dependencies are now ALL settled and that are still waiting.
  // This replaces the old per-child × per-parent loop (DISTINCT parents, then a
  // COUNT-pending per parent, then a workflow/task_kind SELECT per parent) — an
  // N+1 that, under a wide fan-out burst (OCR approving many signers settling
  // near-simultaneously), ran 3 uncorrelated queries per parent inside the
  // BEGIN IMMEDIATE settle transaction, lengthening the held write-lock. The
  // NOT EXISTS replaces the COUNT; folding workflow/task_kind into the same
  // SELECT drops the per-parent lookup; DISTINCT-via-IN dedupes shared parents.
  const placeholders = childTaskIds.map(() => '?').join(', ')
  const candidates = db.prepare(`
    SELECT t.id AS parent_task_id, t.workflow, t.task_kind
    FROM tasks t
    WHERE t.id IN (
      SELECT DISTINCT parent_task_id
      FROM task_dependencies
      WHERE child_task_id IN (${placeholders})
    )
      AND t.control_state = 'waiting_dependencies'
      AND NOT EXISTS (
        SELECT 1
        FROM task_dependencies d
        WHERE d.parent_task_id = t.id
          AND d.status NOT IN ('satisfied', 'cancelled')
      )
  `).all(...childTaskIds) as Array<{ parent_task_id: string; workflow: string; task_kind: string | null }>

  for (const parent of candidates) {
    // A task_kind=ocr parent is a dependency ANCHOR, not daemon work — no
    // daemon ever claims an "ocr" task, so flipping it to queued strands a
    // zombie (E2E-003). Its job ends when the last dependency settles:
    // terminalize it here, at the flip site, because this generic settle
    // path usually wins the race against the OCR scheduler's own tick.
    if (parent.task_kind === 'ocr') {
      db.prepare(`
        UPDATE tasks
        SET control_state = 'done',
            terminal_at = COALESCE(terminal_at, @now),
            updated_at = @now
        WHERE id = @parentTaskId
          AND control_state = 'waiting_dependencies'
      `).run({ parentTaskId: parent.parent_task_id, now })
      continue
    }
    const result = db.prepare(`
      UPDATE tasks
      SET control_state = 'queued',
          updated_at = @now
      WHERE id = @parentTaskId
        AND control_state = 'waiting_dependencies'
    `).run({ parentTaskId: parent.parent_task_id, now })
    if (result.changes === 0) continue
    released.push({ taskId: parent.parent_task_id, workflow: parent.workflow })
  }
  return released
}
