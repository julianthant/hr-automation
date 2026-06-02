import type { Page } from 'playwright'
import type { Ctx, RetryOpts } from './types.js'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Session } from './session.js'
import type { Stepper } from './stepper.js'
import { log } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { makeScreenshotFn } from './screenshot.js'
import type { ScreenshotEvent } from './screenshot.js'
import { wrapPageWithSignal } from './page-proxy.js'
import { buildDelegateApi } from '../delegate.js'
import { emitItemStart, emitStepChange } from '../../tracker/session-events.js'

export interface MakeCtxOpts {
  session: Session
  stepper: Stepper
  isBatch: boolean
  runId: string
  workflow: string
  /** Parent workflow's 2-char code — forwarded to delegated children as the trace-id provenance prefix. */
  code?: string
  itemId: string
  /**
   * Delegated scope — the parent run's id when this run was spawned via
   * `delegateTo`/`delegateToAll`. The kernel already stamps it on the rows it
   * emits; it's surfaced on `ctx` so handlers that own their OWN tracker
   * emission (today: OCR) can re-stamp it on every self-emitted row and stay a
   * recognizable delegated row under the dashboard's latest-wins dedupe.
   */
  parentRunId?: string
  emitScreenshotEvent: (event: ScreenshotEvent) => void
  trackerDir?: string
  /**
   * Per-run AbortSignal. Sourced from the kernel's per-item
   * `AbortController` (see `run-one-item.ts`). Wired into `ctx.signal` for
   * handler-level use and into the `ctx.page(id)` proxy so every Playwright
   * call that accepts a `signal` option auto-injects this one.
   */
  signal: AbortSignal
  /**
   * Session-drawer instance name owning this run (e.g. "OCR 1"). Surfaced on
   * `ctx.workflowInstance` and used by `ctx.reportPhase` to drive the session
   * timeline. Absent in trackerStub/test runs.
   */
  instance?: string
}

/**
 * Linear-backoff retry primitive. Attempt N waits `backoffMs * (N-1)` before
 * retrying, so defaults (attempts=3, backoffMs=1000) yield waits of 0, 1s, 2s
 * before the three tries. Callers that want instant retries pass `backoffMs: 0`.
 * On exhaustion, the last error thrown by `fn` is rethrown verbatim so callers
 * can inspect the underlying cause.
 */
async function retry<R>(fn: () => Promise<R>, opts: RetryOpts = {}): Promise<R> {
  const attempts = opts.attempts ?? 3
  const backoffMs = opts.backoffMs ?? 1000
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      opts.onAttempt?.(i, err)
      if (i < attempts && backoffMs > 0) {
        await sleep(backoffMs * i)
      }
    }
  }
  throw lastErr
}

export async function tryScreenshot(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  label: string,
): Promise<void> {
  try {
    await ctx.screenshot({ kind: 'error', label })
  } catch {
    /* best-effort */
  }
}

/**
 * Construct a handler Ctx from a Session + Stepper. Shared by runWorkflow,
 * runWorkflowBatch, and runWorkflowPool so all three modes have identical
 * Ctx surface and stubs.
 */
export function makeCtx<TSteps extends readonly string[], TData>(
  opts: MakeCtxOpts,
): Ctx<TSteps, TData> {
  const { session, stepper, isBatch, runId, workflow, code, itemId, parentRunId, emitScreenshotEvent, trackerDir, signal, instance } = opts

  session.setUcpathIdleGuard(() => stepper.isInsideStep())

  // Session-timeline bridge for handlers that own their own queue-row emission
  // and so never call ctx.step (today: OCR). Emits session item_start (once)
  // + step_change so the terminal-drawer WorkflowBox advances. No queue row is
  // written here — that stays the handler's responsibility. No-op without an
  // instance (trackerStub/test runs).
  let phaseItemStarted = false
  let lastReportedPhase: string | null = null
  const reportPhase = (step: string): void => {
    if (!instance) return
    if (!phaseItemStarted) {
      emitItemStart(instance, itemId, trackerDir)
      phaseItemStarted = true
    }
    if (step !== lastReportedPhase) {
      emitStepChange(instance, step, trackerDir, workflow)
      lastReportedPhase = step
    }
  }

  const screenshot = makeScreenshotFn({
    session,
    runId,
    workflow,
    itemId,
    emit: emitScreenshotEvent,
    currentStep: () => stepper.getCurrentStep(),
  })

  const delegateApi = buildDelegateApi({ runId, trackerDir, signal, ...(code ? { code } : {}) })

  // `ctx.page(id)` returns a Playwright Page wrapped in the kernel's
  // signal-injecting Proxy (see `page-proxy.ts`). The wrapper merges
  // `ctx.signal` into the options object of every Playwright method that
  // accepts a `signal?: AbortSignal`, and returns proxied Locators / sub-
  // objects (`keyboard`, `mouse`, `frame`, `mainFrame`) so chained calls
  // stay signal-aware too. Sync getters (`url`, `title`, `context`, etc.)
  // pass through verbatim.
  const page = async (id: string): Promise<Page> => {
    const raw = await session.page(id)
    return wrapPageWithSignal(raw, signal)
  }

  const ctx = {
    page,
    step: <R>(name: string, fn: () => Promise<R>) => stepper.step(name, fn),
    markStep: (name: string) => stepper.markStep(name),
    skipStep: (name: string) => stepper.skipStep(name),
    shouldSkipStep: (name: string) => stepper.shouldSkipStep(name),
    parallel: <T extends Record<string, () => Promise<unknown>>>(tasks: T) => stepper.parallel(tasks),
    parallelAll: <T extends Record<string, () => Promise<unknown>>>(tasks: T) => stepper.parallelAll(tasks),
    retry,
    updateData: (patch: Record<string, unknown>) => stepper.updateData(patch),
    session: {
      page,
    },
    log,
    isBatch,
    runId,
    parentRunId,
    signal,
    screenshot,
    trackerDir,
    workflowInstance: instance,
    reportPhase,
    delegateTo: delegateApi.delegateTo,
    delegateToAll: delegateApi.delegateToAll,
  }
  Object.assign(ctx, {
    captureAndStampScreenshot: async (label: string, dataKey: string) => {
      try {
        const cap = await ctx.screenshot({ kind: 'form', label })
        const filename = cap.files?.[0]?.path.split('/').pop()
        if (filename) stepper.updateData({ [dataKey]: filename })
      } catch (err) {
        log.warn(`Screenshot capture failed for ${label}: ${errorMessage(err)}`)
      }
    },
  })
  // `data` is a live getter — each access returns a fresh shallow copy of
  // the stepper's accumulated data, including anything pre-merged from the
  // input's `prefilledData` channel before the handler started.
  Object.defineProperty(ctx, 'data', {
    get: () => stepper.getData(),
    enumerable: true,
  })
  return ctx as unknown as Ctx<TSteps, TData>
}
