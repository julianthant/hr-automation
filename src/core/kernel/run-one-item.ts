import type { RegisteredWorkflow } from './types.js'
import { CancelledError } from './types.js'
import { buildPendingTrackerData } from '../pending-data.js'
import { deriveRowArchetype, resolveArchetype } from '../../domain/row-archetype.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { emitTrackerRow, withTrackedWorkflow, emitScreenshotEvent } from '../../tracker/jsonl.js'
import { withLogContext } from '../../utils/log.js'
import { classifyError } from '../../utils/errors.js'
import { splitPrefilled, buildInitialTrackerData, buildTrackerOpts, toRecord } from './workflow.js'
import { runWorkflowHandler } from './handler-runner.js'
import { log } from '../../utils/log.js'

export interface RunOneItemOpts<TData, TSteps extends readonly string[]> {
  wf: RegisteredWorkflow<TData, TSteps>
  session: Session
  /**
   * Raw queued input. It may include kernel-only channels such as
   * `prefilledData` or `__runtimeOptions`; `runOneItem` strips those channels
   * and validates the cleaned value before invoking the typed handler.
   */
  item: unknown
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
   *
   * Contract 5: `runOneItem` ALSO constructs a per-run `AbortController`. The
   * controller's `signal` is forwarded into `ctx.signal` (and via the Page
   * proxy, into every Playwright call that accepts an `AbortSignal`), so the
   * caller's `isCancelRequested` probe and `controller.abort()` are the two
   * views of the same "operator wants cancel" state. `runOneItem` aborts the
   * controller as soon as `isCancelRequested()` reports true — see
   * `onCancelController` for the callback the caller uses to wire its own
   * cancel side-channel directly into `controller.abort()` (the daemon does
   * this so a cancel command aborts in-flight Playwright work without waiting
   * for the next step boundary).
   */
  isCancelRequested?: () => boolean
  /**
   * Invoked once with the per-run `AbortController` immediately after it's
   * constructed. The caller (daemon claim loop, scenario runtime, etc.) can
   * stash the controller and call `.abort()` directly when its own cancel
   * signal fires — this is what makes Contract 5's cancel "fast": the abort
   * propagates into the in-flight Playwright call via the signal injected by
   * `ctx.page(id)`'s proxy, rather than waiting for `Stepper.step`'s next
   * boundary check.
   */
  onCancelController?: (controller: AbortController) => void
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
  // Strip the kernel-level prefilledData + __runtimeOptions channels out of
  // the input before it reaches the handler. `cleaned` is what the handler
  // sees. `prefilled` gets merged into ctx.data via updateData(...) before
  // invocation so the handler's gating checks (`if (!ctx.data.foo) ...`) see
  // the prefilled values and skip extraction. `runtimeOptions.skipSteps`
  // surfaces on the handler as `ctx.shouldSkipStep(name)` for the dashboard's
  // step-preset gear. The original `item` reference (still including both
  // channels) is preserved for the pending row's `input` field — retry
  // recovers them verbatim, so the next run is idempotent without the
  // dashboard remembering it had to re-attach the channels.
  const { cleaned: cleanedItem, prefilled, runtimeOptions } = splitPrefilled(item)
  // Validate skipSteps against the workflow's declared steps so a stale or
  // hand-crafted runtime option can't silently no-op (e.g. typo'd step name).
  // Auth steps are excluded — they're always required.
  const skipStepsSet: Set<string> | undefined = (() => {
    const requested = runtimeOptions?.skipSteps
    if (!requested || requested.length === 0) return undefined
    const declared = new Set<string>(wf.config.steps)
    const unknown = requested.filter((s) => !declared.has(s))
    if (unknown.length > 0) {
      throw new Error(
        `runtimeOptions.skipSteps contains unknown step name(s) for workflow '${wf.config.name}': ${unknown.join(', ')}`,
      )
    }
    return new Set(requested)
  })()

  // Validate the cleaned item against the workflow schema BEFORE handing it to
  // the handler. Catches stale task_store rows whose shape predates a schema
  // change, externally-mutated rows, and wrong-shape rows from older code
  // versions. Use the PARSED return value so any .transform() / .default() /
  // .coerce() declared in the schema is applied. The kernel classifies errors
  // via /validation/i (see workflow.ts), so keep the literal "validation error"
  // prefix lowercase.
  let handlerInput: TData
  try {
    handlerInput = wf.config.schema.parse(cleanedItem) as TData
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `validation error in runOneItem (workflow=${wf.config.name}, itemId=${itemId}, runId=${runId}): ${msg}`,
      { cause: err },
    )
  }

  // Per-run AbortController (Contract 5). The controller's signal is
  // surfaced as `ctx.signal` and auto-injected into Playwright methods via
  // the `ctx.page(id)` proxy. Aborts come from two places:
  //   1. The caller's `isCancelRequested` probe flipping true — the stepper
  //      observes this between steps; we also poll it here to keep the
  //      controller in lockstep so any Playwright call already in flight
  //      rejects within ms instead of waiting on its declared timeout.
  //   2. The caller calling `.abort()` directly via the `onCancelController`
  //      callback (daemon's cancel-command handler does this).
  const controller = new AbortController()
  args.onCancelController?.(controller)
  // Eagerly mirror caller's probe → controller. The stepper itself also
  // polls `isCancelRequested` between steps as the synchronous checkpoint
  // (no Playwright in flight to interrupt), so this side-channel only
  // matters while a Playwright call is awaiting.
  const isCancelRequestedWithAbort = args.isCancelRequested
    ? (): boolean => {
        const v = args.isCancelRequested!()
        if (v && !controller.signal.aborted) {
          controller.abort(new Error('cancel requested'))
        }
        // Once aborted, stay aborted. The daemon may clear `state.cancelTarget`
        // back to null after the first cancel signal lands (per-run cancel
        // commands flip cancelTarget transiently), so a subsequent probe on
        // the underlying `args.isCancelRequested()` returns false even though
        // the controller's signal is still aborted. Without this fall-back,
        // the Stepper's between-step probe stops recognizing the cancel and
        // the AbortError escapes mapEscapedHandlerError as `failed` instead
        // of `cancelled`.
        return v || controller.signal.aborted
      }
    : undefined

  const runInner = async (emitters: {
    setStep: (step: string) => void
    updateData: (data: Record<string, unknown>) => void
    emitFailed: (step: string, error: string) => void
    emitSkipped: (step: string) => void
    emitScreenshotEvent: Parameters<typeof runWorkflowHandler<TData, TSteps>>[0]['emitScreenshotEvent']
    markCancelledStepOnCancelRequested?: boolean
  }): Promise<void> => {
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId,
      runId,
      emitStep: emitters.setStep,
      emitData: emitters.updateData,
      emitFailed: emitters.emitFailed,
      emitSkipped: emitters.emitSkipped,
      isCancelRequested: isCancelRequestedWithAbort,
      ...(skipStepsSet ? { skipSteps: skipStepsSet } : {}),
    })
    await runWorkflowHandler({
      wf,
      session,
      stepper,
      isBatch: true,
      runId,
      itemId,
      handlerInput,
      prefilled,
      trackerDir: args.trackerDir,
      emitScreenshotEvent: emitters.emitScreenshotEvent,
      preHandler: args.preHandler,
      skipCancelledScreenshot: true,
      signal: controller.signal,
      onPreHandlerError: (err) => {
        if (emitters.markCancelledStepOnCancelRequested && isCancelRequestedWithAbort?.()) {
          emitters.setStep('cancelled')
          throw new CancelledError('cancelled')
        }
        throw err
      },
      mapEscapedHandlerError: () => {
        if (!emitters.markCancelledStepOnCancelRequested || !isCancelRequestedWithAbort?.()) return undefined
        emitters.setStep('cancelled')
        return new CancelledError('cancelled')
      },
    })
  }

  if (args.trackerStub) {
    try {
      await runInner({
        setStep: () => {},
        updateData: () => {},
        emitFailed: () => {},
        emitSkipped: () => {},
        emitScreenshotEvent: () => {},
      })
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
  const rowArchetype = deriveRowArchetype(
    resolveArchetype(wf.config, handlerInput),
    args.parentRunId,
    runtimeOptions?.rowShape === 'batch-member' ? { member: true } : undefined,
  )
  // Stamp the run-mode preset id on the seed so it's visible from the very
  // first tracker row (pending). The dashboard reads `data.__preset` to render
  // a small chip next to the row; absent on the implicit "Full" preset.
  if (runtimeOptions?.preset) {
    stringifiedSeed.__preset = runtimeOptions.preset
  }
  // One-shot log so the operator sees the active preset in the log stream
  // without having to inspect data.
  if (runtimeOptions && (runtimeOptions.preset || skipStepsSet)) {
    const presetLabel = runtimeOptions.preset ?? '(custom)'
    const skipList = skipStepsSet ? Array.from(skipStepsSet).join(', ') : '(none)'
    log.step(`Run mode: ${presetLabel} — skipping ${skipList}`)
  }
  // The full input (including any prefilledData channel) rides on the
  // pending row so retry / edit-and-resume can reconstruct the call.
  const inputForRow = toRecord(item)
  if (!callerPreEmits) {
    const enriched = buildPendingTrackerData({
      workflow: wf,
      input: handlerInput,
      useInitialTrackerSeed: true,
      precomputedSeed: stringifiedSeed,
      nameIdStamp: 'always-on-seed',
      parentRunId: args.parentRunId,
      rowArchetype,
      runId,
      // Provenance prefix for the trace id — the delegating parent's code,
      // carried through `__runtimeOptions` so it survives the task store to
      // this worker re-emit. Falls back to the workflow's own code.
      ...(runtimeOptions?.rootCode ? { rootCode: runtimeOptions.rootCode } : {}),
    })
    emitTrackerRow(
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
      emitTrackerRow(
        {
          workflow: wf.config.name,
          timestamp: new Date(startTs).toISOString(),
          id: itemId,
          runId,
          status: 'running',
          step: `auth:${systemId}`,
          data: { ...stringifiedSeed, archetype: rowArchetype },
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
          await runInner({
            setStep,
            updateData,
            emitFailed,
            emitSkipped,
            emitScreenshotEvent: (ev) => emitScreenshotEvent(ev, { dir: trackerDir }),
            markCancelledStepOnCancelRequested: true,
          })
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
          archetype: rowArchetype,
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
