import { test } from 'vitest'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineWorkflow, runOneItem } from '../../../src/core/kernel/workflow.js'
import { Session } from '../../../src/core/kernel/session.js'
import { dateLocal } from '../../../src/tracker/jsonl.js'
import { rowFilePath } from '../../../src/tracker/paths.js'
import { runIdFragment, tracePrefix } from '../../../src/domain/queue-trace-id.js'

const TMP = () => mkdtempSync(join(tmpdir(), 'hrauto-runone-'))

function readTracker(dir: string, workflow: string): any[] {
  const today = dateLocal()
  const p = rowFilePath(workflow, today, dir)
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

test('runOneItem: authTimings emitted as synthetic pre-handler tracker entries at recorded timestamps', async () => {
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'auth-inject-test',
    systems: [
      { id: 'ucpath', login: async () => {} },
      { id: 'crm', login: async () => {} },
    ],
    // auto-prepended steps are auth:ucpath, auth:crm
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: true,
    handler: async (ctx) => {
      ctx.markStep('searching')
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([
      ['ucpath', Promise.resolve()],
      ['crm', Promise.resolve()],
    ]),
  })

  const ucStart = Date.parse('2026-04-21T21:41:28.762Z')
  const crmStart = Date.parse('2026-04-21T21:41:45.000Z')
  await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-x',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Auth Inject Test 1',
    authTimings: [
      { systemId: 'ucpath', startTs: ucStart, endTs: ucStart + 16_000 },
      { systemId: 'crm', startTs: crmStart, endTs: crmStart + 29_000 },
    ],
  })

  const entries = readTracker(dir, 'auth-inject-test')

  const authUc = entries.find((e: any) => e.status === 'running' && e.step === 'auth:ucpath')
  const authCrm = entries.find((e: any) => e.status === 'running' && e.step === 'auth:crm')
  assert.ok(authUc, 'emitted auth:ucpath entry')
  assert.ok(authCrm, 'emitted auth:crm entry')
  assert.equal(authUc.timestamp, new Date(ucStart).toISOString(), 'uc timestamp matches recorded startTs')
  assert.equal(authCrm.timestamp, new Date(crmStart).toISOString(), 'crm timestamp matches recorded startTs')

  const done = entries.find((e: any) => e.status === 'done')
  assert.ok(done, 'emitted done entry')
  assert.equal(done?.data?.instance, 'Auth Inject Test 1', 'instance stamped')
})

test('runOneItem: __runtimeOptions.skipSteps surfaces as ctx.shouldSkipStep + stamps data.__preset', async () => {
  const dir = TMP()
  const calls: { skipsA: boolean; skipsB: boolean; ranB: boolean; preset: unknown } = {
    skipsA: false,
    skipsB: false,
    ranB: false,
    preset: undefined,
  }
  const wf = defineWorkflow({
    name: 'skipsteps-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['step-a', 'step-b'] as const,
    schema: z.object({ docId: z.string() }),
    authSteps: false,
    handler: async (ctx) => {
      calls.skipsA = ctx.shouldSkipStep('step-a')
      calls.skipsB = ctx.shouldSkipStep('step-b')
      // step-a unconditionally skipped — kernel does NOT auto-skip;
      // handler decides what to do with the answer.
      if (ctx.shouldSkipStep('step-a')) ctx.skipStep('step-a')
      else await ctx.step('step-a', async () => {})
      if (!ctx.shouldSkipStep('step-b')) {
        await ctx.step('step-b', async () => { calls.ranB = true })
      }
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  await runOneItem({
    wf,
    session,
    item: {
      docId: 'd1',
      __runtimeOptions: { skipSteps: ['step-a'], preset: 'my-preset' },
    },
    itemId: 'd1',
    runId: 'run-skip',
    trackerDir: dir,
    callerPreEmits: false,
  })

  assert.equal(calls.skipsA, true, 'shouldSkipStep("step-a") true')
  assert.equal(calls.skipsB, false, 'shouldSkipStep("step-b") false')
  assert.equal(calls.ranB, true, 'step-b body ran')

  const entries = readTracker(dir, 'skipsteps-test')
  // data.__preset stamped on the pending row from runtimeOptions.preset.
  const pending = entries.find((e: any) => e.status === 'pending')
  assert.ok(pending, 'pending emitted')
  calls.preset = pending?.data?.__preset
  assert.equal(calls.preset, 'my-preset', 'data.__preset stamped from preset id')
  // A `skipped` row exists for step-a.
  const skippedA = entries.find((e: any) => e.status === 'skipped' && e.step === 'step-a')
  assert.ok(skippedA, 'step-a skipped row emitted')
})

test('runOneItem: __runtimeOptions.skipSteps with unknown step name throws (validation)', async () => {
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'skipsteps-unknown',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['a'] as const,
    schema: z.object({}),
    authSteps: false,
    handler: async () => {},
  })
  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })
  await assert.rejects(
    () =>
      runOneItem({
        wf,
        session,
        item: { __runtimeOptions: { skipSteps: ['typo-step'] } },
        itemId: 'x',
        runId: 'run-bad-skip',
        trackerDir: dir,
        callerPreEmits: false,
        trackerStub: true,
      }),
    /skipSteps contains unknown step name/,
  )
})

