import type { RegisteredWorkflow } from './types.js'
import { CancelledError } from './types.js'
import { errorMessage } from '../../utils/errors.js'
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
  /** Parent run id when this run is a delegation; surfaced as `ctx.parentRunId`. */
  parentRunId?: string
  /**
   * Inherited ROOT trace PREFIX (`<code>-<HHMMSS>`) for trace-id propagation
   * (trace/span model) — when this run was spawned by a delegation carrying a
   * `rootTracePrefix`, it's forwarded into `makeCtx` so this run's own
   * delegations pass the SAME prefix down to grandchildren (transitivity), each
   * composing its own tail. Absent for a physical root run, which derives the
   * prefix from its own frozen id.
   */
  rootTracePrefix?: string
  itemId: string
  trackerDir?: string
  emitScreenshotEvent: (event: ScreenshotEvent) => void
  preHandler?: () => Promise<void>
  onPreHandlerError?: (err: unknown) => void
  mapEscapedHandlerError?: (err: unknown) => unknown
  skipCancelledScreenshot?: boolean
  /** Per-run AbortSignal — surfaced as `ctx.signal` and auto-injected
   *  into Playwright calls via the Page proxy. */
  signal: AbortSignal
  /** Session-drawer instance name owning this run; surfaced as
   *  `ctx.workflowInstance` and used by `ctx.reportPhase`. */
  instance?: string
}

export async function runWorkflowHandler<TData, TSteps extends readonly string[]>(
  opts: RunWorkflowHandlerOpts<TData, TSteps>,
): Promise<void> {
  const ctx = makeCtx<TSteps, TData>({
    session: opts.session,
    stepper: opts.stepper,
    isBatch: opts.isBatch,
    runId: opts.runId,
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(opts.rootTracePrefix ? { rootTracePrefix: opts.rootTracePrefix } : {}),
    workflow: opts.wf.config.name,
    code: opts.wf.code,
    itemId: opts.itemId,
    emitScreenshotEvent: opts.emitScreenshotEvent,
    trackerDir: opts.trackerDir,
    signal: opts.signal,
    instance: opts.instance,
  })
  opts.stepper.setScreenshotFn(ctx.screenshot)
  // Enable end-of-step audit screenshots: the stepper reads the session's
  // page-access counter at each step boundary to capture the one system the
  // step touched. Single wiring site — covers both run-one-item and run-workflow.
  opts.stepper.setPageAccess(() => opts.session.pageAccess())

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
    if (mapped) throw mapped instanceof Error ? mapped : new Error(errorMessage(mapped))
    await tryScreenshot(ctx, 'handler-throw')
    throw err
  }
}
