import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  enqueueItems,
  claimNextItem,
  markItemDone,
  markItemFailed,
  unclaimItem,
  recoverOrphanedClaims,
  readQueueState,
  queueFilePath,
} from '../../../src/core/daemon-queue.js'

const TMP = (): string => mkdtempSync(join(tmpdir(), 'daemon-q-'))

test('enqueueItems creates queue file and assigns 1-indexed positions', async () => {
  const dir = TMP()
  try {
    const result = await enqueueItems('wf', [{ x: 1 }, { x: 2 }, { x: 3 }], (_, i) => ['a', 'b', 'c'][i], dir)
    assert.equal(result.length, 3)
    assert.equal(result[0].id, 'a')
    assert.equal(result[0].position, 1)
    assert.match(result[0].runId, /^[0-9a-f-]{36}$/)
    assert.equal(result[1].id, 'b')
    assert.equal(result[1].position, 2)
    assert.match(result[1].runId, /^[0-9a-f-]{36}$/)
    assert.equal(result[2].id, 'c')
    assert.equal(result[2].position, 3)
    assert.match(result[2].runId, /^[0-9a-f-]{36}$/)
    // Pre-assigned runIds must be distinct (one per enqueue event).
    assert.equal(new Set(result.map((r) => r.runId)).size, 3)

    const state = await readQueueState('wf', dir)
    assert.deepEqual(state.queued.map((q) => q.id), ['a', 'b', 'c'])
    assert.equal(state.queued[0].state, 'queued')
    assert.deepEqual(state.queued[0].input, { x: 1 })
    // readQueueState folds the runId field through from the enqueue event.
    assert.equal(state.queued[0].runId, result[0].runId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextItem reuses the pre-assigned runId from the enqueue event', async () => {
  const dir = TMP()
  try {
    const enq = await enqueueItems('wf', [{ x: 1 }], () => 'a', dir)
    const preAssigned = enq[0].runId
    const claimed = await claimNextItem('wf', 'worker1', dir)
    assert.ok(claimed)
    assert.equal(claimed.runId, preAssigned)
    const state = await readQueueState('wf', dir)
    assert.equal(state.claimed[0]?.runId, preAssigned)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextItem generates a fresh runId for legacy enqueue events (no pre-assignment)', async () => {
  const dir = TMP()
  try {
    // Simulate a queue.jsonl written by an older version that didn't carry
    // a runId in its enqueue events. The daemon must still claim it and
    // assign a runId at claim time so downstream tracker rows have one.
    mkdirSync(join(dir, 'daemons'), { recursive: true })
    const path = queueFilePath('wf', dir)
    appendFileSync(
      path,
      JSON.stringify({
        type: 'enqueue',
        id: 'legacy-a',
        workflow: 'wf',
        input: { x: 1 },
        enqueuedAt: new Date().toISOString(),
        enqueuedBy: 'cli-legacy',
      }) + '\n',
    )
    const claimed = await claimNextItem('wf', 'worker1', dir)
    assert.ok(claimed)
    assert.match(claimed.runId!, /^[0-9a-f-]{36}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('enqueueItems with no inputs is a no-op', async () => {
  const dir = TMP()
  try {
    const result = await enqueueItems('wf', [], () => 'unused', dir)
    assert.deepEqual(result, [])
    const state = await readQueueState('wf', dir)
    assert.equal(state.queued.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextItem returns null when queue is empty', async () => {
  const dir = TMP()
  try {
    const item = await claimNextItem('wf', 'worker1', dir)
    assert.equal(item, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextItem returns first queued item and marks it claimed', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'only', dir)
    const claimed = await claimNextItem('wf', 'w1', dir)
    assert.equal(claimed?.id, 'only')
    assert.equal(claimed?.state, 'claimed')
    assert.equal(claimed?.claimedBy, 'w1')
    assert.ok(claimed?.runId)

    const state = await readQueueState('wf', dir)
    assert.equal(state.queued.length, 0)
    assert.equal(state.claimed.length, 1)
    assert.equal(state.claimed[0].id, 'only')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextItem concurrent callers — exactly one wins per item', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'solo', dir)
    const attempts = await Promise.all([
      claimNextItem('wf', 'w1', dir),
      claimNextItem('wf', 'w2', dir),
      claimNextItem('wf', 'w3', dir),
      claimNextItem('wf', 'w4', dir),
      claimNextItem('wf', 'w5', dir),
    ])
    const wins = attempts.filter((c) => c !== null)
    assert.equal(wins.length, 1, 'exactly one concurrent claim should win')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claimNextItem skips already-claimed items and returns the next queued', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}, {}], (_, i) => ['first', 'second'][i], dir)
    const first = await claimNextItem('wf', 'w1', dir)
    const second = await claimNextItem('wf', 'w2', dir)
    assert.equal(first?.id, 'first')
    assert.equal(second?.id, 'second')
    assert.notEqual(first?.runId, second?.runId)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markItemDone transitions claimed → done in state fold', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'x', dir)
    const claimed = await claimNextItem('wf', 'w1', dir)
    await markItemDone('wf', 'x', claimed!.runId!, dir)
    const state = await readQueueState('wf', dir)
    assert.equal(state.queued.length, 0)
    assert.equal(state.claimed.length, 0)
    assert.equal(state.done.length, 1)
    assert.equal(state.done[0].id, 'x')
    assert.equal(state.done[0].state, 'done')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('markItemFailed transitions claimed → failed with error message', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'x', dir)
    const c = await claimNextItem('wf', 'w1', dir)
    await markItemFailed('wf', 'x', 'boom', c!.runId!, dir)
    const state = await readQueueState('wf', dir)
    assert.equal(state.failed.length, 1)
    assert.equal(state.failed[0].error, 'boom')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unclaimItem transitions claimed → queued and clears claimedBy', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'x', dir)
    await claimNextItem('wf', 'w1', dir)
    await unclaimItem('wf', 'x', 'voluntary', dir)
    const state = await readQueueState('wf', dir)
    assert.equal(state.claimed.length, 0)
    assert.equal(state.queued.length, 1)
    assert.equal(state.queued[0].claimedBy, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recoverOrphanedClaims re-queues claims whose owner is not alive', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'orphan', dir)
    await claimNextItem('wf', 'dead-worker', dir)
    const count = await recoverOrphanedClaims('wf', new Set(['live-worker']), dir)
    assert.equal(count, 1)
    const state = await readQueueState('wf', dir)
    assert.deepEqual(state.queued.map((q) => q.id), ['orphan'])
    assert.equal(state.claimed.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recoverOrphanedClaims leaves claims by alive workers alone', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'mine', dir)
    await claimNextItem('wf', 'live-worker', dir)
    const count = await recoverOrphanedClaims('wf', new Set(['live-worker']), dir)
    assert.equal(count, 0)
    const state = await readQueueState('wf', dir)
    assert.equal(state.claimed.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueueState skips malformed lines (truncated / corrupted)', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{}], () => 'a', dir)
    appendFileSync(queueFilePath('wf', dir), 'not valid json\n')
    appendFileSync(queueFilePath('wf', dir), '{"type":"enqueue",') // truncated
    appendFileSync(queueFilePath('wf', dir), '\n')
    const state = await readQueueState('wf', dir)
    assert.deepEqual(state.queued.map((q) => q.id), ['a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueueState ignores orphan claim/done/failed events without prior enqueue', async () => {
  const dir = TMP()
  try {
    // Seed one real enqueue so the queue file + dir exist, then manually append
    // an orphan claim for a non-existent id.
    await enqueueItems('wf', [{}], () => 'real', dir)
    appendFileSync(
      queueFilePath('wf', dir),
      JSON.stringify({ type: 'claim', id: 'ghost', claimedBy: 'w1', claimedAt: 'x', runId: 'r' }) + '\n',
    )
    const state = await readQueueState('wf', dir)
    assert.deepEqual(state.queued.map((q) => q.id), ['real'])
    assert.equal(state.claimed.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readQueueState returns empty state when queue file does not exist', async () => {
  const dir = TMP()
  try {
    const state = await readQueueState('never-written', dir)
    assert.deepEqual(state, { queued: [], claimed: [], done: [], failed: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('full cycle: enqueue → claim → done (latest-event-per-id fold)', async () => {
  const dir = TMP()
  try {
    await enqueueItems('wf', [{ payload: 1 }, { payload: 2 }], (_, i) => ['a', 'b'][i], dir)
    const a = await claimNextItem('wf', 'w1', dir)
    const b = await claimNextItem('wf', 'w1', dir)
    await markItemDone('wf', 'a', a!.runId!, dir)
    await markItemFailed('wf', 'b', 'nope', b!.runId!, dir)
    const state = await readQueueState('wf', dir)
    assert.equal(state.queued.length, 0)
    assert.equal(state.claimed.length, 0)
    assert.equal(state.done.length, 1)
    assert.equal(state.failed.length, 1)
    assert.equal(state.done[0].id, 'a')
    assert.equal(state.failed[0].id, 'b')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
