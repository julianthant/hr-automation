import { test } from 'vitest'
import assert from 'node:assert/strict'
import { Stepper } from '../../../src/core/kernel/stepper.js'

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

test('stepper.shouldSkipStep: false when skipSteps omitted', async () => {
  const { stepper } = mkStepper()
  assert.equal(stepper.shouldSkipStep('extraction'), false)
})

test('stepper.shouldSkipStep: true for names in the skipSteps set, false otherwise', async () => {
  const events: RecordedEvent[] = []
  const stepper = new Stepper({
    workflow: 'wf',
    itemId: 'id-1',
    runId: 'run-1',
    emitStep: (name) => events.push({ kind: 'step', step: name }),
    emitData: (data) => events.push({ kind: 'data', data }),
    emitFailed: (step, error) => events.push({ kind: 'failed', step, error }),
    skipSteps: new Set(['kronos-search', 'ucpath-job-summary']),
  })
  assert.equal(stepper.shouldSkipStep('kronos-search'), true)
  assert.equal(stepper.shouldSkipStep('ucpath-job-summary'), true)
  assert.equal(stepper.shouldSkipStep('kuali-extraction'), false)
  assert.equal(stepper.shouldSkipStep('ucpath-transaction'), false)
  // Decision-only — calling shouldSkipStep does NOT emit anything to tracker.
  assert.equal(events.length, 0)
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

test('stepper.parallelAll: returns fulfilled values in a record', async () => {
  const { stepper } = mkStepper()
  const result = await stepper.parallelAll({
    a: async () => 1,
    b: async () => 'two',
  })
  assert.deepEqual(result, { a: 1, b: 'two' })
})

test('stepper.parallelAll: rejects on first failure', async () => {
  const { stepper } = mkStepper()
  await assert.rejects(
    stepper.parallelAll({
      a: async () => {
        throw new Error('x')
      },
      b: async () => 1,
    }),
    /x/,
  )
})

test('stepper.parallelAll: empty object returns empty object', async () => {
  const { stepper } = mkStepper()
  const result = await stepper.parallelAll({})
  assert.deepEqual(result, {})
})

// ── Bug #3: cancel must interrupt a long parallel step PROMPTLY ──────────────
// Before the fix, parallel/parallelAll waited for every branch to settle
// naturally, so an operator cancel during separations' multi-minute
// 4-way `kronos-search` only surfaced at the NEXT step boundary ("can't stop
// midway"). With the run signal wired in, the abort wins the race immediately.

function mkStepperWithSignal(signal: AbortSignal) {
  const events: RecordedEvent[] = []
  const stepper = new Stepper({
    workflow: 'wf',
    itemId: 'id-1',
    runId: 'run-1',
    emitStep: (name) => events.push({ kind: 'step', step: name }),
    emitData: (data) => events.push({ kind: 'data', data }),
    emitFailed: (step, error) => events.push({ kind: 'failed', step, error }),
    signal,
  })
  return { stepper, events }
}

test('stepper.parallel: signal abort mid-flight rejects with CancelledError + marks step cancelled', async () => {
  const controller = new AbortController()
  const { stepper, events } = mkStepperWithSignal(controller.signal)
  // Branches that never settle on their own — only the abort can end the wait.
  const pending = stepper.parallel({
    a: () => new Promise<number>(() => {}),
    b: () => new Promise<number>(() => {}),
  })
  controller.abort(new Error('operator cancel'))
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof Error && err.name === 'CancelledError',
  )
  assert.ok(
    events.some((e) => e.kind === 'step' && e.step === 'cancelled'),
    'cancel surfaces a cancelled step emit for the dashboard row',
  )
})

test('stepper.parallel: already-aborted signal rejects immediately with CancelledError', async () => {
  const controller = new AbortController()
  controller.abort(new Error('pre-aborted'))
  const { stepper } = mkStepperWithSignal(controller.signal)
  await assert.rejects(
    stepper.parallel({ a: async () => 1 }),
    (err: unknown) => err instanceof Error && err.name === 'CancelledError',
  )
})

test('stepper.parallel: settles normally when the signal never aborts', async () => {
  const controller = new AbortController()
  const { stepper } = mkStepperWithSignal(controller.signal)
  const result = await stepper.parallel({ a: async () => 1, b: async () => 2 })
  assert.equal(result.a.status, 'fulfilled')
  assert.equal(result.b.status, 'fulfilled')
})

test('stepper.parallelAll: signal abort mid-flight rejects with CancelledError', async () => {
  const controller = new AbortController()
  const { stepper } = mkStepperWithSignal(controller.signal)
  const pending = stepper.parallelAll({ a: () => new Promise<number>(() => {}) })
  controller.abort(new Error('operator cancel'))
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof Error && err.name === 'CancelledError',
  )
})

test('stepper.markStep: emits step name without wrapping a body', () => {
  const { stepper, events } = mkStepper()
  assert.equal(stepper.getCurrentStep(), null)
  stepper.markStep('ucpath-auth')
  assert.equal(stepper.getCurrentStep(), 'ucpath-auth')
  // Exactly one step event fired, no failed event — markStep has no catch path.
  assert.deepEqual(events, [{ kind: 'step', step: 'ucpath-auth' }])
})

test('stepper.markStep: does not throw even if emitStep is a no-op', () => {
  const { stepper } = mkStepper()
  // Intentionally nothing to assert beyond "no throw" — markStep has no
  // failure path, so this call must simply succeed.
  assert.doesNotThrow(() => stepper.markStep('any-name'))
})

test('stepper calls screenshotFn on step failure with { kind: "error", label: stepName }', async () => {
  const captured: import('../../../src/core/kernel/types.js').ScreenshotOpts[] = []
  const stepper = new Stepper({
    workflow: 't',
    itemId: '1',
    runId: 'r',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
    screenshotFn: async (opts) => {
      captured.push(opts)
      return { kind: opts.kind, label: opts.label, step: null, ts: Date.now(), files: [] }
    },
  })
  await assert.rejects(
    () => stepper.step('boom', async () => { throw new Error('x') }),
    /x/,
  )
  assert.equal(captured.length, 1)
  assert.equal(captured[0].kind, 'error')
  assert.equal(captured[0].label, 'boom')
})

test('stepper does not call screenshotFn on success', async () => {
  const captured: import('../../../src/core/kernel/types.js').ScreenshotOpts[] = []
  const stepper = new Stepper({
    workflow: 't',
    itemId: '1',
    runId: 'r',
    emitStep: () => {},
    emitData: () => {},
    emitFailed: () => {},
    screenshotFn: async (opts) => {
      captured.push(opts)
      return { kind: opts.kind, label: opts.label, step: null, ts: Date.now(), files: [] }
    },
  })
  const result = await stepper.step('ok', async () => 42)
  assert.equal(result, 42)
  assert.deepEqual(captured, [])
})

test('stepper.isInsideStep: false outside step; true inside step fn', async () => {
  const { stepper } = mkStepper()
  assert.equal(stepper.isInsideStep(), false)
  await stepper.step('one', async () => {
    assert.equal(stepper.isInsideStep(), true)
  })
  assert.equal(stepper.isInsideStep(), false)
})

test('stepper.isInsideStep: nested steps', async () => {
  const { stepper } = mkStepper()
  await stepper.step('outer', async () => {
    assert.equal(stepper.isInsideStep(), true)
    await stepper.step('inner', async () => {
      assert.equal(stepper.isInsideStep(), true)
    })
    assert.equal(stepper.isInsideStep(), true)
  })
  assert.equal(stepper.isInsideStep(), false)
})
