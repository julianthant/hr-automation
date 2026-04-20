import test from 'node:test'
import assert from 'node:assert/strict'
import { makeAuthObserver } from '../../../src/tracker/auth-observer.js'

function collect<T>() {
  const events: T[] = []
  return { emit: (e: T) => { events.push(e) }, events }
}

test('onAuthStart emits step-start with auth:<id> name', () => {
  const c = collect<any>()
  const obs = makeAuthObserver({ emitStep: c.emit, emitFailed: () => {}, screenshot: async () => ({} as any) })
  obs.onAuthStart?.('kuali', 'b1')
  assert.equal(c.events.length, 1)
  assert.equal(c.events[0], 'auth:kuali')
})

test('onAuthComplete emits step-start again so downstream consumers see completion transition', () => {
  const c = collect<any>()
  const obs = makeAuthObserver({ emitStep: c.emit, emitFailed: () => {}, screenshot: async () => ({} as any) })
  obs.onAuthStart?.('kuali', 'b1')
  obs.onAuthComplete?.('kuali', 'b1')
  assert.deepEqual(c.events, ['auth:kuali', 'auth:kuali'])
})

test('onAuthFailed emits emitFailed and triggers screenshot', async () => {
  let failedArgs: [string, string] | null = null
  let shotCalled = false
  const obs = makeAuthObserver({
    emitStep: () => {},
    emitFailed: (step, err) => { failedArgs = [step, err] },
    screenshot: async (opts) => {
      shotCalled = true
      assert.equal(opts.kind, 'error')
      assert.equal(opts.label, 'auth:kuali')
      return { kind: 'error', label: 'auth:kuali', step: null, ts: 0, files: [] }
    },
  })
  await obs.onAuthFailed?.('kuali', 'b1')
  assert.ok(failedArgs)
  assert.equal(failedArgs?.[0], 'auth:kuali')
  assert.ok(shotCalled)
})