test('runOneItem: without authTimings, no synthetic auth entries are emitted', async () => {
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'no-auth-inject-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: true,
    handler: async (ctx) => {
      ctx.markStep('searching')
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-noauth',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'No Auth Inject 1',
    // no authTimings
  })

  const entries = readTracker(dir, 'no-auth-inject-test')
  const authEntries = entries.filter((e: any) => typeof e.step === 'string' && e.step.startsWith('auth:'))
  assert.equal(authEntries.length, 0, 'no synthetic auth entries without authTimings')
})

test('runOneItem: __runtimeOptions.rootTracePrefix survives splitPrefilled and composes <prefix>-<ownRunId4> on every row (daemon-worker path)', async () => {
  // The daemon worker re-emits pending+running for a delegated child whose
  // `__runtimeOptions.rootTracePrefix` was stamped at enqueue (root trace-id
  // propagation, trace/span model). With no prior frozen pending row, the child
  // COMPOSES `<prefix>-<ownRunId4>` and that composed id rides every row.
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'root-trace-worker-test',
    code: 'kt',
    inputSubject: 'eid',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ emplId: z.string() }),
    authSteps: false,
    operatorSubject: (input) => ({ kind: 'eid', label: input.emplId }),
    handler: async (ctx) => {
      ctx.markStep('searching')
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  const ROOT_PREFIX = 'ou-090553'
  const runId = 'run-root-trace'
  const expected = `${ROOT_PREFIX}-${runIdFragment(runId)}`
  await runOneItem({
    wf,
    session,
    item: { emplId: '10000050', __runtimeOptions: { rootTracePrefix: ROOT_PREFIX } },
    itemId: 'item-root-trace',
    runId,
    trackerDir: dir,
    callerPreEmits: false,
    parentRunId: 'ocr-root-run',
  })

  const entries = readTracker(dir, 'root-trace-worker-test')
  const traced = entries.filter((e: any) => e.data?.__traceId)
  assert.ok(traced.length >= 2, 'pending + at least one live row carry a trace id')
  for (const e of traced) {
    // Shares the operation prefix, keeps its own greppable tail.
    assert.equal(e.data.__traceId, expected, `${e.status} row composes <prefix>-<ownRunId4>`)
    assert.equal(tracePrefix(e.data.__traceId), ROOT_PREFIX, `${e.status} row shares the root prefix`)
  }
})

