import { type Database } from '../../infra/sqlite/index.js'

import type { ControlDb } from '../control-db.js'
import {
  type ClaimedTask,
  type TaskRow,
  type TaskDbRow,
  getTaskRaw,
  mapTaskRow,
  parseJson,
} from './types.js'

export function claimNextTask(
  db: Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now?: string; leaseMs?: number },
): ClaimedTask | null {
  const now = request.now ?? new Date().toISOString()
  const claimExpiresAt = new Date(Date.parse(now) + (request.leaseMs ?? 60_000)).toISOString()
  return claimNextTaskReturning(db, control, { ...request, now, claimExpiresAt })
}

function claimNextTaskReturning(
  db: Database,
  control: ControlDb,
  request: { workflow: string; workerId: string; now: string; claimExpiresAt: string },
): ClaimedTask | null {
  return control.transaction(() => {
    const row = db.prepare(`
      WITH next_task AS (
        SELECT id
        FROM tasks
        WHERE workflow = @workflow
          AND task_kind = 'workflow_item'
          AND source = 'daemon'
          AND control_state = 'queued'
          AND COALESCE(available_at, created_at) <= @now
          AND NOT EXISTS (
            SELECT 1
            FROM task_dependencies d
            WHERE d.parent_task_id = tasks.id
              AND d.status NOT IN ('satisfied', 'cancelled')
          )
        -- Plain enqueued_at (NOT COALESCE(enqueued_at, created_at)): daemon
        -- workflow_item rows ALWAYS stamp enqueued_at at enqueue (enqueue.ts)
        -- and re-pend preserves it, so the COALESCE is dead here — and the
        -- wrapper defeated tasks_control_claimable_idx, forcing a TEMP B-TREE
        -- sort of the whole queued set on every claim (held under the write
        -- lock). Plain enqueued_at + the implicit-rowid tail let the index serve
        -- the full ORDER BY → LIMIT 1 first-row seek. Keep COALESCE on the
        -- display/list queries (queue.ts/queries.ts), which can see non-daemon rows.
        ORDER BY priority DESC, enqueued_at ASC, rowid ASC
        LIMIT 1
      )
      UPDATE tasks
      SET control_state = 'claimed',
          claimed_by_worker_id = @workerId,
          claimed_at = @now,
          claim_expires_at = @claimExpiresAt,
          claim_generation = claim_generation + 1,
          updated_at = @now
      WHERE id = (SELECT id FROM next_task)
      RETURNING *
    `).get(request) as TaskDbRow | undefined
    if (!row?.current_attempt_id) return null
    markAttemptClaimed(db, row.current_attempt_id, request.workerId, request.now)
    // The post-increment generation is the lease this worker now holds. A
    // re-pend + re-claim by a peer advances it again, so the original worker's
    // (now-stale) lease no longer matches and its terminal write is rejected
    // (ISS-005).
    return claimedFromTaskRow(db, row, request.workerId, row.claim_generation)
  })
}

/**
 * Extend the lease of an in-flight claim this worker still holds. Called on the
 * daemon's worker heartbeat so a LIVE worker actively processing a long item
 * (longer than the lease window) keeps a fresh `claim_expires_at` — otherwise
 * the lease expires mid-run and `recoverClaimsForDeadWorkers` re-pends the item
 * (it recovers on lease expiry regardless of worker liveness), letting a peer
 * (a freshly added worker's startup recovery, or an idle peer's keepalive tick)
 * claim and run the SAME item. The two guards keep renewal honest:
 *   - `claimed_by_worker_id = @workerId` — only the current owner renews; a
 *     stale worker whose item was reassigned to a peer (claimed_by now the peer,
 *     or NULL) matches no row and no-ops, so it can't keep a handed-off lease
 *     alive.
 *   - `control_state IN ('claimed','running')` — a terminalized/queued task is
 *     never re-leased.
 * Returns whether the lease was actually extended (a row matched).
 */
export function renewClaim(
  db: Database,
  control: ControlDb,
  request: { taskId: string; workerId: string; now?: string; leaseMs?: number },
): boolean {
  const now = request.now ?? new Date().toISOString()
  const claimExpiresAt = new Date(Date.parse(now) + (request.leaseMs ?? 60_000)).toISOString()
  return control.transaction(() => {
    const result = db.prepare(`
      UPDATE tasks
      SET claim_expires_at = @claimExpiresAt,
          updated_at = @now
      WHERE id = @taskId
        AND claimed_by_worker_id = @workerId
        AND control_state IN ('claimed', 'running')
    `).run({ taskId: request.taskId, workerId: request.workerId, claimExpiresAt, now })
    return result.changes > 0
  })
}

