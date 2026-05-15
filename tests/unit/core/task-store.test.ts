import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openControlDb } from '../../../src/core/control-db.js'
import {
  createTaskStore,
  type ControlTaskStore,
} from '../../../src/core/task-store/index.js'

function iso(n: number): string {
  return `2026-05-04T12:00:${String(n).padStart(2, '0')}.000Z`
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

test('claimNextTask fallback path claims the oldest eligible task', () => {
  const { dir, store } = openTempStore()
  try {
    store.control.supportsUpdateReturning = () => false
    store.enqueueTasks({
      workflow: 'wf',
      inputs: [{ id: 'a' }, { id: 'b' }],
      deriveItemId: (x) => x.id,
      now: iso(1),
    })

    const first = store.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(2) })

    assert.equal(first?.itemId, 'a')
    assert.equal(store.listTasksForWorkflow('wf')[0].claimedByWorkerId, 'w1')
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
