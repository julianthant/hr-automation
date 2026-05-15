import type { RegisteredWorkflow } from './types.js'
import { CancelledError } from './types.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { makeCtx, tryScreenshot } from './ctx.js'
import { trackEvent, withTrackedWorkflow, emitScreenshotEvent } from '../../tracker/jsonl.js'
import { withLogContext } from '../../utils/log.js'
import { classifyError } from '../../utils/errors.js'
import { splitPrefilled, buildInitialTrackerData, buildTrackerOpts, toRecord } from './workflow.js'

export interface RunOneItemOpts<TData, TSteps extends readonly string[]> {
  wf: RegisteredWorkflow<TData, TSteps>
  session: Session
  item: TData
  itemId: string
  runId: string
  trackerStub?: boolean
  trackerDir?: string
  /** Caller already wrote the `pending` tracker row — skip the helper's pre-emit. */
  callerPreEmits: boolean
  /**
   * Optional hook to run inside the withTrackedWorkflow envelope, BEFORE the
   * handler. Used by sequential batch mode for between-items reset / health-
   * check; throws here surface as failed tracker entries the same way handler
   * throws do.
   */
  preHandler?: () => Promise<void>
  /**
   * Pool-/batch-assigned workflow instance name. Threaded into
   * `withTrackedWorkflow` via `preAssignedInstance` so a single batch runner
   * owns the workflow_start/end lifecycle for the entire batch.
   */
  preAssignedInstance?: string
  /**
   * Batch-level auth timings to inject as synthetic `running` tracker entries
   * at the recorded `startTs` timestamps BEFORE the handler runs. Each entry
   * produces one `step: "auth:<systemId>"` row with
   * `timestamp = new Date(startTs).toISOString()`, so `computeStepDurations`
   * tiles elapsed time correctly — the gap between each auth entry and the
   * next (auth or handler) step becomes that auth's duration.
   *
   * Paired with `preAssignedInstance` when called from `withBatchLifecycle`.
   */
  authTimings?: Array<{ systemId: string; startTs: number; endTs: number }>
  /**
   * Cooperative-cancel probe forwarded to the per-item `Stepper`. The daemon
   * passes `() => cancelTarget?.itemId === itemId && cancelTarget?.runId === runId`,
   * so a /cancel-current request that names this exact item triggers a
   * `CancelledError` at the next `ctx.step(...)` boundary. When omitted (CLI
   * direct mode, in-process tests), cancellation is never observed — preserves
   * legacy behavior verbatim.
   */
  isCancelRequested?: () => boolean
  /**
   * When set, every TrackerEntry emitted for this item carries `parentRunId`.
   * Forwarded from the queue item's `parentRunId` field by the daemon's claim
   * loop so delegation children link back to their OCR parent run.
   */
  parentRunId?: string
}

/**
 * Result shape of `runOneItem`. The optional `kind: 'cancelled'` discriminator
 * lets the daemon's claim loop branch into "reset every system to its
 * resetUrl before next claim" instead of treating the failure as a generic
 * handler throw.
 */
export type RunOneItemResult =
  | { ok: true }
  | { ok: false; error: string; kind?: 'cancelled' }

/**
 * Run one item through the kernel envelope: emit pending (unless caller
 * did), wrap in withLogContext + withTrackedWorkflow (unless trackerStub),
 * construct a per-item Stepper + Ctx, fire optional preHandler, then invoke
 * wf.config.handler. Returns `{ ok: true }` on success or `{ ok: false,
 * error }` on failure — caller owns result accounting and continues the
 * batch loop. Shared by `runWorkflowBatch` (sequential branch) and
 * `runWorkflowPool` so both paths produce identical tracker semantics.
 */
