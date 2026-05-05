import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openControlDb } from '../../../src/core/control-db.js'
import { createTaskStore } from '../../../src/core/task-store.js'
import {
  createWorkerStore,
  type ControlWorkerStore,
} from '../../../src/core/worker-store.js'

function iso(n: number): string {
  return `2026-05-04T12:00:${String(n).padStart(2, '0')}.000Z`
}

function openTempStores(): {
  dir: string
  workerStore: ControlWorkerStore
  taskStore: ReturnType<typeof createTaskStore>
} {
  const dir = mkdtempSync(join(tmpdir(), 'worker-store-'))
  const ctl = openControlDb({ path: join(dir, 'control.sqlite') })
  return {
    dir,
    workerStore: createWorkerStore(ctl),
    taskStore: createTaskStore(ctl),
  }
}

test('registerWorker upserts daemon worker identity', () => {
  const { dir, workerStore } = openTempStores()
  try {
    workerStore.registerWorker({
      workerId: 'w1',
      workflow: 'wf',
      kind: 'daemon',
      pid: 100,
      parentPid: 90,
      hostname: 'host',
      port: 38381,
      instanceId: 'inst-1',
      lockfilePath: '/tmp/lock',
      phase: 'idle',
      heartbeatTtlMs: 1000,
      now: iso(1),
    })

    const worker = workerStore.getWorker('w1')
    assert.equal(worker?.workerId, 'w1')
    assert.equal(worker?.status, 'alive')
    assert.equal(worker?.phase, 'idle')
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('heartbeatWorker updates worker and inserts bounded history', () => {
  const { dir, workerStore, taskStore } = openTempStores()
  try {
    const [task] = taskStore.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id })
    workerStore.registerWorker({
      workerId: 'w1',
      kind: 'daemon',
      pid: 100,
      hostname: 'host',
      phase: 'starting',
      now: iso(1),
    })
    workerStore.heartbeatWorker({
      workerId: 'w1',
      phase: 'processing',
      currentTaskId: task.taskId,
      currentAttemptId: task.attemptId,
      queueDepth: 2,
      payload: { itemId: 'item-1' },
      now: iso(2),
    })

    const worker = workerStore.getWorker('w1')
    assert.equal(worker?.phase, 'processing')
    assert.equal(worker?.currentTaskId, task.taskId)
    assert.equal(worker?.lastHeartbeatAt, iso(2))
    assert.equal(workerStore.listHeartbeats('w1').length, 1)
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listStaleWorkers returns workers whose heartbeat TTL expired', () => {
  const { dir, workerStore } = openTempStores()
  try {
    workerStore.registerWorker({
      workerId: 'stale',
      kind: 'daemon',
      pid: 100,
      hostname: 'host',
      phase: 'idle',
      heartbeatTtlMs: 1000,
      now: iso(1),
    })
    workerStore.heartbeatWorker({ workerId: 'stale', phase: 'idle', now: iso(2) })

    const stale = workerStore.listStaleWorkers({ now: '2026-05-04T12:00:04.000Z' })
    assert.deepEqual(stale.map((worker) => worker.workerId), ['stale'])
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('command lifecycle queues, acknowledges, completes, and fails commands', () => {
  const { dir, workerStore } = openTempStores()
  try {
    workerStore.registerWorker({ workerId: 'w1', kind: 'daemon', pid: 100, hostname: 'host', phase: 'idle' })
    const commandId = workerStore.enqueueWorkerCommand({
      commandType: 'drain_worker',
      targetWorkerId: 'w1',
      payload: { reason: 'test' },
      now: iso(1),
    })

    assert.equal(workerStore.listQueuedCommandsForWorker('w1').length, 1)
    workerStore.acknowledgeCommand(commandId, 'w1', iso(2))
    assert.equal(workerStore.getCommand(commandId)?.state, 'acknowledged')
    workerStore.completeCommand(commandId, iso(3))
    assert.equal(workerStore.getCommand(commandId)?.state, 'completed')

    const failed = workerStore.enqueueWorkerCommand({ commandType: 'health_check', targetWorkerId: 'w1', now: iso(4) })
    workerStore.failCommand(failed, 'nope', iso(5))
    assert.equal(workerStore.getCommand(failed)?.error, 'nope')
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('browser process tracking records ownership and kill lifecycle', () => {
  const { dir, workerStore, taskStore } = openTempStores()
  try {
    workerStore.registerWorker({ workerId: 'w1', workflow: 'wf', kind: 'daemon', pid: 100, hostname: 'host', phase: 'idle' })
    const [task] = taskStore.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id })
    const browser = workerStore.upsertBrowserProcess({
      workerId: 'w1',
      workflow: 'wf',
      taskId: task.taskId,
      attemptId: task.attemptId,
      systemId: 'ucpath',
      browserId: 'ucpath',
      pid: 321,
      sessionDir: '/tmp/session',
      now: iso(1),
    })

    const commandId = workerStore.enqueueWorkerCommand({
      commandType: 'kill_browser',
      targetWorkerId: 'w1',
      targetBrowserProcessId: browser.browserProcessId,
      now: iso(2),
    })
    workerStore.markBrowserProcessKillRequested({ browserProcessId: browser.browserProcessId, commandId, now: iso(3) })
    assert.equal(workerStore.findBrowserProcessByPid(321)?.status, 'kill_requested')
    workerStore.markBrowserProcessTerminated({ browserProcessId: browser.browserProcessId, now: iso(4) })
    assert.equal(workerStore.listBrowserProcessesForWorker('w1')[0].status, 'terminated')
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findWorkerOwnerByTask resolves current task ownership', () => {
  const { dir, workerStore, taskStore } = openTempStores()
  try {
    workerStore.registerWorker({ workerId: 'w1', workflow: 'wf', kind: 'daemon', pid: 100, hostname: 'host', phase: 'idle' })
    const [task] = taskStore.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(1) })
    taskStore.claimNextTask({ workflow: 'wf', workerId: 'w1', now: iso(2) })
    workerStore.heartbeatWorker({
      workerId: 'w1',
      phase: 'processing',
      currentTaskId: task.taskId,
      currentAttemptId: task.attemptId,
      now: iso(3),
    })

    const owner = workerStore.findWorkerOwnerByTask({ taskId: task.taskId, attemptId: task.attemptId })
    assert.equal(owner?.workerId, 'w1')
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markWorkerStatus clears current task ownership when worker becomes terminal', () => {
  const { dir, workerStore, taskStore } = openTempStores()
  try {
    workerStore.registerWorker({ workerId: 'w1', workflow: 'wf', kind: 'daemon', pid: 100, hostname: 'host', phase: 'processing' })
    const [task] = taskStore.enqueueTasks({ workflow: 'wf', inputs: [{ id: 'a' }], deriveItemId: (x) => x.id, now: iso(1) })
    workerStore.heartbeatWorker({
      workerId: 'w1',
      phase: 'processing',
      currentTaskId: task.taskId,
      currentAttemptId: task.attemptId,
      now: iso(2),
    })

    workerStore.markWorkerStatus({ workerId: 'w1', status: 'dead', phase: 'exited', now: iso(3) })

    const worker = workerStore.getWorker('w1')
    assert.equal(worker?.status, 'dead')
    assert.equal(worker?.currentTaskId, undefined)
    assert.equal(worker?.currentAttemptId, undefined)
  } finally {
    workerStore.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
