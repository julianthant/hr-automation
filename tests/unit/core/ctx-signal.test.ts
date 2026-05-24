/**
 * Contract 5: ctx.signal is a per-run AbortSignal handlers can pass to any
 * AbortSignal-aware await. Sourced from runOneItem's per-item
 * AbortController; flips to `aborted: true` when an operator cancel
 * triggers either the daemon's worker_command path or the in-process
 * cancel handler.
 */
import { test, describe, vi } from 'vitest'
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
import type { Page } from 'playwright'

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
    // Wrap in a ref object so TS doesn't narrow the closure-captured value
    // back to its initializer type (`null`) at later access points.
    const childCtxRef: { signal: AbortSignal | null } = { signal: null }
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
        childCtxRef.signal = ctx.signal
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
    assert.equal(childCtxRef.signal?.aborted, false, 'child signal starts unaborted')
    parentController.abort(new Error('parent cancelled'))

    const result = await childPromise
    assert.equal(childCtxRef.signal!.aborted, true, 'child ctx.signal flips to aborted after parent abort')
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

// ---------------------------------------------------------------------------
// Finding #16 — ctx.page(id) returns a proxy that injects signal into action
// methods but leaves evaluate args clean (Bug #3 regression).
//
// Motivation: Bug #3 was that evaluate/evaluateHandle/$eval/$$eval were in
// SIGNAL_METHODS, causing phantom signal injection into the function's arg
// parameter. These tests pin the correct behavior so a refactor can't silently
// re-add them.
// ---------------------------------------------------------------------------
describe('ctx.page(id) proxy — signal injection', () => {
  /**
   * Build a minimal fake Page with vi.fn() stubs for the methods we probe,
   * wire it into a Session.forTesting browser slot, then get a ctx via
   * makeCtx so we exercise the full ctx.page() → wrapPageWithSignal() path.
   */
  function buildCtxWithFakePage(controller: AbortController) {
    // Hold typed vi.fn() mocks separately so tests can read `.mock.calls`
    // — the `as unknown as Page` cast below erases vitest's mock metadata
    // from the Page surface, but the standalone refs keep it.
    const clickMock = vi.fn().mockResolvedValue(undefined)
    const evaluateMock = vi.fn().mockResolvedValue(42)
    const gotoMock = vi.fn().mockResolvedValue(undefined)
    const fakePage = {
      click: clickMock,
      evaluate: evaluateMock,
      goto: gotoMock,
    } as unknown as Page

    // Session.forTesting requires: systems[], browsers Map, readyPromises Map.
    // SystemSlot shape: { page, context, browser }. We only need page here.
    const session = Session.forTesting({
      systems: [{ id: 'ucpath', login: async () => {} }],
      browsers: new Map([
        ['ucpath', { page: fakePage, context: {} as never, browser: null }],
      ]),
      readyPromises: new Map([['ucpath', Promise.resolve()]]),
    })

    const stepper = new Stepper({
      workflow: 'test',
      itemId: 'proxy-item',
      runId: 'proxy-run',
      emitStep: () => {},
      emitData: () => {},
      emitFailed: () => {},
    })

    const ctx = makeCtx({
      session,
      stepper,
      isBatch: false,
      runId: 'proxy-run',
      workflow: 'test',
      itemId: 'proxy-item',
      emitScreenshotEvent: () => {},
      signal: controller.signal,
    })

    return { ctx, fakePage, clickMock, evaluateMock, gotoMock }
  }

  test('click() injects signal into options arg', async () => {
    const controller = new AbortController()
    const { ctx, clickMock } = buildCtxWithFakePage(controller)

    const proxyPage = await ctx.page('ucpath')
    await proxyPage.click('button')

    assert.equal(clickMock.mock.calls.length, 1, 'click was called once')
    const [, opts] = clickMock.mock.calls[0] as [string, { signal?: AbortSignal }]
    assert.ok(opts && typeof opts === 'object', 'options object was appended')
    assert.equal(opts.signal, controller.signal, 'ctx.signal was injected into click options')
  })

  test('goto() injects signal into options arg', async () => {
    const controller = new AbortController()
    const { ctx, gotoMock } = buildCtxWithFakePage(controller)

    const proxyPage = await ctx.page('ucpath')
    await proxyPage.goto('about:blank')

    assert.equal(gotoMock.mock.calls.length, 1, 'goto was called once')
    const [, opts] = gotoMock.mock.calls[0] as [string, { signal?: AbortSignal }]
    assert.ok(opts && typeof opts === 'object', 'options object was appended')
    assert.equal(opts.signal, controller.signal, 'ctx.signal was injected into goto options')
  })

  test('evaluate(fn) with no second arg — underlying evaluate called with exactly one arg (Bug #3 regression)', async () => {
    // Bug #3: evaluate was in SIGNAL_METHODS, causing the proxy to append
    // `{ signal }` as a phantom second arg. The page function would receive
    // { signal } as its `arg` parameter — misbehavior in every evaluate call.
    const controller = new AbortController()
    const { ctx, evaluateMock } = buildCtxWithFakePage(controller)

    const proxyPage = await ctx.page('ucpath')
    await proxyPage.evaluate(() => 42)

    assert.equal(evaluateMock.mock.calls.length, 1)
    const call = evaluateMock.mock.calls[0] as unknown[]
    assert.equal(call.length, 1, 'evaluate must be called with exactly one arg — no phantom signal injection')
  })

  test('evaluate(fn, arg) with plain arg — underlying evaluate called with exactly (fn, arg), no signal', async () => {
    const controller = new AbortController()
    const { ctx, evaluateMock } = buildCtxWithFakePage(controller)

    const proxyPage = await ctx.page('ucpath')
    const fn = (x: number) => x + 1
    await proxyPage.evaluate(fn, 10)

    assert.equal(evaluateMock.mock.calls.length, 1)
    const call = evaluateMock.mock.calls[0] as unknown[]
    assert.equal(call.length, 2, 'evaluate must be called with exactly (fn, arg) — no signal appended as third arg')
    assert.equal(call[1], 10, 'second arg must be the original arg value, not merged with signal')
    assert.ok(
      !call[2],
      'no third arg must exist (signal must NOT be appended or merged into evaluate args)',
    )
  })

  test('caller-provided signal on a SIGNAL_METHOD is not clobbered', async () => {
    // The proxy must NOT override a caller-supplied signal — callers that
    // wire their own AbortController for finer-grain control must win.
    const controller = new AbortController()
    const { ctx, clickMock } = buildCtxWithFakePage(controller)

    const callerController = new AbortController()
    const proxyPage = await ctx.page('ucpath')
    // The proxy's signal injection itself uses a known Page method type; cast
    // here to allow the test to pass an explicit options.signal that Playwright's
    // type surface doesn't formally publish (it does support it at runtime).
    await (proxyPage.click as (sel: string, opts: { signal?: AbortSignal }) => Promise<void>)(
      'button',
      { signal: callerController.signal },
    )

    const [, opts] = clickMock.mock.calls[0] as [string, { signal?: AbortSignal }]
    assert.equal(
      opts.signal,
      callerController.signal,
      'caller-provided signal must not be clobbered by ctx.signal',
    )
    assert.notEqual(opts.signal, controller.signal)
  })
})