test('runOneItem: a 2nd emit reuses the frozen trace id (findFrozenTraceId wins over rootTracePrefix compose)', async () => {
  // Frozen-once invariant: once a pending row carries a trace id, a re-emit must
  // reuse it (findFrozenTraceId is the FIRST fallback). Here the frozen id was
  // already composed off the operation prefix, and the assertion pins that
  // findFrozenTraceId — not a fresh compose off the runtime option — is
  // consulted first.
  const dir = TMP()
  const wf = defineWorkflow({
    name: 'root-trace-frozen-test',
    code: 'kt',
    inputSubject: 'eid',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ emplId: z.string() }),
    authSteps: false,
    operatorSubject: (input) => ({ kind: 'eid', label: input.emplId }),
    handler: async (ctx) => {
      ctx.markStep('searching')
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  const ROOT_ID = 'ou-090553-1a57'
  const runId = 'run-frozen-trace'

  // First emit (caller pre-emits the pending row carrying the frozen root id).
  const { emitTrackerRow } = await import('../../../src/tracker/jsonl.js')
  emitTrackerRow(
    {
      workflow: 'root-trace-frozen-test',
      timestamp: new Date().toISOString(),
      id: 'item-frozen',
      runId,
      parentRunId: 'ocr-root-run',
      status: 'pending',
      data: { archetype: 'single', queueRowKind: 'person', __traceId: ROOT_ID },
    },
    dir,
  )

  // Second pass: a DIFFERENT rootTracePrefix is supplied, but findFrozenTraceId
  // must win — the row already carries ROOT_ID, so we reuse it (no drift, no
  // recompose off the new prefix).
  await runOneItem({
    wf,
    session,
    item: { emplId: '10000050', __runtimeOptions: { rootTracePrefix: 'ou-999999' } },
    itemId: 'item-frozen',
    runId,
    trackerDir: dir,
    callerPreEmits: false,
    parentRunId: 'ocr-root-run',
  })

  const entries = readTracker(dir, 'root-trace-frozen-test')
  const live = entries.filter((e: any) => (e.status === 'running' || e.status === 'done') && e.data?.__traceId)
  assert.ok(live.length > 0, 'should have at least one live row with a trace id')
  for (const e of live) {
    assert.equal(e.data.__traceId, ROOT_ID, `${e.status} row reuses the frozen id, NOT a recompose off the new prefix`)
  }
})

test('runOneItem: cancel sticks after controller.abort() even when underlying probe clears (daemon resets cancelTarget)', async () => {
  // Regression: the daemon flips state.cancelTarget back to null after the
  // first cancel signal lands; subsequent probes returned false even though
  // the controller's signal was still aborted. The Stepper's between-step
  // probe then mis-classified the AbortError as `failed` instead of
  // `cancelled`. The wrapper must OR in `controller.signal.aborted` so
  // once aborted, stays aborted.
  //
  // Two cancel-abort entry points exist (see run-one-item.ts comments):
  //   1. The wrapper's probe — observed isCancelRequested() === true → abort.
  //   2. The caller calling controller.abort() directly via onCancelController
  //      (daemon's cancel-command handler does this).
  // We exercise path 2 here: the handler triggers the abort mid-step
  // through the controller, then throws an AbortError. The probe returns
  // false the whole time (daemon already cleared cancelTarget). Without the
  // `|| controller.signal.aborted` fall-back the Stepper's post-step probe
  // returns false and the error is classified as failed, not cancelled.
  const dir = TMP()
  let observedController: AbortController | undefined
  const wf = defineWorkflow({
    name: 'cancel-sticky-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: false,
    handler: async (_ctx) => {
      await _ctx.step('searching', async () => {
        // Simulate daemon cancel path: abort the controller directly via
        // the reference captured by onCancelController.
        if (!observedController) throw new Error('controller not captured')
        observedController.abort(new Error('daemon cancel'))
        // Throw a Playwright-shaped AbortError as if a waitForSelector
        // call had been interrupted by the signal.
        const err = new Error('Action was interrupted')
        err.name = 'AbortError'
        throw err
      })
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  const result = await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-cancel-sticky',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Cancel Sticky Test 1',
    // Probe ALWAYS returns false — the daemon has already cleared
    // cancelTarget by the time the handler throws.
    isCancelRequested: () => false,
    onCancelController: (c) => { observedController = c },
  })

  assert.ok(observedController, 'controller exposed to caller')
  assert.equal(observedController!.signal.aborted, true, 'controller aborted by handler simulating daemon cancel')
  // The cancel must still classify as `cancelled` — not `failed` —
  // because the controller's signal is aborted. The wrapper's
  // `|| controller.signal.aborted` is what makes this true.
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'cancelled', 'cancel sticks via controller.signal.aborted even when probe returns false')
})

test('runOneItem: browser disconnect + target-closed error → cancelled, not failed', async () => {
  const dir = TMP()
  let browser: EventEmitter & { close: () => Promise<void> }
  const wf = defineWorkflow({
    name: 'disconnect-cancel-test',
    systems: [{ id: 'new-kronos', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: false,
    handler: async (ctx) => {
      await ctx.step('searching', async () => {
        throw new Error('Target page, context or browser has been closed')
      })
    },
  })

  browser = Object.assign(new EventEmitter(), { close: async () => {} })
  const fakePage = { close: async () => {}, isClosed: () => false } as unknown as import('playwright').Page
  const fakeContext = { close: async () => {}, newPage: async () => fakePage } as unknown as import('playwright').BrowserContext
  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map([
      ['new-kronos', { page: fakePage, browser: browser as unknown as import('playwright').Browser, context: fakeContext, chromiumPid: 1 }],
    ]),
    readyPromises: new Map([['new-kronos', Promise.resolve()]]),
  })
  session.onBrowserDisconnect(() => {})
  browser.emit('disconnected')

  const result = await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-disconnect-cancel',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Disconnect Cancel Test 1',
    isCancelRequested: () => false,
  })

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'cancelled')
  const entries = readTracker(dir, 'disconnect-cancel-test')
  const failed = entries.find((e: any) => e.status === 'failed')
  assert.equal(failed?.step, 'cancelled')
  assert.notEqual(failed?.error, 'Browser closed unexpectedly')
})

