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

  return {
    page: (id) => session.page(id),
    step: (name, fn) => stepper.step(name as string, fn),
    markStep: (name) => stepper.markStep(name as string),
    parallel: (tasks) => stepper.parallel(tasks),
    parallelAll: (tasks) => stepper.parallelAll(tasks),
    retry,
    updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
    session: {
      page: (id) => session.page(id),
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
}
