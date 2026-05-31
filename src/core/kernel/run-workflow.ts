import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, RunOpts, ScreenshotFn } from './types.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { withTrackedWorkflow, emitScreenshotEvent } from '../../tracker/jsonl.js'
import { makeScreenshotFn } from './screenshot.js'
import { withLogContext } from '../../utils/log.js'
import { runRegistry, type RunHandle } from '../run-registry.js'
import { deriveRowArchetype, resolveArchetype } from '../../domain/row-archetype.js'
import { runWorkflowHandler } from './handler-runner.js'
import {
  splitPrefilled,
  buildInitialTrackerData,
  buildTrackerOpts,
  toRecord,
  deriveItemId,
} from './workflow-tracker-data.js'
import { buildSessionObserver } from './session-observer.js'
import {
  registerInProcessControl,
  registerInProcessBrowsers,
  markInProcessControlTerminal,
} from '../daemon/in-process-control.js'

export async function runWorkflow<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  data: TData,
  opts: RunOpts = {},
): Promise<void> {
  // Strip the kernel-level prefilledData channel out before anything else.
  // The schema validates the cleaned input (so workflow schemas don't need
  // to declare the channel), and `prefilled` is pre-merged into ctx.data so
  // handler-side `if (!ctx.data.foo) await ctx.step("extraction", ...)`
  // gates kick in. The full `data` (with channel) rides on the pending row
  // for retry.
  const { cleaned: cleanedData, prefilled, runtimeOptions } = splitPrefilled(data)
  const inputForRow = toRecord(data)

  // 1. Validate data AND use the parsed value so Zod .transform/.default/
  // .coerce semantics actually take effect downstream. Previously this called
  // schema.parse() and discarded the return value, silently dropping any
  // transforms or defaults declared in workflow schemas. The cast to TData is
  // required because Zod's parse signature returns the schema's output type,
  // which TypeScript can't statically prove matches the declared TData.
  let handlerInput: TData
  try {
    handlerInput = wf.config.schema.parse(cleanedData) as TData
  } catch (err) {
    throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }

  // 2. Derive itemId from workflow-specific/common id fields, fall back to UUID.
  const itemId = opts.itemId ?? wf.config.deriveItemId?.(handlerInput) ?? deriveItemId(handlerInput, randomUUID())

  const run = async (
    setStep: (s: string) => void,
    updateData: (d: Record<string, unknown>) => void,
    /**
     * Install a kernel-owned SIGINT handler. Only passed `true` in the
     * `trackerStub` branch — in real runs, `withTrackedWorkflow` owns SIGINT
     * and a second handler here would just duplicate cleanup.
     */
    installSigint: boolean,
    /**
     * Observer that bridges Session.launch lifecycle hooks into the tracker.
     * Undefined in the trackerStub branch (nothing to bridge to).
     */
    observer?: import('./types.js').SessionObserver,
    /**
     * Called from Session.launch's onReady hook (synchronously after Session
     * construction, before any browser launches). Gives the caller the live
     * Session reference + pre-built Stepper so it can swap a real ScreenshotFn
     * into a mutable holder before auth fires.
     */
    onSessionReady?: (session: Session, runId: string, stepper: Stepper, trackerDir: string | undefined) => void,
    /**
     * Pass the tracker's runId in from the real-run branch so the Stepper,
     * screenshot emitter, and tracker JSONL all share one id. When absent
     * (trackerStub / preAssignedRunId path), falls back to the legacy
     * generator — either a UUID from opts, or a fresh UUID.
     */
    forcedRunId?: string,
    /**
     * Routes Stepper's `skipStep` through the tracker. Wired by the
     * real-run branch from withTrackedWorkflow's body callback; the
     * trackerStub branch passes a no-op.
     */
    emitSkipped: (step: string) => void = () => {},
  ): Promise<void> => {
    const runId = forcedRunId ?? opts.preAssignedRunId ?? randomUUID()
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId: String(itemId),
      runId,
      emitStep: setStep,
      // Tracker's updateData now accepts unknown; it stringifies at the write boundary.
      emitData: updateData,
      emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
      emitSkipped,
    })

    // Per-run AbortController (Contract 5). Constructed BEFORE
    // `Session.launch` so the run can be registered with `runRegistry`
    // ahead of any browser launch — the dashboard's HTTP cancel route
    // resolves a stuck-on-Duo in-process run by `runRegistry.cancel(runId)`
    // which aborts this controller; the watchdog falls back to
    // `killChromeHard` when there is no in-flight Playwright call to
    // observe the abort.
    //
    // When `parentSignal` is supplied (in-process delegation — see
    // `delegate.ts`'s `runInProcessAndCollectResult`), attach a one-shot
    // listener so this child's controller aborts when the parent's does.
    // Without this hook, in-process delegated children (OCR,
    // sharepoint-download) keep running after the parent is cancelled
    // because the daemon's `cancel_task` machinery only reaches the
    // top-level run controller, not nested in-process ones.
    const controller = new AbortController()
    let detachParentListener: (() => void) | null = null
    if (opts.parentSignal) {
      if (opts.parentSignal.aborted) {
        // Parent already cancelled before we wired up — abort immediately.
        controller.abort(opts.parentSignal.reason ?? new Error('parent cancelled'))
      } else {
        const onParentAbort = (): void => {
          if (!controller.signal.aborted) {
            controller.abort(opts.parentSignal!.reason ?? new Error('parent cancelled'))
          }
        }
        opts.parentSignal.addEventListener('abort', onParentAbort, { once: true })
        detachParentListener = () => {
          opts.parentSignal!.removeEventListener('abort', onParentAbort)
        }
      }
    }

    // Register an in-process control row in SQLite (best-effort) before
    // Session.launch so the unified `RunHandle.control` carries the audit
    // identifiers — `runRegistry.cancel` writes the cancel_task + kill_browser
    // worker_commands when control is present, mirroring the legacy
    // `markSqliteInProcessCancel` behavior.
    const inProcessControl = opts.trackerStub
      ? null
      : registerInProcessControl(wf, handlerInput, String(itemId), runId, opts.trackerDir)
    let registryRegistered = false
    let completed = false
    let terminalWritten = false
    try {
      const session = await Session.launch(wf.config.systems, {
        launchFn: opts.launchFn,
        observer,
        onReady: (sess) => {
          // Register with the unified RunRegistry as early as possible —
          // `onReady` fires synchronously after Session construction and
          // before any browser launches, so the dashboard's
          // `/api/cancel-running` endpoint can find this run and abort it
          // even while it's stuck on Duo. The watchdog inside
          // `runRegistry.cancel` falls back to `killChromeHard` when the
          // abort signal has no observer (pre-handler launch hang).
          const handle: RunHandle = {
            runId,
            itemId: String(itemId),
            workflow: wf.config.name,
            controller,
            session: sess,
            startedAt: Date.now(),
            source: 'in-process',
            ...(inProcessControl ? { control: inProcessControl } : {}),
          }
          runRegistry.register(handle)
          registryRegistered = true
          onSessionReady?.(sess, runId, stepper, opts.trackerDir)
        },
      })
      registerInProcessBrowsers(wf, session, inProcessControl)

      let sigintHandler: (() => void) | null = null
      if (installSigint) {
        sigintHandler = () => {
          try {
            const step = stepper.getCurrentStep() ?? 'sigint'
            setStep(`${step}:failed:interrupted`)
          } catch { /* best-effort */ }
          // Fire-and-forget kill — we're exiting regardless.
          session.killChrome().catch(() => {})
          process.exit(1)
        }
        process.on('SIGINT', sigintHandler)
      }

      try {
        await runWorkflowHandler({
          wf,
          session,
          stepper,
          handlerInput,
          prefilled,
          isBatch: false,
          runId,
          itemId: String(itemId),
          trackerDir: opts.trackerDir,
          emitScreenshotEvent: (ev) => emitScreenshotEvent(ev, { dir: opts.trackerDir }),
          signal: controller.signal,
        })
        completed = true
      } finally {
        if (sigintHandler) process.off('SIGINT', sigintHandler)
        if (detachParentListener) detachParentListener()
        await session.close()
      }
    } catch (err) {
      markInProcessControlTerminal(inProcessControl, false, err)
      terminalWritten = true
      throw err
    } finally {
      if (completed && !terminalWritten) markInProcessControlTerminal(inProcessControl, true)
      if (registryRegistered) runRegistry.unregister(runId)
      inProcessControl?.controlDb.close()
    }
  }

  if (opts.trackerStub) {
    // trackerStub mode is test-only injection: withTrackedWorkflow isn't
    // running, so the kernel must own SIGINT here. No observer — there's
    // no SessionContext to bridge hooks into.
    await run(
      () => {},
      () => {},
      true,
      undefined,
    )
    return
  }

  // Real-run mode: withTrackedWorkflow installs its own SIGINT handler that
  // writes a `failed` tracker entry + log entry before exiting. A kernel
  // handler on top would just duplicate cleanup, so don't install one.
  await withLogContext(wf.config.name, String(itemId), async () => {
    const seedData = buildInitialTrackerData(wf, handlerInput)
    const rowArchetype = deriveRowArchetype(
      resolveArchetype(wf.config, handlerInput),
      opts.parentRunId,
      runtimeOptions?.rowShape === 'batch-member' ? { member: true } : undefined,
    )
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      async (setStep, updateData, _onCleanup, sessionCtx, emitFailed, trackerRunId, emitSkipped) => {
        const screenshotFn = Promise.withResolvers<ScreenshotFn>()
        const observer = buildSessionObserver(wf, sessionCtx, setStep, emitFailed, screenshotFn.promise, opts.trackerDir)
        // Thread tracker's runId into run() so Stepper + screenshot events
        // share the same id as the JSONL rows (fixed 2026-04-23 — previously
        // the inner `run()` generated its own UUID while the tracker wrote
        // `{id}#N`, desyncing screenshot-to-run correlation).
        await run(setStep, updateData, false, observer, (session, runId, stepper, trackerDir) => {
          screenshotFn.resolve(makeScreenshotFn({
            session,
            runId,
            workflow: wf.config.name,
            itemId: String(itemId),
            emit: (ev) => emitScreenshotEvent(ev, { dir: trackerDir }),
            currentStep: () => stepper.getCurrentStep(),
          }))
        }, trackerRunId, emitSkipped)
      },
      {
        ...buildTrackerOpts(wf),
        preAssignedRunId: opts.preAssignedRunId,
        dir: opts.trackerDir,
        initialData: Object.keys(seedData).length > 0 ? seedData : undefined,
        ...(inputForRow ? { input: inputForRow } : {}),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
        archetype: rowArchetype,
      },
    )
  }, opts.trackerDir)
}
