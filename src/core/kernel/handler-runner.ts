import type { RegisteredWorkflow } from './types.js'
import { CancelledError } from './types.js'
import type { Session } from './session.js'
import type { Stepper } from './stepper.js'
import { makeCtx, tryScreenshot } from './ctx.js'
import type { ScreenshotEvent } from './screenshot.js'

export interface RunWorkflowHandlerOpts<TData, TSteps extends readonly string[]> {
  wf: RegisteredWorkflow<TData, TSteps>
  session: Session
  stepper: Stepper
  handlerInput: TData
  prefilled: Record<string, unknown> | null
  isBatch: boolean
  runId: string
  itemId: string
  trackerDir?: string
  emitScreenshotEvent: (event: ScreenshotEvent) => void
  preHandler?: () => Promise<void>
  onPreHandlerError?: (err: unknown) => void
  mapEscapedHandlerError?: (err: unknown) => unknown | void
  skipCancelledScreenshot?: boolean
  /** Per-run AbortSignal — surfaced as `ctx.signal` and auto-injected
   *  into Playwright calls via the Page proxy. */
  signal: AbortSignal
}

export async function runWorkflowHandler<TData, TSteps extends readonly string[]>(
  opts: RunWorkflowHandlerOpts<TData, TSteps>,
): Promise<void> {
  const ctx = makeCtx<TSteps, TData>({
    session: opts.session,
    stepper: opts.stepper,
    isBatch: opts.isBatch,
    runId: opts.runId,
    workflow: opts.wf.config.name,
    code: opts.wf.code,
    itemId: opts.itemId,
    emitScreenshotEvent: opts.emitScreenshotEvent,
    trackerDir: opts.trackerDir,
    signal: opts.signal,
  })
  opts.stepper.setScreenshotFn(ctx.screenshot)

  if (opts.preHandler) {
    try {
      await opts.preHandler()
    } catch (err) {
      opts.onPreHandlerError?.(err)
      throw err
    }
  }
  if (opts.prefilled) ctx.updateData(opts.prefilled as Partial<TData & Record<string, unknown>>)
  try {
    await opts.wf.config.handler(ctx, opts.handlerInput)
  } catch (err) {
    if (opts.skipCancelledScreenshot && err instanceof CancelledError) throw err
    const mapped = opts.mapEscapedHandlerError?.(err)
    if (mapped) throw mapped
    await tryScreenshot(ctx, 'handler-throw')
    throw err
  }
}
