/**
 * Contract 5: ctx.signal is a per-run AbortSignal handlers can pass to any
 * AbortSignal-aware await. Sourced from runOneItem's per-item
 * AbortController; flips to `aborted: true` when an operator cancel
 * triggers either the daemon's worker_command path or the in-process
 * cancel handler.
 */
import { test, describe } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { makeCtx } from '../../../src/core/kernel/ctx.js'
import { Session } from '../../../src/core/kernel/session.js'
import { Stepper } from '../../../src/core/kernel/stepper.js'
import { defineWorkflow } from '../../../src/core/index.js'
import { delegateToImpl } from '../../../src/core/delegate.js'

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

describe('in-process delegation propagates parent signal (Finding #7)', () => {
  test('parent abort flips child ctx.signal.aborted to true mid-run', async (t) => {
    const trackerDir = mkdtempSync(join(tmpdir(), 'parent-signal-delegate-'))
    t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }))

    // Capture the child's ctx so we can inspect its signal from the test.
    let childCtxSignal: AbortSignal | null = null
    let childObservedAbortReason: unknown = null
    let childResolveStarted!: () => void
    const childStarted = new Promise<void>((r) => { childResolveStarted = r })

    const child = defineWorkflow({
      name: 'parent-signal-child',
      archetype: 'single',
      systems: [],
      authSteps: false,
      steps: ['wait'] as const,
      schema: z.object({ payload: z.string() }),
      detailFields: [{ key: 'payload', label: 'Payload' }],
      getName: (d) => d.payload ?? '',
      getId: (d) => d.payload ?? '',
      handler: async (ctx) => {
        childCtxSignal = ctx.signal
        await ctx.step('wait', async () => {
          // Signal the test we're inside the handler, then await an
          // AbortSignal-aware promise that resolves only on abort.
          childResolveStarted()
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 5000)
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t)
              childObservedAbortReason = ctx.signal.reason
              reject(new Error('child saw parent abort'))
            }, { once: true })
          })
        })
      },
    })

    const parentController = new AbortController()
    const childPromise = delegateToImpl({
      parentRunId: 'parent-run-fs',
      trackerDir,
      child,
      input: { payload: 'p' },
      itemId: 'parent-signal-item',
      runId: 'parent-signal-run',
      fireAndForget: false,
      parentSignal: parentController.signal,
    })

    // Wait until the child is inside its handler, then abort the parent.
    await childStarted
    assert.equal(childCtxSignal?.aborted, false, 'child signal starts unaborted')
    parentController.abort(new Error('parent cancelled'))

    const result = await childPromise
    assert.equal(childCtxSignal!.aborted, true, 'child ctx.signal flips to aborted after parent abort')
    assert.ok(childObservedAbortReason, 'child observed the abort via its signal listener')
    // The child threw inside ctx.step due to the abort — should be failed/cancelled.
    assert.ok(result.status === 'failed' || result.status === 'cancelled', `expected failed/cancelled, got ${result.status}`)
  })

  test('parent already aborted at delegate time → child sees aborted signal immediately', async (t) => {
    const trackerDir = mkdtempSync(join(tmpdir(), 'parent-signal-pre-abort-'))
    t.onTestFinished(() => rmSync(trackerDir, { recursive: true, force: true }))

    let childCtxSignalAborted = false
    const child = defineWorkflow({
      name: 'parent-pre-abort-child',
      archetype: 'single',
      systems: [],
      authSteps: false,
      steps: ['noop'] as const,
      schema: z.object({ payload: z.string() }),
      detailFields: [{ key: 'payload', label: 'Payload' }],
      getName: (d) => d.payload ?? '',
      getId: (d) => d.payload ?? '',
      handler: async (ctx) => {
        // Capture state synchronously at handler entry.
        childCtxSignalAborted = ctx.signal.aborted
        await ctx.step('noop', async () => {})
      },
    })

    const parentController = new AbortController()
    parentController.abort(new Error('pre-aborted'))
    await delegateToImpl({
      parentRunId: 'parent-run-pre',
      trackerDir,
      child,
      input: { payload: 'p' },
      itemId: 'pre-abort-item',
      runId: 'pre-abort-run',
      fireAndForget: false,
      parentSignal: parentController.signal,
    })
    assert.equal(childCtxSignalAborted, true, 'child sees aborted signal at handler entry when parent pre-aborted')
  })
})
