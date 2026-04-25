import type { Ctx, RetryOpts } from './types.js'
import type { Session } from './session.js'
import type { Stepper } from './stepper.js'
import { log } from '../utils/log.js'
import { makeScreenshotFn } from './screenshot.js'
import type { ScreenshotEvent } from './screenshot.js'

export interface MakeCtxOpts {
  session: Session
  stepper: Stepper
  isBatch: boolean
  runId: string
  workflow: string
  itemId: string
  emitScreenshotEvent: (event: ScreenshotEvent) => void
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
        await new Promise((resolve) => setTimeout(resolve, backoffMs * i))
      }
    }
  }
  throw lastErr
}

/**
 * Construct a handler Ctx from a Session + Stepper. Shared by runWorkflow,
 * runWorkflowBatch, and runWorkflowPool so all three modes have identical
 * Ctx surface and stubs.
 */
export function makeCtx<TSteps extends readonly string[], TData>(
  opts: MakeCtxOpts,
): Ctx<TSteps, TData> {
  const { session, stepper, isBatch, runId, workflow, itemId, emitScreenshotEvent } = opts

  const screenshot = makeScreenshotFn({
    session,
    runId,
    workflow,
    itemId,
    emit: emitScreenshotEvent,
    currentStep: () => stepper.getCurrentStep(),
  })

  const ctx = {
    page: (id: string) => session.page(id),
    step: <R>(name: string, fn: () => Promise<R>) => stepper.step(name, fn),
    markStep: (name: string) => stepper.markStep(name),
    skipStep: (name: string) => stepper.skipStep(name),
    parallel: <T extends Record<string, () => Promise<unknown>>>(tasks: T) => stepper.parallel(tasks),
    parallelAll: <T extends Record<string, () => Promise<unknown>>>(tasks: T) => stepper.parallelAll(tasks),
    retry,
    updateData: (patch: Record<string, unknown>) => stepper.updateData(patch),
    session: {
      page: (id: string) => session.page(id),
      newWindow: async () => {
        throw new Error('newWindow not yet implemented')
      },
      closeWindow: async () => {
        throw new Error('closeWindow not yet implemented')
      },
    },
    log,
    isBatch,
    runId,
    screenshot,
  }
  // `data` is a live getter — each access returns a fresh shallow copy of
  // the stepper's accumulated data, including anything pre-merged from the
  // input's `prefilledData` channel before the handler started.
  Object.defineProperty(ctx, 'data', {
    get: () => stepper.getData(),
    enumerable: true,
  })
  return ctx as unknown as Ctx<TSteps, TData>
}