export function markAttemptClaimed(db: Database, attemptId: string, workerId: string, now: string): void {
  db.prepare(`
    UPDATE task_attempts
    SET control_state = 'claimed',
        worker_id = @workerId,
        claimed_at = @now,
        updated_at = @now
    WHERE id = @attemptId
  `).run({ attemptId, workerId, now })
}

export function markTaskRunning(
  db: Database,
  control: ControlDb,
  request: { taskId: string; attemptId: string; workerId: string; now?: string },
): void {
  const now = request.now ?? new Date().toISOString()
  control.transaction(() => {
    // Stomp guard: only the worker that still holds the claim (or an unclaimed
    // task — the in-process path enqueues then marks running with claimed_by
    // NULL) may flip to running. A STALE worker whose item was re-pended and
    // re-claimed by a PEER (claimed_by_worker_id now = the peer) matches no row,
    // so it can't overwrite claimed_by_worker_id / current_attempt_id and
    // mislead recoverClaimsForDeadWorkers. The terminal write is lease-guarded
    // (ISS-005); this guards the running transition.
    const result = db.prepare(`
      UPDATE tasks
      SET control_state = 'running',
          claimed_by_worker_id = @workerId,
          current_attempt_id = @attemptId,
          updated_at = @now
      WHERE id = @taskId
        AND (claimed_by_worker_id IS NULL OR claimed_by_worker_id = @workerId)
    `).run({ ...request, now })
    // No-op task UPDATE = a peer superseded this claim; leave the attempt row
    // untouched too so task + attempt stay in lockstep.
    if (result.changes === 0) return
    db.prepare(`
      UPDATE task_attempts
      SET control_state = 'running',
          worker_id = @workerId,
          started_at = COALESCE(started_at, @now),
          updated_at = @now
      WHERE id = @attemptId
    `).run({ ...request, now })
  })
}

/**
 * Un-claim an in-flight item back to `queued` (reassign / dead-worker recovery),
 * KEEPING the same attempt + runId so the run continues on a peer. The
 * `claim_generation` bump (ISS-005) is the important part: it advances the lease
 * AT re-pend time, not only at the peer's next claim, so a stale-but-alive
 * original worker that calls `markTask*({claimGeneration})` in the window
 * BEFORE a peer re-claims now matches no row and no-ops — closing the
 * re-pend-before-reclaim gap the per-claim bump alone left open.
 */
export function returnTaskToQueued(
  db: Database,
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
          claimed_by_worker_id = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          claim_generation = claim_generation + 1,
          updated_at = @now
      WHERE id = @taskId AND control_state IN ('claimed', 'running')
    `).run({ taskId: request.taskId, now })
    db.prepare(`
      UPDATE task_attempts
      SET control_state = 'pending',
          worker_id = NULL,
          claimed_at = NULL,
          updated_at = @now
      WHERE id = @attemptId AND control_state IN ('claimed', 'running')
    `).run({ attemptId: task.current_attempt_id, now })
  })
}

export function recoverClaimsForDeadWorkers(
  db: Database,
  control: ControlDb,
  request: { workflow: string; aliveWorkerIds: Set<string>; now?: string },
): TaskRow[] {
  const now = request.now ?? new Date().toISOString()
  return control.transaction(() => {
    const rows = db.prepare(`
      SELECT *
      FROM tasks
      WHERE workflow = @workflow
        AND task_kind = 'workflow_item'
        AND source = 'daemon'
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
    `).all({ workflow: request.workflow }) as TaskDbRow[]
    const recovered: TaskRow[] = []
    for (const row of rows) {
      const leaseExpired = row.claim_expires_at !== null && row.claim_expires_at <= now
      if (!row.claimed_by_worker_id || (!leaseExpired && request.aliveWorkerIds.has(row.claimed_by_worker_id))) continue
      recovered.push(mapTaskRow(row))
      returnTaskToQueued(db, control, { taskId: row.id, now })
    }
    return recovered
  })
}

function claimedFromTaskRow(
  db: Database,
  row: TaskDbRow,
  workerId: string,
  claimGeneration: number,
): ClaimedTask {
  if (!row.current_attempt_id) throw new Error(`Task ${row.id} has no current attempt`)
  const attempt = db.prepare('SELECT * FROM task_attempts WHERE id = ?').get(row.current_attempt_id) as { id: string; run_id: string } | undefined
  if (!attempt) {
    throw new Error(`claimedFromTaskRow: attempt ${row.current_attempt_id} not found for task ${row.id} (race?)`)
  }
  const result: ClaimedTask = {
    taskId: row.id,
    attemptId: attempt.id,
    workflow: row.workflow,
    itemId: row.item_id,
    input: parseJson(row.input_json),
    runId: attempt.run_id,
    workerId,
    claimGeneration,
  }
  if (row.parent_run_id) result.parentRunId = row.parent_run_id
  return result
}
