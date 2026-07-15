import { test } from 'vitest'
import assert from 'node:assert/strict'

import { terminalizeWithReconciliation } from '../../../src/core/daemon/terminalization.js'
import type { TaskRow, TaskTransitionOutcome } from '../../../src/core/task-store/index.js'

const runningTask = (): TaskRow => ({
  taskId: 'task-1',
  workflow: 'wf',
  itemId: 'item-1',
  input: {},
  state: 'running',
})

test('terminalization retries bounded write errors and returns applied', async () => {
  let calls = 0
  const result = await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => {
      calls++
      if (calls < 3) throw new Error('sqlite busy')
      return { kind: 'applied' }
    },
    readTask: runningTask,
    blockUncertain: () => ({ kind: 'applied' }),
  })
  assert.deepEqual(result, { kind: 'applied' })
  assert.equal(calls, 3)
})

test('terminalization read-reconciles a write that committed before its caller observed an error', async () => {
  const result = await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => { throw new Error('connection lost after commit') },
    readTask: () => ({ ...runningTask(), state: 'done' }),
    blockUncertain: () => { throw new Error('must not block a reconciled terminal') },
  })
  assert.deepEqual(result, { kind: 'reconciled' })
})

test('terminalization blocks an exact still-owned task after repeated uncertain writes', async () => {
  let blockReason = ''
  const result = await terminalizeWithReconciliation({
    desiredState: 'failed',
    transition: () => { throw new Error('disk I/O') },
    readTask: runningTask,
    blockUncertain: (reason): TaskTransitionOutcome => {
      blockReason = reason
      return { kind: 'applied' }
    },
  })
  assert.equal(result.kind, 'blocked-uncertain')
  assert.match(blockReason, /terminal state 'failed'.*disk I\/O/)
})

test('terminalization never reports blocked when the exact lease was lost', async () => {
  const result = await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => { throw new Error('write failed') },
    readTask: runningTask,
    blockUncertain: () => ({ kind: 'lease-lost' }),
  })
  assert.deepEqual(result, { kind: 'lease-lost' })
})

test('terminalization preserves direct not-found and conflicting-terminal outcomes', async () => {
  assert.deepEqual(await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => ({ kind: 'not-found' }),
    readTask: () => null,
    blockUncertain: () => ({ kind: 'applied' }),
  }), { kind: 'not-found' })

  assert.deepEqual(await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => ({ kind: 'already-terminal', state: 'failed' }),
    readTask: () => ({ ...runningTask(), state: 'failed' }),
    blockUncertain: () => ({ kind: 'applied' }),
  }), { kind: 'conflict-terminal', state: 'failed' })
})

test('terminalization reports an unconfirmed block write instead of pretending the lease was lost', async () => {
  const result = await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => { throw new Error('terminal write failed') },
    readTask: runningTask,
    blockUncertain: () => { throw new Error('block write failed') },
  })
  assert.equal(result.kind, 'unconfirmed')
  if (result.kind === 'unconfirmed') assert.match(result.error, /block write failed/)
})

test('terminalization treats a missing block target after write errors as unconfirmed', async () => {
  const result = await terminalizeWithReconciliation({
    desiredState: 'done',
    transition: () => { throw new Error('terminal write failed') },
    readTask: runningTask,
    blockUncertain: () => ({ kind: 'not-found' }),
  })
  assert.equal(result.kind, 'unconfirmed')
})
