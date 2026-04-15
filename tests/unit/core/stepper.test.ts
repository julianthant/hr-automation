import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Stepper } from '../../../src/core/stepper.js'

interface RecordedEvent {
  kind: 'step' | 'data' | 'done' | 'failed'
  step?: string
  data?: unknown
  error?: string
}

function mkStepper() {
  const events: RecordedEvent[] = []
  const stepper = new Stepper({
    workflow: 'wf',
    itemId: 'id-1',
    runId: 'run-1',
    emitStep: (name) => events.push({ kind: 'step', step: name }),
    emitData: (data) => events.push({ kind: 'data', data }),
    emitFailed: (step, error) => events.push({ kind: 'failed', step, error }),
  })
  return { stepper, events }
}

test('stepper.step: emits step on entry and returns result on success', async () => {
  const { stepper, events } = mkStepper()
  const result = await stepper.step('extraction', async () => 42)
  assert.equal(result, 42)
  assert.deepEqual(events, [{ kind: 'step', step: 'extraction' }])
})

test('stepper.step: emits failed on throw, rethrows', async () => {
  const { stepper, events } = mkStepper()
  await assert.rejects(
    () => stepper.step('extraction', async () => { throw new Error('boom') }),
    /boom/,
  )
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'step')
  assert.equal(events[1].kind, 'failed')
  assert.equal(events[1].step, 'extraction')
})

test('stepper.updateData: merges into pending data and emits', async () => {
  const { stepper, events } = mkStepper()
  stepper.updateData({ name: 'Alice' })
  stepper.updateData({ emplId: '123' })
  assert.equal(events.length, 2)
  assert.deepEqual(events[0].data, { name: 'Alice' })
  assert.deepEqual(events[1].data, { name: 'Alice', emplId: '123' })
})

test('stepper.parallel: returns PromiseSettledResult per key', async () => {
  const { stepper } = mkStepper()
  const result = await stepper.parallel({
    a: async () => 1,
    b: async () => { throw new Error('b failed') },
    c: async () => 3,
  })
  assert.equal(result.a.status, 'fulfilled')
  assert.equal(result.b.status, 'rejected')
  assert.equal(result.c.status, 'fulfilled')
  assert.equal((result.a as PromiseFulfilledResult<number>).value, 1)
  assert.equal((result.c as PromiseFulfilledResult<number>).value, 3)
})

test('stepper.parallel: empty object returns empty object', async () => {
  const { stepper } = mkStepper()
  const result = await stepper.parallel({})
  assert.deepEqual(result, {})
})
