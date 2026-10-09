import { test } from 'vitest'
import assert from 'node:assert/strict'
import { makeCtx } from '../../../src/core/kernel/ctx.js'
import { Session } from '../../../src/core/kernel/session.js'
import { Stepper } from '../../../src/core/kernel/stepper.js'

test('makeCtx returns a Ctx with page/step/parallel/updateData/session bound', () => {
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
  const controller = new AbortController()
  const ctx = makeCtx({
    session,
    stepper,
    isBatch: true,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
    signal: controller.signal,
  })

  assert.equal(typeof ctx.page, 'function')
  assert.equal(typeof ctx.step, 'function')
  assert.equal(typeof ctx.parallel, 'function')
  assert.equal(typeof ctx.updateData, 'function')
  assert.equal(ctx.isBatch, true)
  assert.equal(ctx.runId, 'r1')
  assert.equal(typeof ctx.session.page, 'function')
  assert.equal(typeof ctx.screenshot, 'function')
  assert.ok(ctx.signal instanceof AbortSignal, 'ctx.signal is an AbortSignal')
  assert.equal(ctx.signal.aborted, false)
})

test('captureAndStampScreenshot captures a form screenshot and stamps first filename', async () => {
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
    signal: new AbortController().signal,
  })
  ctx.screenshot = async (opts) => {
    assert.deepEqual(opts, { kind: 'form', label: 'person-org-summary' })
    return {
      type: 'screenshot',
      runId: 'r1',
      ts: 1,
      timestamp: '2026-05-15T00:00:00.000Z',
      kind: 'form',
      label: 'person-org-summary',
      step: null,
      files: [{ system: 'ucpath', path: '/tmp/person-org.png' }],
    }
  }

  await ctx.captureAndStampScreenshot('person-org-summary', 'personOrgScreenshot')

  assert.equal(ctx.data.personOrgScreenshot, 'person-org.png')
})

test('captureAndStampScreenshot does not stamp a DIFFERENT system\'s file when the requested system produced none (fail loud, no wrong-system fallback)', async () => {
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
    signal: new AbortController().signal,
  })
  ctx.screenshot = async (opts) => {
    assert.deepEqual(opts, { kind: 'form', label: 'CRM search failed', systems: ['ucpath'] })
    // Requested system ("ucpath") produced no file; a DIFFERENT system's
    // ("crm") capture succeeded instead — this must never be stamped under
    // the ucpath-labeled data key.
    return {
      type: 'screenshot',
      runId: 'r1',
      ts: 1,
      timestamp: '2026-05-15T00:00:00.000Z',
      kind: 'form',
      label: 'CRM search failed',
      step: null,
      files: [{ system: 'crm', path: '/tmp/crm-record.png' }],
    }
  }

  await ctx.captureAndStampScreenshot('CRM search failed', 'personOrgSearchScreenshot', {
    systems: ['ucpath'],
  })

  assert.equal(ctx.data.personOrgSearchScreenshot, undefined)
})

// ─── ctx.retry — signal-aware cancellation behavior ──────────────────────────

/** Build a ctx whose retry is bound to `signal` (mirrors the real makeCtx). */
function makeRetryCtx(signal: AbortSignal): ReturnType<typeof makeCtx> {
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
    isBatch: false,
    runId: 'r1',
    workflow: 'test',
    itemId: 't1',
    emitScreenshotEvent: () => {},
    signal,
  })
}

test('ctx.retry retries a transient failure then succeeds', async () => {
  const ctx = makeRetryCtx(new AbortController().signal)
  let calls = 0
  const result = await ctx.retry(
    async () => {
      calls += 1
      if (calls < 3) throw new Error('flaky')
      return 'ok'
    },
    { attempts: 3, backoffMs: 0 },
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3, 'retried twice then succeeded')
})

test('ctx.retry throws the abort reason WITHOUT running fn when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancel requested'))
  const ctx = makeRetryCtx(controller.signal)
  let calls = 0
  await assert.rejects(
    ctx.retry(
      async () => {
        calls += 1
        return 'ok'
      },
      { attempts: 3, backoffMs: 0 },
    ),
    /cancel requested/,
    'exits with the abort reason before any attempt',
  )
  assert.equal(calls, 0, 'fn is never invoked after cancellation')
})

test('ctx.retry does NOT retry a cancellation-type error escaping fn', async () => {
  const ctx = makeRetryCtx(new AbortController().signal)
  let calls = 0
  const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
  await assert.rejects(
    ctx.retry(
      async () => {
        calls += 1
        throw abortErr
      },
      { attempts: 3, backoffMs: 0 },
    ),
    /aborted/,
  )
  assert.equal(calls, 1, 'a cancellation-type error is rethrown, not retried')
})

test('ctx.retry aborts promptly during the backoff sleep instead of sleeping blind', async () => {
  const controller = new AbortController()
  const ctx = makeRetryCtx(controller.signal)
  let calls = 0
  // A long backoff would block for ~60s if the sleep were signal-unaware.
  const p = ctx.retry(
    async () => {
      calls += 1
      throw new Error('flaky')
    },
    { attempts: 3, backoffMs: 60_000 },
  )
  // Let attempt 1 run and enter the backoff sleep, then abort mid-sleep.
  await new Promise((r) => setTimeout(r, 20))
  controller.abort(new Error('cancel requested'))
  await assert.rejects(p, 'the retry rejects as soon as the signal aborts')
  assert.equal(calls, 1, 'only the first attempt ran; the backoff did not block for the full delay')
})
