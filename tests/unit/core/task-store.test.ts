import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openControlDb } from '../../../src/core/control-db.js'
import {
  createTaskStore,
  type ControlTaskStore,
} from '../../../src/core/task-store/index.js'
import { parseJson } from '../../../src/core/task-store/types.js'

function iso(n: number): string {
  return `2026-05-04T12:00:${String(n).padStart(2, '0')}.000Z`
}

/** ISO timestamp `seconds` after a fixed base — spans past 60s (unlike `iso`). */
function isoAt(seconds: number): string {
  return new Date(Date.parse('2026-05-04T12:00:00.000Z') + seconds * 1000).toISOString()
}

function openTempStore(): { dir: string; store: ControlTaskStore } {
  const dir = mkdtempSync(join(tmpdir(), 'task-store-'))
  const ctl = openControlDb({ path: join(dir, 'control.sqlite') })
  return { dir, store: createTaskStore(ctl) }
}

test('enqueueTasks creates tasks plus pending attempts', () => {
  const { dir, store } = openTempStore()
  try {
    const enqueued = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }, { id: 'b' }],
      deriveItemId: (input) => input.id,
      now: iso(1),
    })

    assert.equal(enqueued.length, 2)
    assert.equal(enqueued[0].itemId, 'a')
    assert.equal(enqueued[0].position, 1)
    assert.match(enqueued[0].taskId, /^[0-9a-f-]{36}$/)
    assert.match(enqueued[0].attemptId, /^[0-9a-f-]{36}$/)
    assert.match(enqueued[0].runId, /^[0-9a-f-]{36}$/)

    const rows = store.listTasksForWorkflow('wf')
    assert.deepEqual(rows.map((row) => row.itemId), ['a', 'b'])
    assert.deepEqual(rows.map((row) => row.state), ['queued', 'queued'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idempotent enqueue reuses an exact terminal task without resurrecting it', () => {
  const { dir, store } = openTempStore()
  try {
    const request = {
      workflow: 'oath-signature',
      inputs: [{ emplId: '10000001' }],
      deriveItemId: () => 'signer-1',
      runIds: ['stable-child-run'],
      parentRunId: 'approval-parent',
    }
    const [first] = store.enqueueTasks(request)
    store.db.prepare(`
      UPDATE tasks SET control_state = 'done', terminal_at = @now WHERE id = @taskId
    `).run({ taskId: first.taskId, now: iso(1) })
    store.db.prepare(`
      UPDATE task_attempts SET control_state = 'done', terminal_at = @now WHERE id = @attemptId
    `).run({ attemptId: first.attemptId, now: iso(1) })

    const [replay] = store.enqueueTasks({ ...request, existingTaskPolicy: 'idempotent' })
    assert.equal(replay.taskId, first.taskId)
    assert.equal(replay.attemptId, first.attemptId)
    assert.equal(store.getTask(first.taskId)?.state, 'done')
    assert.equal(store.listAttemptsForTask(first.taskId).length, 1)

    assert.throws(
      () => store.enqueueTasks({
        ...request,
        inputs: [{ emplId: '10000002' }],
        existingTaskPolicy: 'idempotent',
      }),
      /input.*disagrees/i,
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('idempotent dependency reconciliation preserves a satisfied dependency', () => {
  const { dir, store } = openTempStore()
  try {
    const [parent] = store.enqueueTasks({ workflow: 'parent', inputs: [{ id: 'p' }], deriveItemId: (x) => x.id })
    const [child] = store.enqueueTasks({ workflow: 'child', inputs: [{ id: 'c' }], deriveItemId: (x) => x.id })
    const dependencyId = store.createDependency({
      parentTaskId: parent.taskId,
      childTaskId: child.taskId,
      onChildFailed: 'block_parent',
    })
    store.db.prepare(`
      UPDATE task_dependencies SET status = 'satisfied', terminal_at = @now WHERE id = @id
    `).run({ id: dependencyId, now: iso(1) })

    const replayId = store.createDependency({
      parentTaskId: parent.taskId,
      childTaskId: child.taskId,
      onChildFailed: 'block_parent',
      existingPolicy: 'idempotent',
    })
    assert.equal(replayId, dependencyId)
    const row = store.db.prepare('SELECT status, terminal_at FROM task_dependencies WHERE id = ?').get(dependencyId) as {
      status: string
      terminal_at: string | null
    }
    assert.equal(row.status, 'satisfied')
    assert.equal(row.terminal_at, iso(1))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextTask claims each queued task exactly once', () => {
  const { dir, store } = openTempStore()
  try {
    store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })

    const first = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    const second = store.claimNextTask({ workflow: 'wf', workerId: 'w2', now: iso(2) })

    assert.equal(first?.itemId, 'a')
    assert.equal(first?.workerId, 'w1')
    assert.equal(second, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recoverClaimsForDeadWorkers recovers expired claims even when worker is alive', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })
    const claimed = store.claimNextTask({ workflow: 'wf', workerId: 'alive', now: iso(1), leaseMs: 60_000 })
    assert.equal(claimed?.itemId, 'a')
    store.db.prepare('UPDATE tasks SET claim_expires_at = @past WHERE id = @taskId').run({
      past: iso(2),
      taskId: queued.taskId,
    })

    const recovered = store.recoverClaimsForDeadWorkers({
      workflow: 'wf',
      aliveWorkerIds: new Set(['alive']),
      now: iso(3),
    })

    assert.deepEqual(recovered.map((row) => row.itemId), ['a'])
    const task = store.getTask(queued.taskId)
    assert.equal(task?.state, 'queued')
    const row = store.db.prepare('SELECT claimed_by_worker_id FROM tasks WHERE id = ?').get(queued.taskId) as {
      claimed_by_worker_id: string | null
    }
    assert.equal(row.claimed_by_worker_id, null)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renewClaim extends a live worker lease so recovery does not steal an in-flight item', () => {
  // The multi-worker bug (adding a worker mid-run stole the busy worker's item):
  // the claim lease was set to claim-time + 60s and never renewed, so any item
  // running longer than the lease looked "expired" to a peer's recovery sweep —
  // which re-pended it even though the original worker was alive and working it.
  // The fix renews the lease on each worker heartbeat; this proves a renewed,
  // still-held claim survives a recovery sweep run past the ORIGINAL lease.
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: isoAt(0),
    })
    // Worker A claims at t=1 with a 60s lease (expires t=61) and starts running.
    const claimed = store.claimNextTask({ workflow: 'wf', workerId: 'A', now: isoAt(1), leaseMs: 60_000 })
    assert.equal(claimed?.itemId, 'a')
    store.markTaskRunning({ taskId: queued.taskId, attemptId: queued.attemptId, workerId: 'A', now: isoAt(2) })

    // A's heartbeat renews the lease partway through the long item (t=30 → expires t=90).
    const renewed = store.renewClaim({ taskId: queued.taskId, workerId: 'A', now: isoAt(30), leaseMs: 60_000 })
    assert.equal(renewed, true, 'the owning worker renews its own in-flight claim')

    // A peer (e.g. a freshly added worker's startup recovery, or an idle peer's
    // keepalive tick) sweeps at t=61 — PAST the original lease but inside the
    // renewed one. A is alive and heartbeating, so its claim must NOT be stolen.
    const recovered = store.recoverClaimsForDeadWorkers({
      workflow: 'wf',
      aliveWorkerIds: new Set(['A']),
      now: isoAt(61),
    })

    assert.deepEqual(recovered, [], 'a renewed, still-held claim is not recovered while the worker is alive')
    assert.equal(store.getTask(queued.taskId)?.state, 'running')
    const row = store.db.prepare('SELECT claimed_by_worker_id FROM tasks WHERE id = ?').get(queued.taskId) as {
      claimed_by_worker_id: string | null
    }
    assert.equal(row.claimed_by_worker_id, 'A')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renewClaim only renews the owning worker non-terminal claim', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: isoAt(0),
    })
    store.claimNextTask({ workflow: 'wf', workerId: 'A', now: isoAt(1), leaseMs: 60_000 })

    // A peer that does NOT own the claim cannot renew it (no-op, returns false).
    const stranger = store.renewClaim({ taskId: queued.taskId, workerId: 'B', now: isoAt(5), leaseMs: 60_000 })
    assert.equal(stranger, false, 'a non-owning worker cannot renew the lease')
    const afterStranger = store.db.prepare('SELECT claim_expires_at FROM tasks WHERE id = ?').get(queued.taskId) as {
      claim_expires_at: string
    }
    assert.equal(afterStranger.claim_expires_at, isoAt(61), 'a stranger renew left the original lease untouched')

    // Once the task is terminal, even the owner cannot renew it.
    store.markTaskRunning({ taskId: queued.taskId, attemptId: queued.attemptId, workerId: 'A', now: isoAt(2) })
    store.markTaskDone({ taskId: queued.taskId, attemptId: queued.attemptId, now: isoAt(3) })
    const afterDone = store.renewClaim({ taskId: queued.taskId, workerId: 'A', now: isoAt(10), leaseMs: 60_000 })
    assert.equal(afterDone, false, 'a terminal task is never re-leased')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal update updates task and attempt', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const claimed = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(claimed)

    store.markTaskRunning({ taskId: queued.taskId, attemptId: queued.attemptId, workerId: 'w1', now: iso(2) })
    store.markTaskDone({ taskId: queued.taskId, attemptId: queued.attemptId, now: iso(3) })

    const task = store.getTask(queued.taskId)
    const attempt = store.getAttempt(queued.attemptId)
    assert.equal(task?.state, 'done')
    assert.equal(attempt?.state, 'done')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryTaskFromAttempt creates a new attempt on the same task', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id })
    store.markTaskFailed({ taskId: queued.taskId, attemptId: queued.attemptId, error: 'boom', now: iso(1) })

    const retry = store.retryTaskFromAttempt({ runId: queued.runId, now: iso(2) })

    assert.equal(retry.taskId, queued.taskId)
    assert.notEqual(retry.attemptId, queued.attemptId)
    assert.notEqual(retry.runId, queued.runId)
    assert.equal(store.getTask(queued.taskId)?.state, 'queued')
    assert.equal(store.listAttemptsForTask(queued.taskId).length, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryTaskFromAttempt throws when original_input_json is absent', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id })
    store.markTaskFailed({ taskId: queued.taskId, attemptId: queued.attemptId, error: 'boom', now: iso(1) })
    store.db.prepare('UPDATE tasks SET original_input_json = NULL WHERE id = @taskId').run({
      taskId: queued.taskId,
    })

    assert.throws(
      () => store.retryTaskFromAttempt({ runId: queued.runId, now: iso(2) }),
      new RegExp(
        `retryTaskFromAttempt: task ${queued.taskId} has no original_input_json \\(legacy pre-migration-11 row\\)\\. Contract 2 requires every retryable row to have original_input_json\\. Either delete the row and re-enqueue, or repair the row manually\\.`,
      ),
    )
    assert.equal(store.listAttemptsForTask(queued.taskId).length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryTaskFromAttempt preserves parentRunId for delegated child tasks', () => {
  const { dir, store } = openTempStore()
  try {
    const parentRunId = 'ocr-parent-run#1'
    const [queued] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'child' }],
      deriveItemId: (x) => x.id,
      parentRunId,
      now: iso(0),
    })
    store.markTaskFailed({ taskId: queued.taskId, attemptId: queued.attemptId, error: 'boom', now: iso(1) })

    const retry = store.retryTaskFromAttempt({ runId: queued.runId, now: iso(2) })

    assert.equal(retry.parentRunId, parentRunId)
    assert.equal(store.getTask(queued.taskId)?.parentRunId, parentRunId)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dependency waiting blocks parent claim and releases after child success', () => {
  const { dir, store } = openTempStore()
  try {
    const [parent] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'parent' }], deriveItemId: (x) => x.id, now: iso(0) })
    const [child] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'child' }], deriveItemId: (x) => x.id, now: iso(0) })
    store.createDependency({
      parentTaskId: parent.taskId,
      childTaskId: child.taskId,
      onChildFailed: 'block_parent',
    })

    assert.equal(store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })?.itemId, 'child')

    store.markDependencyFromChildTerminal({ childTaskId: child.taskId, childState: 'done', now: iso(2) })
    const released = store.claimNextTask({ workflow: 'wf', workerId: 'w2', now: iso(3) })
    assert.equal(released?.itemId, 'parent')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('child failure policy blocks or fails parent', () => {
  const { dir, store } = openTempStore()
  try {
    const [blockedParent] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'p1' }], deriveItemId: (x) => x.id })
    const [failedParent] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'p2' }], deriveItemId: (x) => x.id })
    const [child1] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'c1' }], deriveItemId: (x) => x.id })
    const [child2] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'c2' }], deriveItemId: (x) => x.id })
    store.createDependency({ parentTaskId: blockedParent.taskId, childTaskId: child1.taskId, onChildFailed: 'block_parent' })
    store.createDependency({ parentTaskId: failedParent.taskId, childTaskId: child2.taskId, onChildFailed: 'fail_parent' })

    store.markDependencyFromChildTerminal({ childTaskId: child1.taskId, childState: 'failed', now: iso(1) })
    store.markDependencyFromChildTerminal({ childTaskId: child2.taskId, childState: 'failed', now: iso(2) })

    assert.equal(store.getTask(blockedParent.taskId)?.state, 'blocked')
    assert.equal(store.getTask(failedParent.taskId)?.state, 'failed')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parent cancellation cascades to queued children', () => {
  const { dir, store } = openTempStore()
  try {
    const [parent] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'p' }], deriveItemId: (x) => x.id })
    const [child] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'c' }], deriveItemId: (x) => x.id })
    store.createDependency({ parentTaskId: parent.taskId, childTaskId: child.taskId, onChildFailed: 'block_parent' })

    store.requestCancelParentAndChildren({ parentTaskId: parent.taskId, reason: 'operator', now: iso(1) })

    assert.equal(store.getTask(child.taskId)?.state, 'cancelled')
    assert.equal(store.getTask(parent.taskId)?.state, 'cancelled')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale worker cannot complete a task a peer re-claimed after re-pend (ISS-005)', () => {
  // Stop-All / per-instance-stop teardown re-pends an in-flight item via
  // `returnTaskToQueued` so a surviving peer can finish it. Before the claim
  // lease, the re-pend kept the SAME `current_attempt_id` + runId, so the peer
  // re-claimed the identical attempt — and the ORIGINAL (stopped) worker, still
  // finishing its run, could then call `markTaskDone` for that attempt and have
  // it land. The task-store stayed idempotent (one `done` row), but TWO workers
  // each transacted the work → a duplicate oath submission outside dry-run.
  //
  // The lease (`claimGeneration`) is the guard: each claim hands the worker a
  // monotonically increasing generation; a terminal write supplied with a stale
  // generation is a no-op. So the original worker's completion must NOT win
  // after the peer re-claims.
  const { dir, store } = openTempStore()
  try {
    const [q] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })

    // Worker w1 claims + runs the item, capturing its lease.
    const c1 = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c1)
    store.markTaskRunning({ taskId: q.taskId, attemptId: c1.attemptId, workerId: 'w1', now: iso(2) })

    // Teardown re-pends w1's in-flight item back to the queue (reassign).
    store.returnTaskToQueued({ taskId: q.taskId, now: iso(3) })

    // Peer w2 re-claims it — a NEW lease generation.
    const c2 = store.claimNextTask({ workflow: 'wf', workerId: 'w2', now: iso(4) })
    assert.ok(c2)
    assert.notEqual(
      c2.claimGeneration,
      c1.claimGeneration,
      'a re-claim after re-pend must advance the lease generation',
    )

    // w1 (the stopped instance) finally finishes its run and completes the task
    // with its STALE lease. This must NOT terminalize the task — w2 holds it now.
    store.markTaskDone({ taskId: q.taskId, attemptId: c1.attemptId, claimGeneration: c1.claimGeneration, now: iso(5) })
    assert.notEqual(
      store.getTask(q.taskId)?.state,
      'done',
      'a stale-lease completion must be a no-op — the peer still owns the run',
    )

    // w2 completing with its CURRENT lease succeeds (the single real terminal).
    store.markTaskDone({ taskId: q.taskId, attemptId: c2.attemptId, claimGeneration: c2.claimGeneration, now: iso(6) })
    assert.equal(store.getTask(q.taskId)?.state, 'done', 'the owning peer completes the task')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal and requeue transitions return explicit owner/attempt/generation-fenced outcomes', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const claimed = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(claimed)
    store.markTaskRunning({ taskId: queued.taskId, attemptId: claimed.attemptId, workerId: 'w1', now: iso(2) })

    assert.deepEqual(
      store.markTaskDone({
        taskId: queued.taskId,
        attemptId: claimed.attemptId,
        workerId: 'peer',
        claimGeneration: claimed.claimGeneration,
        now: iso(3),
      }),
      { kind: 'lease-lost' },
    )
    assert.equal(store.getTask(queued.taskId)?.state, 'running')

    assert.deepEqual(
      store.returnTaskToQueued({
        taskId: queued.taskId,
        attemptId: claimed.attemptId,
        workerId: 'peer',
        claimGeneration: claimed.claimGeneration,
        now: iso(4),
      }),
      { kind: 'lease-lost' },
    )
    assert.equal(store.getTask(queued.taskId)?.state, 'running')

    assert.deepEqual(
      store.returnTaskToQueued({
        taskId: queued.taskId,
        attemptId: claimed.attemptId,
        workerId: 'w1',
        claimGeneration: claimed.claimGeneration,
        now: iso(5),
      }),
      { kind: 'applied' },
    )
    assert.equal(store.getTask(queued.taskId)?.state, 'queued')

    assert.deepEqual(
      store.markTaskDone({
        taskId: queued.taskId,
        attemptId: claimed.attemptId,
        workerId: 'w1',
        claimGeneration: claimed.claimGeneration,
        now: iso(6),
      }),
      { kind: 'lease-lost' },
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal transitions distinguish applied from an existing terminal row', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const first = store.markTaskDone({ taskId: queued.taskId, attemptId: queued.attemptId, now: iso(1) })
    const second = store.markTaskFailed({ taskId: queued.taskId, attemptId: queued.attemptId, error: 'late', now: iso(2) })
    assert.deepEqual(first, { kind: 'applied' })
    assert.deepEqual(second, { kind: 'already-terminal', state: 'done' })
    assert.equal(store.getTask(queued.taskId)?.state, 'done')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal fences distinguish missing task and mismatched attempt without mutating either row', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    assert.deepEqual(
      store.markTaskDone({ taskId: 'missing', attemptId: queued.attemptId, now: iso(1) }),
      { kind: 'not-found' },
    )
    assert.deepEqual(
      store.markTaskDone({ taskId: queued.taskId, attemptId: 'wrong-attempt', now: iso(2) }),
      { kind: 'lease-lost' },
    )
    assert.equal(store.getTask(queued.taskId)?.state, 'queued')
    assert.equal(store.getAttempt(queued.attemptId)?.state, 'pending')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal transition rolls back the task update when its current attempt row is missing', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    store.db.exec('PRAGMA foreign_keys = OFF')
    store.db.prepare('DELETE FROM task_attempts WHERE id = ?').run(queued.attemptId)
    store.db.exec('PRAGMA foreign_keys = ON')

    assert.throws(
      () => store.markTaskDone({ taskId: queued.taskId, attemptId: queued.attemptId, now: iso(1) }),
      /attempt .* did not update/,
    )
    assert.equal(store.getTask(queued.taskId)?.state, 'queued', 'task update rolls back with missing attempt')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('uncertain terminal persistence blocks only the exact owner/attempt/generation and closes the attempt', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const claimed = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(claimed)
    store.markTaskRunning({ taskId: queued.taskId, attemptId: claimed.attemptId, workerId: 'w1', now: iso(2) })

    assert.deepEqual(store.markTaskBlockedUncertain({
      taskId: queued.taskId,
      attemptId: claimed.attemptId,
      workerId: 'peer',
      claimGeneration: claimed.claimGeneration,
      error: 'uncertain submission',
      now: iso(3),
    }), { kind: 'lease-lost' })

    assert.deepEqual(store.markTaskBlockedUncertain({
      taskId: queued.taskId,
      attemptId: claimed.attemptId,
      workerId: 'w1',
      claimGeneration: claimed.claimGeneration,
      error: 'uncertain submission',
      now: iso(4),
    }), { kind: 'applied' })
    assert.equal(store.getTask(queued.taskId)?.state, 'blocked')
    assert.equal(store.getAttempt(claimed.attemptId)?.state, 'failed')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stale worker cannot complete a re-pended item BEFORE a peer re-claims it (ISS-005 window)', () => {
  // The companion to the test above: the lease is bumped at the per-claim site,
  // but the dangerous window is between `returnTaskToQueued` (re-pend) and the
  // peer's NEXT claim — if the bump only happened at re-claim, a stale-but-alive
  // worker that finishes in that gap would still match its original generation
  // and land a `done` on a task deliberately returned to the queue. The bump now
  // happens AT re-pend, so the stale completion no-ops even before any peer claim.
  const { dir, store } = openTempStore()
  try {
    const [q] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })
    const c1 = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c1)
    store.markTaskRunning({ taskId: q.taskId, attemptId: c1.attemptId, workerId: 'w1', now: iso(2) })

    // Re-pend (reassign / dead-worker recovery). NO peer re-claim yet.
    store.returnTaskToQueued({ taskId: q.taskId, now: iso(3) })

    // The stopped/stale w1 finishes and completes with its ORIGINAL lease.
    store.markTaskDone({ taskId: q.taskId, attemptId: c1.attemptId, claimGeneration: c1.claimGeneration, now: iso(4) })
    assert.equal(
      store.getTask(q.taskId)?.state,
      'queued',
      're-pend bumped the lease, so a stale completion in the pre-reclaim window must no-op (task stays queued for a peer)',
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markTaskRunning will not stomp a task a peer re-claimed (running stomp guard)', () => {
  // A stale worker whose item was re-pended and re-claimed by a peer must not be
  // able to overwrite `claimed_by_worker_id` / `current_attempt_id` via a late
  // markTaskRunning — that would mis-attribute the in-flight item and confuse
  // dead-worker recovery (which keys on claimed_by_worker_id).
  const { dir, store } = openTempStore()
  try {
    const [q] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })
    const c1 = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c1)
    store.markTaskRunning({ taskId: q.taskId, attemptId: c1.attemptId, workerId: 'w1', now: iso(2) })
    store.returnTaskToQueued({ taskId: q.taskId, now: iso(3) })

    // Peer w2 re-claims — it now owns the task.
    const c2 = store.claimNextTask({ workflow: 'wf', workerId: 'w2', now: iso(4) })
    assert.ok(c2)
    assert.equal(store.getTask(q.taskId)?.claimedByWorkerId, 'w2')

    // Stale w1's late markTaskRunning must be a no-op — w2 still owns the claim.
    store.markTaskRunning({ taskId: q.taskId, attemptId: c1.attemptId, workerId: 'w1', now: iso(5) })
    assert.equal(
      store.getTask(q.taskId)?.claimedByWorkerId,
      'w2',
      'a stale worker must not stomp claimed_by_worker_id of a peer-reclaimed task',
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markTaskFailedIfActive: exactly ONE caller wins the transition (cross-process queued-orphan dedup, E2E-105)', () => {
  // On a simultaneous stop-all, several dying daemons each elect themselves the
  // queue owner and each try to fail the same never-claimed item. The
  // run-registry single-terminal-write token is per-PROCESS, so SQLite is the
  // only cross-process authority: the guarded mark (terminal_at IS NULL) must
  // let exactly one win so the item gets exactly one terminal row.
  const { dir, store } = openTempStore()
  try {
    const [q] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })
    const first = store.markTaskFailedIfActive({ taskId: q.taskId, error: 'no daemon', now: iso(1) })
    const second = store.markTaskFailedIfActive({ taskId: q.taskId, error: 'no daemon', now: iso(2) })
    assert.equal(first, true, 'the first caller wins the transition')
    assert.equal(second, false, 'a second caller on an already-terminal task loses (no duplicate terminal)')
    assert.equal(store.getTask(q.taskId)?.state, 'failed')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markTaskFailedIfActive: returns false for an already-done task (never resurrects a terminal)', () => {
  const { dir, store } = openTempStore()
  try {
    const [q] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })
    const c = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c)
    store.markTaskDone({ taskId: q.taskId, attemptId: c.attemptId, now: iso(2) })
    const won = store.markTaskFailedIfActive({ taskId: q.taskId, error: 'late', now: iso(3) })
    assert.equal(won, false, 'a terminal (done) task is never re-failed')
    assert.equal(store.getTask(q.taskId)?.state, 'done')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseJson throws a clear error for malformed JSON', () => {
  assert.throws(
    () => parseJson('not-json'),
    /parseJson: malformed JSON .*not-json/,
  )
})

