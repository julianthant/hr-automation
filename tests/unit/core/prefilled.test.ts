/**
 * Kernel-level edit-and-resume primitives:
 *   - splitPrefilled — strips the prefilledData channel from arbitrary input
 *   - ctx.data — live getter on Ctx returning a fresh shallow copy
 *   - ctx.skipStep — emits a `skipped` row via Stepper's emitSkipped hook
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitPrefilled } from '../../../src/core/workflow.js'
import { Stepper } from '../../../src/core/stepper.js'
import { Session } from '../../../src/core/session.js'
import { makeCtx } from '../../../src/core/ctx.js'

test('splitPrefilled: returns input untouched + null prefilled when no channel', () => {
  const input = { docId: '3930' }
  const { cleaned, prefilled } = splitPrefilled(input)
  assert.deepEqual(cleaned, { docId: '3930' })
  assert.equal(prefilled, null)
})

test('splitPrefilled: extracts prefilledData and removes it from cleaned', () => {
  const input = { docId: '3930', prefilledData: { name: 'Jane Doe', eid: '12345' } }
  const { cleaned, prefilled } = splitPrefilled(input)
  assert.deepEqual(cleaned, { docId: '3930' })
  assert.deepEqual(prefilled, { name: 'Jane Doe', eid: '12345' })
})

test('splitPrefilled: does NOT mutate the input', () => {
  const input = { docId: '3930', prefilledData: { name: 'Jane Doe' } }
  splitPrefilled(input)
  // prefilledData is still there on the original — destructuring made a new
  // object but the kernel's promise is not to mutate the input the user passed.
  assert.deepEqual(input, { docId: '3930', prefilledData: { name: 'Jane Doe' } })
})

test('splitPrefilled: ignores prefilledData when not an object', () => {
  for (const bad of ['string', 42, true, null, undefined, [1, 2, 3]] as const) {
    const { cleaned, prefilled } = splitPrefilled({ docId: 'x', prefilledData: bad })
    assert.equal(prefilled, null, `expected null for ${JSON.stringify(bad)}`)
    assert.deepEqual(cleaned, { docId: 'x' })
  }
})

test('splitPrefilled: tolerates non-object input', () => {
  for (const v of ['string', 42, null, undefined, [1, 2]] as const) {
    const { cleaned, prefilled } = splitPrefilled(v)
    assert.equal(cleaned, v)
    assert.equal(prefilled, null)
  }
})

test('ctx.data: returns a live snapshot of stepper.data', () => {
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  const stepper = new Stepper({
    workflow: 'test',
    itemId: 't1',
    runId: 'r1',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
  })
  const ctx = makeCtx({
    session,
    stepper,
    isBatch: false,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
  })
  assert.deepEqual(ctx.data, {})
  ctx.updateData({ name: 'Jane' })
  assert.deepEqual(ctx.data, { name: 'Jane' })
  ctx.updateData({ eid: '12345' })
  assert.deepEqual(ctx.data, { name: 'Jane', eid: '12345' })
})

test('ctx.data: each access returns a fresh copy (mutation does not leak back)', () => {
  const session = Session.forTesting({
    systems: [{ id: 'ucpath', login: async () => {} }],
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  const stepper = new Stepper({
    workflow: 'test',
    itemId: 't1',
    runId: 'r1',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
  })
  const ctx = makeCtx({
    session,
    stepper,
    isBatch: false,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
  })
  ctx.updateData({ name: 'Jane' })
  const snap1 = ctx.data
  ;(snap1 as Record<string, unknown>).name = 'Mutated'
  // Subsequent access still returns the original Jane.
  assert.equal(ctx.data.name, 'Jane')
})

test('Stepper.skipStep: fires emitSkipped with the step name', () => {
  const skipped: string[] = []
  const stepper = new Stepper({
    workflow: 'test',
    itemId: 't1',
    runId: 'r1',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
    emitSkipped: (name) => skipped.push(name),
  })
  stepper.skipStep('extraction')
  assert.deepEqual(skipped, ['extraction'])
  assert.equal(stepper.getCurrentStep(), 'extraction')
})

test('Stepper.skipStep: gracefully no-ops when emitSkipped is absent', () => {
  const stepper = new Stepper({
    workflow: 'test',
    itemId: 't1',
    runId: 'r1',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
  })
  // Should not throw — older callers without the hook still work.
  stepper.skipStep('extraction')
  assert.equal(stepper.getCurrentStep(), 'extraction')
})
