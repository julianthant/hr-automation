import { randomUUID } from 'node:crypto'

import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import { type EnqueuedTask, type AttemptDbRow, getTaskRaw } from './types.js'

/**
 * Thrown when {@link retryTaskFromAttempt} is called with `blockedControlStates`
 * and the target task has become one of those states (claimed/running/…) BETWEEN
 * the control layer's non-transactional state pre-check and the retry UPDATE.
 * The retry is refused loud so a daemon that claimed the row mid-retry keeps
 * running the prior attempt instead of the retry silently resetting it to
 * `queued` (double execution). Carries the observed `controlState` for a legible
 * operator-facing error.
 */
export class RetryTaskBecameActiveError extends Error {
  readonly controlState: string
  readonly runId: string
  constructor(runId: string, controlState: string) {
    super(
      `retryTaskFromAttempt: task for runId=${runId} became '${controlState}' after the retry state check — ` +
        `a daemon claimed it mid-retry. Cancel the active attempt before retrying.`,
    )
    this.name = 'RetryTaskBecameActiveError'
    this.controlState = controlState
    this.runId = runId
  }
}

export function retryTaskFromAttempt(
  db: Database,
  control: ControlDb,
  request: { runId: string; now?: string; blockedControlStates?: readonly string[] },
): EnqueuedTask {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const prior = db.prepare(`
      SELECT a.*, t.workflow, t.item_id, t.original_input_json, t.parent_run_id
      FROM task_attempts a
      JOIN tasks t ON t.id = a.task_id
      WHERE a.run_id = @runId
      LIMIT 1
    `).get({ runId: request.runId }) as (AttemptDbRow & {
      workflow: string
      item_id: string
      original_input_json: string | null
      parent_run_id: string | null
    }) | undefined
    if (!prior) throw new Error(`No task attempt found for runId ${request.runId}`)
    /**
     * Contract 2 (Uniform Retry): the new attempt runs against the PRISTINE
     * original input the task was first enqueued with. Reset input_json to
     * original_input_json so the daemon's claim path (parseJson(row.input_json))
     * hands the handler the same payload the first attempt saw, with no
     * accumulated state from intervening edits or adopt-existing overwrites.
     *
     * Legacy rows from before migration 11 have original_input_json = NULL.
     * The retry path throws hard for those rows instead of silently falling
     * back to current input_json, because retrying mutated input violates the
     * Contract 2 replay invariant.
     */
    if (prior.original_input_json == null) {
      throw new Error(
        `retryTaskFromAttempt: task ${prior.task_id} has no original_input_json (legacy pre-migration-11 row). Contract 2 requires every retryable row to have original_input_json. Either delete the row and re-enqueue, or repair the row manually.`,
      )
    }
    const resetInputJson = prior.original_input_json
    const nextAttemptNo = ((db.prepare(`
      SELECT COALESCE(MAX(attempt_no), 0) AS n
      FROM task_attempts
      WHERE task_id = ?
    `).get(prior.task_id) as { n: number }).n) + 1
    const attemptId = randomUUID()
    const runId = randomUUID()
    // Guard the retry UPDATE itself with the caller's blocked-state set so the
    // check + reset are ATOMIC. The control layer does a non-transactional
    // pre-read of control_state, but a daemon can claim the row between that
    // read and here (queued → claimed); an unguarded reset would then re-queue
    // a task a worker is actively running (double execution). With the
    // predicate, a mid-retry claim makes the UPDATE match 0 rows and we throw
    // so the retry is refused. Also bump `claim_generation` (mirrors
    // returnTaskToQueued, ISS-005): a stale worker that raced in and claimed the
    // OLD attempt holds a now-behind lease, so its terminal write no-ops rather
    // than overwriting this fresh retry.
    const blocked = request.blockedControlStates ?? []
    const blockedParams: Record<string, string> = {}
    const blockedPlaceholders = blocked.map((state, i) => {
      const key = `blk${i}`
      blockedParams[key] = state
      return `@${key}`
    })
    db.prepare(`
      INSERT INTO task_attempts (
        id, task_id, attempt_no, run_id, control_state,
        tracker_workflow, tracker_item_id, data_json, created_at, updated_at
      ) VALUES (
        @attemptId, @taskId, @attemptNo, @runId, 'pending',
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
    const result = db.prepare(`
      UPDATE tasks
      SET control_state = 'queued',
          run_id = @runId,
          input_json = @resetInputJson,
          current_attempt_id = @attemptId,
          claim_generation = claim_generation + 1,
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          cancel_requested_at = NULL,
          cancel_reason = NULL,
          terminal_at = NULL,
          terminal_error = NULL,
          parent_run_id = parent_run_id,
          updated_at = @now
      WHERE id = @taskId
      ${blockedPlaceholders.length > 0 ? `AND control_state NOT IN (${blockedPlaceholders.join(', ')})` : ''}
    `).run({ taskId: prior.task_id, runId, resetInputJson, attemptId, now, ...blockedParams })
    if (blocked.length > 0 && result.changes === 0) {
      // The row exists (we SELECTed it above) and is in the same transaction, so
      // a 0-row UPDATE can only mean the blocked-state predicate excluded it —
      // i.e. the task became active between the pre-check and now. Re-read its
      // current state for a legible error, then throw (rolls back the attempt
      // INSERT above).
      const current = getTaskRaw(db, prior.task_id)
      throw new RetryTaskBecameActiveError(request.runId, current?.control_state ?? 'unknown')
    }
    const position = (db.prepare(`
      SELECT COUNT(*) AS n
      FROM tasks
      WHERE workflow = ?
        AND task_kind = 'workflow_item'
        AND source = 'daemon'
        AND control_state = 'queued'
    `).get(prior.workflow) as { n: number }).n
    return {
      id: prior.item_id,
      itemId: prior.item_id,
      taskId: prior.task_id,
      attemptId,
      runId,
      position,
      ...(prior.parent_run_id ? { parentRunId: prior.parent_run_id } : {}),
    }
  })
}