test('markDependencyFromChildTerminal returns the released parents with their workflow (E2E-017)', () => {
  // The release flips the parent waiting_dependencies→queued in SQLite only;
  // the CALLER wakes the parent workflow's daemons off this return value —
  // an idle daemon otherwise re-polls only on its 15-min keepalive tick.
  const { dir, store } = openTempStore()
  try {
    const [parent] = store.enqueueTasks({ workflow: 'oath-upload', inputs: [{ id: 'ticket' }], deriveItemId: (x) => x.id, now: iso(0) })
    const [childA] = store.enqueueTasks({ workflow: 'oath-signature', inputs: [{ id: 'signer-a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const [childB] = store.enqueueTasks({ workflow: 'oath-signature', inputs: [{ id: 'signer-b' }], deriveItemId: (x) => x.id, now: iso(0) })
    store.createDependency({ parentTaskId: parent.taskId, childTaskId: childA.taskId, onChildFailed: 'block_parent' })
    store.createDependency({ parentTaskId: parent.taskId, childTaskId: childB.taskId, onChildFailed: 'block_parent' })

    // First child settles — parent still has a pending dependency: no release.
    const first = store.markDependencyFromChildTerminal({ childTaskId: childA.taskId, childState: 'done', now: iso(1) })
    assert.deepEqual(first, [])

    // Last child settles — the parent is released and identified by workflow.
    const second = store.markDependencyFromChildTerminal({ childTaskId: childB.taskId, childState: 'done', now: iso(2) })
    assert.deepEqual(second, [{ taskId: parent.taskId, workflow: 'oath-upload' }])

    // Settling an already-settled child releases nothing again.
    const third = store.markDependencyFromChildTerminal({ childTaskId: childB.taskId, childState: 'done', now: iso(3) })
    assert.deepEqual(third, [])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dependency release terminalizes a task_kind=ocr anchor instead of queueing it (E2E-003)', () => {
  // The OCR dependency anchor is never daemon work — releasing it to queued
  // stranded a zombie task for every prep. The generic settle path usually
  // wins the race against the OCR scheduler's tick, so the flip site itself
  // must terminalize the anchor.
  const { dir, store } = openTempStore()
  try {
    const [anchor] = store.enqueueTasks({ workflow: 'ocr', inputs: [{ id: 'session-1' }], deriveItemId: (x) => x.id, now: iso(0) })
    const [child] = store.enqueueTasks({ workflow: 'person-lookup', inputs: [{ id: 'lookup-1' }], deriveItemId: (x) => x.id, now: iso(0) })
    store.db.prepare(`UPDATE tasks SET task_kind = 'ocr' WHERE id = ?`).run(anchor.taskId)
    store.createDependency({ parentTaskId: anchor.taskId, childTaskId: child.taskId, onChildFailed: 'block_parent' })

    const released = store.markDependencyFromChildTerminal({ childTaskId: child.taskId, childState: 'done', now: iso(1) })

    assert.deepEqual(released, [], 'an anchor is terminalized, never released for claiming')
    assert.equal(store.getTask(anchor.taskId)?.state, 'done')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryTaskFromAttempt with blockedControlStates refuses atomically when the task became claimed mid-retry (TOCTOU)', () => {
  // The retry double-execution race: the control layer pre-checks
  // control_state (non-transactionally), then does JSONL I/O, then calls
  // retryTaskFromAttempt. A daemon can claim the task inside that window —
  // an unguarded reset would re-queue a task a worker is actively running.
  // The guarded UPDATE must match 0 rows and throw, leaving the daemon's
  // claim fully intact (attempt INSERT rolled back too).
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    // Simulate the mid-window daemon claim (state: queued → claimed).
    const claimed = store.claimNextTask({ workflow: 'wf', workerId: 'daemon-1', now: iso(1) })
    assert.ok(claimed)

    assert.throws(
      () =>
        store.retryTaskFromAttempt({
          runId: queued.runId,
          now: iso(2),
          blockedControlStates: ['claimed', 'running', 'cancel_requested', 'cancelling'],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.equal(err.name, 'RetryTaskBecameActiveError')
        assert.match(err.message, /became 'claimed'/)
        assert.match(err.message, new RegExp(queued.runId))
        return true
      },
    )

    // The daemon's claim survives untouched — no reset, no orphan attempt.
    const task = store.getTask(queued.taskId)
    assert.equal(task?.state, 'claimed')
    assert.equal(task?.claimedByWorkerId, 'daemon-1')
    assert.equal(store.listAttemptsForTask(queued.taskId).length, 1, 'the new attempt INSERT must roll back')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryTaskFromAttempt with blockedControlStates proceeds for a terminal (failed) task', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    store.markTaskFailed({ taskId: queued.taskId, attemptId: queued.attemptId, error: 'boom', now: iso(1) })

    const retried = store.retryTaskFromAttempt({
      runId: queued.runId,
      now: iso(2),
      blockedControlStates: ['claimed', 'running', 'cancel_requested', 'cancelling'],
    })

    assert.equal(store.getTask(queued.taskId)?.state, 'queued')
    assert.notEqual(retried.runId, queued.runId)
    assert.equal(store.listAttemptsForTask(queued.taskId).length, 2)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('retryTaskFromAttempt bumps claim_generation so a stale worker cannot overwrite the fresh retry (ISS-005 pattern)', () => {
  // Race tail: worker w1 claimed the task (lease gen 1), the task got failed,
  // the operator retried. WITHOUT a generation bump at retry time, stale w1's
  // late markTaskDone({claimGeneration: 1}) would still match the lease and
  // flip the freshly-queued retry to done — silently overwriting the new run.
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const c1 = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c1)
    assert.equal(c1.claimGeneration, 1)
    // The attempt fails (e.g. daemon marked it failed while w1's async tail
    // is still unwinding), then the operator retries.
    store.markTaskFailed({ taskId: queued.taskId, attemptId: c1.attemptId, error: 'boom', now: iso(2) })
    const retried = store.retryTaskFromAttempt({ runId: queued.runId, now: iso(3) })
    assert.equal(store.getTask(queued.taskId)?.state, 'queued')

    // Stale w1 completes late with its old lease — must be a no-op.
    store.markTaskDone({ taskId: queued.taskId, attemptId: c1.attemptId, claimGeneration: c1.claimGeneration, now: iso(4) })

    const task = store.getTask(queued.taskId)
    assert.equal(task?.state, 'queued', 'a stale worker must not terminalize the fresh retry')
    assert.equal(task?.currentRunId, retried.runId)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markTaskRunning throws on a terminal task instead of resurrecting it', () => {
  // markTerminal NULLs claimed_by_worker_id, so before the control_state
  // predicate the (claimed_by IS NULL) branch let a misordered caller flip a
  // done/failed/cancelled task straight back to running. Fail loud instead.
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const c1 = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c1)
    store.markTaskDone({ taskId: queued.taskId, attemptId: c1.attemptId, now: iso(2) })

    assert.throws(
      () => store.markTaskRunning({ taskId: queued.taskId, attemptId: c1.attemptId, workerId: 'w1', now: iso(3) }),
      /refusing to move task .* from terminal state 'done' back to 'running'/,
    )
    assert.equal(store.getTask(queued.taskId)?.state, 'done')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markTaskRunning still supports the in-process queued path (claimed_by NULL, state queued)', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    // In-process runs enqueue then mark running directly without a claim.
    store.markTaskRunning({ taskId: queued.taskId, attemptId: queued.attemptId, workerId: 'dashboard:1', now: iso(1) })
    const task = store.getTask(queued.taskId)
    assert.equal(task?.state, 'running')
    assert.equal(task?.claimedByWorkerId, 'dashboard:1')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markTaskRunning no-ops (without throwing) on a cancel_requested task, preserving the cancel intent', () => {
  // A cancel that lands between claim and mark-running flips the task to
  // cancel_requested. The old guard (claimed_by only) stomped that back to
  // 'running', erasing the cooperative-cancel state. Now the state predicate
  // excludes it: benign no-op (not terminal, so no throw) and the cancel
  // survives for the worker-command poll to honor.
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(0) })
    const c1 = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(c1)
    store.requestCancelTask({ taskId: queued.taskId, reason: 'operator cancel', now: iso(2) })
    assert.equal(store.getTask(queued.taskId)?.state, 'cancel_requested')

    store.markTaskRunning({ taskId: queued.taskId, attemptId: c1.attemptId, workerId: 'w1', now: iso(3) })

    assert.equal(store.getTask(queued.taskId)?.state, 'cancel_requested')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('requestCancelTask returns an authoritative result and never resurrects terminal tasks', () => {
  const { dir, store } = openTempStore()
  try {
    for (const terminalState of ['done', 'failed', 'cancelled'] as const) {
      const [queued] = store.enqueueTasks({
        workflow: 'wf',
        inputs: [{ id: terminalState }],
        deriveItemId: (x) => x.id,
        now: iso(0),
      })
      if (terminalState === 'done') {
        store.markTaskDone({ taskId: queued.taskId, attemptId: queued.attemptId, now: iso(1) })
      } else if (terminalState === 'failed') {
        store.markTaskFailed({ taskId: queued.taskId, attemptId: queued.attemptId, error: 'boom', now: iso(1) })
      } else {
        store.markTaskCancelled({ taskId: queued.taskId, attemptId: queued.attemptId, reason: 'first cancel', now: iso(1) })
      }

      const result = store.requestCancelTask({ taskId: queued.taskId, reason: 'late cancel', now: iso(2) })

      assert.equal(result.kind, 'already-terminal')
      assert.equal(result.task.state, terminalState)
      assert.equal(store.getTask(queued.taskId)?.state, terminalState)
      assert.equal(store.getAttempt(queued.attemptId)?.state, terminalState)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('requestCancelTask atomically distinguishes accepted, already-terminal, and not-found', () => {
  const { dir, store } = openTempStore()
  try {
    const [queued] = store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }],
      deriveItemId: (x) => x.id,
      now: iso(0),
    })
    const claim = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(1) })
    assert.ok(claim)

    const accepted = store.requestCancelTask({ taskId: queued.taskId, reason: 'operator', now: iso(2) })
    assert.equal(accepted.kind, 'accepted')
    if (accepted.kind === 'accepted') assert.equal(accepted.disposition, 'requested')
    assert.equal(accepted.task.state, 'cancel_requested')
    assert.equal(store.getAttempt(queued.attemptId)?.state, 'cancel_requested')

    const repeated = store.requestCancelTask({ taskId: queued.taskId, reason: 'operator again', now: iso(3) })
    assert.equal(repeated.kind, 'accepted')
    if (repeated.kind === 'accepted') {
      assert.equal(repeated.disposition, 'already-requested')
      assert.equal(repeated.task.state, 'cancel_requested')
    }

    assert.deepEqual(store.requestCancelTask({ taskId: 'missing', now: iso(4) }), { kind: 'not-found' })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listTaskTreeByRunIds follows recursive parent_run_id links through terminal intermediates', () => {
  const { dir, store } = openTempStore()
  try {
    const [child] = store.enqueueTasks({
      workflow: 'child-wf',
      inputs: [{ id: 'child' }],
      deriveItemId: (x) => x.id,
      parentRunId: 'root-run',
      runIds: ['child-run'],
      now: iso(0),
    })
    store.markTaskDone({ taskId: child.taskId, attemptId: child.attemptId, now: iso(1) })
    const [grandchild] = store.enqueueTasks({
      workflow: 'grandchild-wf',
      inputs: [{ id: 'grandchild' }],
      deriveItemId: (x) => x.id,
      parentRunId: child.runId,
      runIds: ['grandchild-run'],
      now: iso(2),
    })
    store.enqueueTasks({
      workflow: 'other-wf',
      inputs: [{ id: 'unrelated' }],
      deriveItemId: (x) => x.id,
      parentRunId: 'other-root',
      runIds: ['unrelated-run'],
      now: iso(2),
    })

    const tree = store.listTaskTreeByRunIds({ rootRunIds: ['root-run'] })

    assert.deepEqual(tree.map((task) => task.taskId), [child.taskId, grandchild.taskId])
    assert.deepEqual(tree.map((task) => task.state), ['done', 'queued'])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
