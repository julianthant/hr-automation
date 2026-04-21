import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withBatchLifecycle, createBatchObserver } from '../../../src/core/batch-lifecycle.js'

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-batchlife-'))

function readSessions(dir: string): any[] {
  const p = join(dir, 'sessions.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function readTracker(dir: string, wf: string): any[] {
  const today = new Date().toISOString().slice(0, 10)
  const p = join(dir, `${wf}-${today}.jsonl`)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('withBatchLifecycle: happy path emits one workflow_start + one workflow_end(done)', async () => {
  const dir = TMP()
  await withBatchLifecycle(
    {
      workflow: 'lifetest',
      perItem: [
        { item: {}, itemId: 'i1', runId: 'r1' },
        { item: {}, itemId: 'i2', runId: 'r2' },
      ],
      trackerDir: dir,
    },
    async ({ instance, markTerminated }) => {
      assert.ok(instance.startsWith('lifetest'), 'instance allocated')
      markTerminated('r1')
      markTerminated('r2')
    },
  )

  const events = readSessions(dir)
  const starts = events.filter((e) => e.type === 'workflow_start')
  const ends = events.filter((e) => e.type === 'workflow_end')
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].finalStatus, 'done')
})

test('withBatchLifecycle: body throws before any markTerminated → fans out failed rows with auth step', async () => {
  const dir = TMP()
  let caught: unknown
  try {
    await withBatchLifecycle(
      {
        workflow: 'authfail',
        systems: [{ id: 'ucpath', login: async () => {} }],
        perItem: [
          { item: { n: 'a' }, itemId: 'a', runId: 'ra' },
          { item: { n: 'b' }, itemId: 'b', runId: 'rb' },
        ],
        trackerDir: dir,
      },
      async () => {
        throw new Error('auth failed')
      },
    )
  } catch (e) {
    caught = e
  }
  assert.ok(caught, 'error propagated')

  const entries = readTracker(dir, 'authfail')
  const failedA = entries.find((e: any) => e.id === 'a' && e.status === 'failed')
  const failedB = entries.find((e: any) => e.id === 'b' && e.status === 'failed')
  assert.ok(failedA, 'item a got failed row')
  assert.ok(failedB, 'item b got failed row')
  assert.equal(failedA.step, 'auth:ucpath', 'step attributed to first system auth')
  assert.equal(failedB.step, 'auth:ucpath')

  const events = readSessions(dir)
  const ends = events.filter((e) => e.type === 'workflow_end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].finalStatus, 'failed')
})

test('withBatchLifecycle: body throws after partial markTerminated → only un-terminated items get failed rows', async () => {
  const dir = TMP()
  try {
    await withBatchLifecycle(
      {
        workflow: 'partialfail',
        systems: [{ id: 'ucpath', login: async () => {} }],
        perItem: [
          { item: {}, itemId: 'a', runId: 'ra' },
          { item: {}, itemId: 'b', runId: 'rb' },
          { item: {}, itemId: 'c', runId: 'rc' },
        ],
        trackerDir: dir,
      },
      async ({ markTerminated }) => {
        markTerminated('ra')
        markTerminated('rb')
        throw new Error('mid-batch explode')
      },
    )
  } catch { /* expected */ }

  const entries = readTracker(dir, 'partialfail')
  // Only item c should have a failed row written by the fanout.
  // ra/rb were marked terminated so fanout skips them; c stays.
  // In post-auth failure (progress made), the fanout does NOT stamp a step
  // (because attributing post-auth throws to auth would be wrong).
  const failedFanout = entries.filter((e: any) => e.status === 'failed')
  const failedIds = failedFanout.map((e: any) => e.id).sort()
  assert.deepEqual(failedIds, ['c'], 'only un-terminated item c got fanout failed row')
  assert.equal(failedFanout[0].step, undefined, 'post-auth fanout has no step attribution')
})

test('withBatchLifecycle: emits session_create for the allocated instance', async () => {
  const dir = TMP()
  await withBatchLifecycle(
    {
      workflow: 'sessioncreate',
      perItem: [{ item: {}, itemId: 'i', runId: 'r' }],
      trackerDir: dir,
    },
    async ({ markTerminated }) => {
      markTerminated('r')
    },
  )
  const events = readSessions(dir)
  const sc = events.find((e) => e.type === 'session_create')
  assert.ok(sc, 'session_create emitted')
  assert.ok(sc.workflowInstance.startsWith('sessioncreate'))
})

test('createBatchObserver: pairs onAuthStart/onAuthComplete into authTimings', async () => {
  const dir = TMP()
  const { observer, getAuthTimings } = createBatchObserver('Test 1', '1', dir)
  assert.ok(observer.onAuthStart)
  assert.ok(observer.onAuthComplete)

  const beforeUc = Date.now()
  observer.onAuthStart!('ucpath', 'ucpath')
  await new Promise((r) => setTimeout(r, 15))
  observer.onAuthComplete!('ucpath', 'ucpath')
  const afterUc = Date.now()

  observer.onAuthStart!('crm', 'crm')
  await new Promise((r) => setTimeout(r, 15))
  observer.onAuthComplete!('crm', 'crm')

  const timings = getAuthTimings()
  assert.equal(timings.length, 2, 'one timing per system')
  const uc = timings.find((t) => t.systemId === 'ucpath')!
  assert.ok(uc, 'ucpath timing present')
  assert.ok(uc.startTs >= beforeUc && uc.startTs <= afterUc, 'uc startTs in range')
  assert.ok(uc.endTs >= uc.startTs + 10, 'uc endTs after startTs')

  const events = readSessions(dir)
  const authStarts = events.filter((e) => e.type === 'auth_start')
  const authCompletes = events.filter((e) => e.type === 'auth_complete')
  assert.equal(authStarts.length, 2)
  assert.equal(authCompletes.length, 2)
  assert.ok(authStarts.every((e) => e.workflowInstance === 'Test 1'))
})

test('createBatchObserver: onAuthFailed still records a timing (start → fail)', async () => {
  const dir = TMP()
  const { observer, getAuthTimings } = createBatchObserver('Test Fail 1', '1', dir)

  observer.onAuthStart!('ucpath', 'ucpath')
  await new Promise((r) => setTimeout(r, 10))
  observer.onAuthFailed!('ucpath', 'ucpath')

  const timings = getAuthTimings()
  assert.equal(timings.length, 1)
  assert.equal(timings[0].systemId, 'ucpath')
  assert.ok(timings[0].endTs >= timings[0].startTs)
})
