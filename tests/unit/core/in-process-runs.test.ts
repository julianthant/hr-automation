import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerInProcessRun,
  unregisterInProcessRun,
  cancelInProcessRun,
  _listInProcessRunsForTests,
  _resetInProcessRunsForTests,
} from '../../../src/core/in-process-runs.js'
import type { Session } from '../../../src/core/session.js'

interface FakeSession {
  killChromeHard: (graceMs?: number) => Promise<number>
  killCalls: number[]
}

function makeFakeSession(opts: { throwOnKill?: boolean } = {}): FakeSession {
  const calls: number[] = []
  return {
    killCalls: calls,
    async killChromeHard(graceMs = 0) {
      calls.push(graceMs)
      if (opts.throwOnKill) throw new Error('boom')
      return calls.length
    },
  }
}

test('in-process-runs: register + cancel hard-kills the session', async () => {
  _resetInProcessRunsForTests()
  const fake = makeFakeSession()
  const ident = { workflow: 'sharepoint-download', itemId: 'roster-1', runId: 'r1' }
  registerInProcessRun(ident, fake as unknown as Session)
  assert.equal(_listInProcessRunsForTests().length, 1)

  const result = await cancelInProcessRun(ident)
  assert.deepEqual(result, { ok: true, alreadyCancelled: false })
  assert.equal(fake.killCalls.length, 1, 'killChromeHard called exactly once')
})

test('in-process-runs: cancel returns not-found when no run is registered', async () => {
  _resetInProcessRunsForTests()
  const result = await cancelInProcessRun({
    workflow: 'sharepoint-download',
    itemId: 'roster-1',
    runId: 'r1',
  })
  assert.deepEqual(result, { ok: false, reason: 'not-found' })
})

test('in-process-runs: second cancel is idempotent — flagged alreadyCancelled, no second kill', async () => {
  _resetInProcessRunsForTests()
  const fake = makeFakeSession()
  const ident = { workflow: 'wf', itemId: 'x', runId: 'r' }
  registerInProcessRun(ident, fake as unknown as Session)
  await cancelInProcessRun(ident)
  const second = await cancelInProcessRun(ident)
  assert.deepEqual(second, { ok: true, alreadyCancelled: true })
  assert.equal(fake.killCalls.length, 1, 'killChromeHard NOT called a second time')
})

test('in-process-runs: kill failure surfaces as ok=true (best-effort) and is still flagged cancelled', async () => {
  _resetInProcessRunsForTests()
  const fake = makeFakeSession({ throwOnKill: true })
  const ident = { workflow: 'wf', itemId: 'x', runId: 'r' }
  registerInProcessRun(ident, fake as unknown as Session)
  // Should not throw — cancel must not propagate kill errors to the dashboard.
  const result = await cancelInProcessRun(ident)
  assert.equal(result.ok, true)
  // Subsequent cancel still observes the cancelled flag (kill error didn't
  // unregister it).
  const second = await cancelInProcessRun(ident)
  assert.deepEqual(second, { ok: true, alreadyCancelled: true })
})

test('in-process-runs: unregister removes the entry; subsequent cancel returns not-found', async () => {
  _resetInProcessRunsForTests()
  const fake = makeFakeSession()
  const ident = { workflow: 'wf', itemId: 'x', runId: 'r' }
  registerInProcessRun(ident, fake as unknown as Session)
  unregisterInProcessRun(ident)
  assert.equal(_listInProcessRunsForTests().length, 0)
  const result = await cancelInProcessRun(ident)
  assert.deepEqual(result, { ok: false, reason: 'not-found' })
})

test('in-process-runs: keying isolates by (workflow, itemId, runId) tuple', async () => {
  _resetInProcessRunsForTests()
  const a = makeFakeSession()
  const b = makeFakeSession()
  registerInProcessRun({ workflow: 'wf', itemId: 'x', runId: 'r1' }, a as unknown as Session)
  registerInProcessRun({ workflow: 'wf', itemId: 'x', runId: 'r2' }, b as unknown as Session)
  assert.equal(_listInProcessRunsForTests().length, 2)
  await cancelInProcessRun({ workflow: 'wf', itemId: 'x', runId: 'r1' })
  assert.equal(a.killCalls.length, 1)
  assert.equal(b.killCalls.length, 0, 'r2 untouched')
})
