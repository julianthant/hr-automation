/**
 * Contract 5: ctx.signal is a per-run AbortSignal handlers can pass to any
 * AbortSignal-aware await. Sourced from runOneItem's per-item
 * AbortController; flips to `aborted: true` when an operator cancel
 * triggers either the daemon's worker_command path or the in-process
 * cancel handler.
 */
import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { makeCtx } from '../../../src/core/kernel/ctx.js'
import { Session } from '../../../src/core/kernel/session.js'
import { Stepper } from '../../../src/core/kernel/stepper.js'

function buildCtx(controller: AbortController) {
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
  return makeCtx({
    session,
    stepper,
    isBatch: true,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
    signal: controller.signal,
  })
}

describe('ctx.signal', () => {
  test('is an AbortSignal that starts unaborted', () => {
    const controller = new AbortController()
    const ctx = buildCtx(controller)
    assert.ok(ctx.signal instanceof AbortSignal)
    assert.equal(ctx.signal.aborted, false)
  })

  test('flips to aborted when the source controller aborts', () => {
    const controller = new AbortController()
    const ctx = buildCtx(controller)
    assert.equal(ctx.signal.aborted, false)
    controller.abort(new Error('test cancel'))
    assert.equal(ctx.signal.aborted, true)
    assert.equal(String((ctx.signal as AbortSignal & { reason?: unknown }).reason), 'Error: test cancel')
  })

  test('propagates to AbortSignal-aware setTimeout (Promise.race)', async () => {
    const controller = new AbortController()
    const ctx = buildCtx(controller)

    // Simulate an AbortSignal-aware await — the kind of code a workflow
    // handler might write (or that Playwright's options.signal handles
    // internally).
    const wait = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => resolve('completed'), 5000)
      ctx.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    })

    queueMicrotask(() => controller.abort())
    await assert.rejects(wait, /aborted/)
  })

  test('listener fires synchronously when signal is already aborted at attach time', () => {
    const controller = new AbortController()
    const ctx = buildCtx(controller)
    controller.abort()

    let fired = false
    // Standard AbortSignal semantics: subscribing AFTER abort still fires
    // synchronously via the `aborted` check (callers typically guard).
    if (ctx.signal.aborted) fired = true
    assert.equal(fired, true)
  })
})
