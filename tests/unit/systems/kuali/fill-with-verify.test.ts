import test from 'node:test'
import assert from 'node:assert/strict'
import { fillWithVerify } from '../../../../src/systems/kuali/navigate.js'

function makeLocator(behavior: 'ok' | 'drop-once' | 'always-drop') {
  let state = ''
  const calls = { fill: 0, clear: 0, type: 0, inputValue: 0 }
  return {
    calls,
    async fill(v: string) {
      calls.fill++
      if (behavior === 'ok') state = v
      if (behavior === 'drop-once' && calls.fill === 1) state = ''
      if (behavior === 'drop-once' && calls.fill >= 2) state = v
      if (behavior === 'always-drop') state = ''
    },
    async clear() { calls.clear++; state = '' },
    async pressSequentially(v: string) { calls.type++; if (behavior !== 'always-drop') state = v },
    async inputValue() { calls.inputValue++; return state },
  }
}

test('fast path — no retry when fill succeeds', async () => {
  const loc = makeLocator('ok') as any
  await fillWithVerify(loc, 'T001', 'txn#')
  assert.equal(loc.calls.fill, 1)
  assert.equal(loc.calls.type, 0)
})

test('retries with type() when fill silently drops', async () => {
  const loc = makeLocator('drop-once') as any
  await fillWithVerify(loc, 'T001', 'txn#')
  assert.equal(loc.calls.fill, 1)
  assert.equal(loc.calls.clear, 1)
  assert.equal(loc.calls.type, 1)
})

test('throws when both fill and type() fail', async () => {
  const loc = makeLocator('always-drop') as any
  await assert.rejects(() => fillWithVerify(loc, 'T001', 'txn#'))
})