test('runOneItem: cancel requested during a Playwright failure records cancellation, not browser crash', async () => {
  const dir = TMP()
  let cancelRequested = false
  const wf = defineWorkflow({
    name: 'force-cancel-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['searching'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: false,
    handler: async (ctx) => {
      await ctx.step('searching', async () => {
        cancelRequested = true
        throw new Error('Browser closed unexpectedly')
      })
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  const result = await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-force-cancel',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Force Cancel Test 1',
    isCancelRequested: () => cancelRequested,
  })

  assert.deepEqual(result, {
    ok: false,
    kind: 'cancelled',
    error: "Cancelled by user before step 'cancelled'",
  })
  const entries = readTracker(dir, 'force-cancel-test')
  const failed = entries.find((e: any) => e.status === 'failed')
  assert.equal(failed?.step, 'cancelled')
  assert.equal(failed?.error, "Cancelled by user before step 'cancelled'")
})

// ISS-007 (e2e run 20260622): an oath-upload ticket killed by an UPSTREAM OCR
// discard threw a plain Error from inside `ctx.step("wait-approval")`, so the
// terminal row froze at `step=wait-approval` → red Failed (the controller is
// NOT aborted on a discard, so the kernel's cancel-step path never set the
// sentinel). A handler that throws a `CancelledError` carrying a cancel
// SENTINEL step (`discarded`/`cancelled`) must terminalize the row ON THAT
// SENTINEL — not on the in-flight `lastStep` — so `statusKeyForEntry`
// classifies it on the Cancel surface (orange) instead of Failed (red).
test('runOneItem: a handler-thrown CancelledError with a sentinel step terminalizes on that step (ISS-007)', async () => {
  const dir = TMP()
  const { CancelledError } = await import('../../../src/core/kernel/types.js')
  const wf = defineWorkflow({
    name: 'discard-sentinel-test',
    systems: [{ id: 'ucpath', login: async () => {} }],
    steps: ['wait-approval'] as const,
    schema: z.object({ n: z.string() }),
    authSteps: false,
    handler: async (ctx) => {
      await ctx.step('wait-approval', async () => {
        // Upstream discard — controller is NEVER aborted here.
        throw new CancelledError('discarded')
      })
    },
  })

  const session = Session.forTesting({
    systems: wf.config.systems,
    browsers: new Map(),
    readyPromises: new Map([['ucpath', Promise.resolve()]]),
  })

  const result = await runOneItem({
    wf,
    session,
    item: { n: 'x' },
    itemId: 'x',
    runId: 'run-discard-sentinel',
    trackerDir: dir,
    callerPreEmits: false,
    preAssignedInstance: 'Discard Sentinel Test 1',
    isCancelRequested: () => false,
  })

  assert.equal(result.ok, false)
  assert.equal(result.kind, 'cancelled', 'a CancelledError classifies as cancelled')
  const entries = readTracker(dir, 'discard-sentinel-test')
  const failed = entries.find((e: any) => e.status === 'failed')
  assert.equal(
    failed?.step,
    'discarded',
    'terminal row carries the discard sentinel (Cancel surface), not the in-flight wait-approval step',
  )
})