export async function runOneItem<TData, TSteps extends readonly string[]>(
  args: RunOneItemOpts<TData, TSteps>,
): Promise<RunOneItemResult> {
  const { wf, session, item, itemId, runId, trackerDir, callerPreEmits } = args
  // Strip the kernel-level prefilledData channel out of the input before it
  // reaches the handler. `cleaned` is what the handler sees; `prefilled`
  // gets merged into ctx.data via updateData(...) before invocation so the
  // handler's gating checks (`if (!ctx.data.foo) ...`) see the prefilled
  // values and skip extraction. The original `item` reference (still
  // including prefilledData) is preserved for the pending row's `input`
  // field — retry recovers the channel verbatim, so the next run is
  // idempotent without the dashboard remembering it had to re-attach the
  // channel.
  const { cleaned: cleanedItem, prefilled } = splitPrefilled(item)
  const handlerInput = cleanedItem as TData

  if (args.trackerStub) {
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId,
      runId,
      emitStep: () => {},
      emitData: () => {},
      emitFailed: () => {},
      emitSkipped: () => {},
      isCancelRequested: args.isCancelRequested,
    })
    const ctx = makeCtx<TSteps, TData>({
      session,
      stepper,
      isBatch: true,
      runId,
      workflow: wf.config.name,
      itemId,
      emitScreenshotEvent: () => {},
      trackerDir: args.trackerDir,
    })
    stepper.setScreenshotFn(ctx.screenshot)
    try {
      if (args.preHandler) await args.preHandler()
      if (prefilled) ctx.updateData(prefilled as Partial<TData & Record<string, unknown>>)
      try {
        await wf.config.handler(ctx, handlerInput)
      } catch (err) {
        // CancelledError: skip the diagnostic screenshot — the cancel
        // is intentional, no state worth capturing. Rethrow so the
        // outer catch surfaces the kind discriminator.
        if (err instanceof CancelledError) throw err
        // Capture state for any throw that escapes ctx.step. In-step throws
        // already get a screenshot via Stepper.step's catch, so in that
        // path we see two files — different labels (`step:<name>` vs
        // `handler-throw`) keep them distinguishable. Best-effort: a
        // screenshot failure must never mask the original error.
        await tryScreenshot(ctx, 'handler-throw')
        throw err
      }
      return { ok: true }
    } catch (err) {
      if (err instanceof CancelledError) {
        return { ok: false, kind: 'cancelled', error: err.message }
      }
      return { ok: false, error: classifyError(err) }
    }
  }

  // Real-tracker path: wrap each item in withLogContext + withTrackedWorkflow
  // so dashboard gets pending → running → done/failed rows per item, and logs
  // carry workflow/itemId/runId context. Emit the initial `pending` row here
  // (unless the caller opted into preEmitPending) so the dashboard shows the
  // row before the first step runs; withTrackedWorkflow skips its own pending
  // emit when preAssignedRunId is provided.
  const stringifiedSeed = buildInitialTrackerData(wf, handlerInput)
  // The full input (including any prefilledData channel) rides on the
  // pending row so retry / edit-and-resume can reconstruct the call.
  const inputForRow = toRecord(item)
  if (!callerPreEmits) {
    // Also compute __name / __id so the queue shows the friendly name from t=0.
    const nameFn = wf.config.getName
    const idFn = wf.config.getId
    const enriched = {
      ...stringifiedSeed,
      __name: nameFn ? nameFn(stringifiedSeed) : '',
      __id: idFn ? idFn(stringifiedSeed) : '',
    }
    trackEvent(
      {
        workflow: wf.config.name,
        timestamp: new Date().toISOString(),
        id: itemId,
        runId,
        status: 'pending',
        data: enriched,
        ...(inputForRow ? { input: inputForRow } : {}),
        ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
      },
      trackerDir,
    )
  }
  // Inject batch-level auth timings as synthetic `running` tracker entries
  // with the REAL per-system startTs. `computeStepDurations` reads the gap
  // between each `running` entry and the NEXT step-bearing entry to compute
  // the previous step's duration, so writing these in system-order at the
  // recorded timestamps tiles elapsed time exactly: pending → auth:<sys1>
  // (at sys1 start) → auth:<sys2> (at sys2 start) → first handler step →
  // ... → done. Emitted OUTSIDE withTrackedWorkflow so the entries share
  // `runId` but don't trigger the wrapper's internal step-change dedupe.
  if (args.authTimings && args.authTimings.length > 0) {
    for (const { systemId, startTs } of args.authTimings) {
      trackEvent(
        {
          workflow: wf.config.name,
          timestamp: new Date(startTs).toISOString(),
          id: itemId,
          runId,
          status: 'running',
          step: `auth:${systemId}`,
          data: stringifiedSeed,
        },
        trackerDir,
      )
    }
  }
  try {
    await withLogContext(wf.config.name, itemId, async () => {
      await withTrackedWorkflow(
        wf.config.name,
        itemId,
        async (setStep, updateData, _onCleanup, _sessionCtx, emitFailed, _trackerRunId, emitSkipped) => {
          const stepper = new Stepper({
            workflow: wf.config.name,
            itemId,
            runId,
            emitStep: setStep,
            emitData: updateData,
            emitFailed,
            emitSkipped,
            isCancelRequested: args.isCancelRequested,
          })
          const ctx = makeCtx<TSteps, TData>({
            session,
            stepper,
            isBatch: true,
            runId,
            workflow: wf.config.name,
            itemId,
            emitScreenshotEvent: (ev) => emitScreenshotEvent(ev, { dir: trackerDir }),
            trackerDir,
          })
          stepper.setScreenshotFn(ctx.screenshot)
          if (args.preHandler) {
            try {
              await args.preHandler()
            } catch (err) {
              if (args.isCancelRequested?.()) {
                setStep('cancelled')
                throw new CancelledError('force-stop')
              }
              throw err
            }
          }
          if (prefilled) ctx.updateData(prefilled as Partial<TData & Record<string, unknown>>)
          try {
            await wf.config.handler(ctx, handlerInput)
          } catch (err) {
            // CancelledError: no diagnostic screenshot — the cancel was
            // intentional and the page state is already being reset by
            // the daemon's claim loop. Rethrow so the outer catch in
            // runOneItem surfaces the kind discriminator.
            if (err instanceof CancelledError) throw err
            if (args.isCancelRequested?.()) {
              setStep('cancelled')
              throw new CancelledError('force-stop')
            }
            // Covers throws that escape ctx.step (e.g. separations'
            // resolveJobSummaryResult unwrap or the post-step
            // submittedWithoutTxnNumber guard). Stepper.step already
            // screenshots in-step throws; same label convention applies.
            await tryScreenshot(ctx, 'handler-throw')
            throw err
          }
        },
        {
          ...buildTrackerOpts(wf),
          preAssignedRunId: runId,
          preAssignedInstance: args.preAssignedInstance,
          dir: trackerDir,
          initialData: Object.keys(stringifiedSeed).length > 0 ? stringifiedSeed : undefined,
          // `input` only matters when this branch owns the pending emit
          // (callerPreEmits=false above). When the caller pre-emitted, the
          // input is already on that row — no need to re-stamp.
          ...(callerPreEmits ? {} : (inputForRow ? { input: inputForRow } : {})),
          ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
        },
      )
    }, trackerDir)
    return { ok: true }
  } catch (err) {
    if (err instanceof CancelledError) {
      return { ok: false, kind: 'cancelled', error: err.message }
    }
    return { ok: false, error: classifyError(err) }
  }
}
