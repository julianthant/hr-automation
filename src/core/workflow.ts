import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata, RunOpts, BatchResult } from './types.js'
import { register, autoLabel, normalizeDetailField } from './registry.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { makeCtx } from './ctx.js'
import { trackEvent, withTrackedWorkflow, emitScreenshotEvent, type WithTrackedWorkflowOpts } from '../tracker/jsonl.js'
import { makeScreenshotFn } from './screenshot.js'
import { withLogContext, log } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'
import { CancelledError } from './types.js'
import { runWorkflowPool } from './pool.js'
import { runWorkflowSharedContextPool } from './shared-context-pool.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { makeAuthObserver } from '../tracker/auth-observer.js'

/**
 * Coerce an arbitrary key → unknown map into the `Record<string, string>`
 * shape that withTrackedWorkflow's `initialData` expects. Non-string values
 * are stringified via String(); null/undefined become empty string.
 */
function stringifyMap(d: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(d)) {
    out[k] = v == null ? '' : String(v)
  }
  return out
}

/**
 * Best-effort coercion of an arbitrary input into a `Record<string, unknown>`
 * so it can ride on the `pending` tracker row's `input` field. Non-objects
 * become `null` (caller skips writing the field). Does NOT clone — the
 * returned reference is the same object the kernel got, by design: the
 * tracker line is JSON-stringified at write time, so downstream mutation
 * by the handler can't reach back into the file.
 */
function toRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

/**
 * Split a `prefilledData` channel out of an arbitrary input object without
 * mutating the original. Used by the kernel's edit-and-resume path: the
 * dashboard re-enqueues an item with `prefilledData: <user-edited fields>`,
 * the kernel strips the channel before handing the input to the workflow's
 * Zod schema (so the schema doesn't need to know about it), and merges the
 * stripped values into `ctx.data` via `updateData(...)` BEFORE the handler
 * runs. Handlers gate their extraction step on data presence (e.g.
 * `if (!ctx.data.foo) await ctx.step("extraction", ...)`) to opt in.
 *
 * Returns `{ cleaned, prefilled }`. `prefilled` is null when the input has
 * no `prefilledData` field or it's not an object — both are "no-op" cases.
 */
export function splitPrefilled(input: unknown): {
  cleaned: unknown
  prefilled: Record<string, unknown> | null
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { cleaned: input, prefilled: null }
  }
  const obj = input as Record<string, unknown>
  if (!('prefilledData' in obj)) return { cleaned: input, prefilled: null }
  const { prefilledData, ...rest } = obj
  const prefilled =
    prefilledData && typeof prefilledData === 'object' && !Array.isArray(prefilledData)
      ? (prefilledData as Record<string, unknown>)
      : null
  return { cleaned: rest, prefilled }
}

/**
 * Build the richness-hook bundle for `withTrackedWorkflow` from a workflow
 * config. Extracted so all three modes (runWorkflow, runWorkflowBatch,
 * runWorkflowPool) pass the identical shape — keeps the runtime warning,
 * getName, and getId in lockstep across modes.
 */
export function buildTrackerOpts<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
): WithTrackedWorkflowOpts {
  return {
    declaredDetailFields: (wf.config.detailFields ?? [])
      .map(normalizeDetailField)
      .map((f) => f.key),
    nameFn: wf.config.getName,
    idFn: wf.config.getId,
  }
}

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
        try { await ctx.screenshot({ kind: 'error', label: 'handler-throw' }) } catch { /* best-effort */ }
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
  const seedData = wf.config.initialData?.(handlerInput) ?? {}
  const stringifiedSeed = stringifyMap(seedData)
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
          })
          stepper.setScreenshotFn(ctx.screenshot)
          if (args.preHandler) await args.preHandler()
          if (prefilled) ctx.updateData(prefilled as Partial<TData & Record<string, unknown>>)
          try {
            await wf.config.handler(ctx, handlerInput)
          } catch (err) {
            // CancelledError: no diagnostic screenshot — the cancel was
            // intentional and the page state is already being reset by
            // the daemon's claim loop. Rethrow so the outer catch in
            // runOneItem surfaces the kind discriminator.
            if (err instanceof CancelledError) throw err
            // Covers throws that escape ctx.step (e.g. separations'
            // resolveJobSummaryResult unwrap or the post-step
            // submittedWithoutTxnNumber guard). Stepper.step already
            // screenshots in-step throws; same label convention applies.
            try { await ctx.screenshot({ kind: 'error', label: 'handler-throw' }) } catch { /* best-effort */ }
            throw err
          }
        },
        {
          ...buildTrackerOpts(wf),
          preAssignedRunId: runId,
          preAssignedInstance: args.preAssignedInstance,
          dir: trackerDir,
          initialData: stringifiedSeed,
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

/**
 * Build a SessionObserver that routes Session.launch lifecycle hooks into
 * the tracker's SessionContext (for Events-tab events) and `setStep` /
 * `emitFailed` (for the StepPipeline + entry-status flip to "running" /
 * "failed"). Auth step names follow the `auth:<systemId>` convention that
 * `defineWorkflow` auto-prepends to the effective step list.
 *
 * Guard: if `authSteps: false` is set (workflow already declares its own
 * custom auth step names), the `setStep` / `emitFailed` calls are skipped so
 * we never emit a `running` row for an unregistered step name.
 */
export function buildSessionObserver<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  sessionCtx: import('../tracker/jsonl.js').SessionContext,
  setStep: (step: string) => void,
  emitFailed: (step: string, error: string) => void = () => {},
  /**
   * Mutable screenshot holder (Strategy B). Starts as a no-op; onReady swaps
   * in a real makeScreenshotFn once the Session reference is available.
   * The observer calls `boundScreenshot.fn(...)` at invocation time so it
   * always picks up the latest value — not the one captured at construction.
   */
  boundScreenshot: { fn: import('./types.js').ScreenshotFn } = {
    fn: async () => ({ kind: 'error', label: '', step: null, ts: Date.now(), files: [] }),
  },
): import('./types.js').SessionObserver {
  const sessionId = '1'
  let registered = false
  // Use wf.metadata.steps (effective steps, including auto-prepended auth:<id>
  // entries) so the guard reflects what the registry actually declared.
  const effectiveSteps = new Set<string>(wf.metadata.steps)

  // Build the auth-step observer — screenshot is indirected through
  // boundScreenshot.fn so onReady can swap in the real fn after construction.
  const authObs = makeAuthObserver({
    emitStep: (stepName) => {
      if (effectiveSteps.has(stepName)) setStep(stepName)
    },
    emitFailed: (stepName, error) => {
      if (effectiveSteps.has(stepName)) emitFailed(stepName, error)
    },
    screenshot: (opts) => boundScreenshot.fn(opts),
  })

  return {
    instance: sessionCtx.instance,
    onBrowserLaunch: (systemId, browserId) => {
      if (!registered) {
        sessionCtx.registerSession(sessionId)
        registered = true
      }
      sessionCtx.registerBrowser(sessionId, browserId, systemId)
    },
    onAuthStart: (systemId, browserId) => {
      authObs.onAuthStart!(systemId, browserId)
      sessionCtx.setAuthState(browserId, systemId, 'start')
    },
    onAuthComplete: (systemId, browserId) => {
      authObs.onAuthComplete!(systemId, browserId)
      sessionCtx.setAuthState(browserId, systemId, 'complete')
    },
    onAuthFailed: (systemId, browserId) => {
      void authObs.onAuthFailed!(systemId, browserId)
      sessionCtx.setAuthState(browserId, systemId, 'failed')
    },
  }
}

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const authPrefix =
    config.authSteps === false ? [] : config.systems.map((s) => `auth:${s.id}`)
  const effectiveSteps: readonly string[] = [...authPrefix, ...config.steps]
  const metadata: WorkflowMetadata = {
    name: config.name,
    label: config.label ?? autoLabel(config.name),
    steps: effectiveSteps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []).map(normalizeDetailField),
    ...(config.category ? { category: config.category } : {}),
    ...(config.iconName ? { iconName: config.iconName } : {}),
    ...(config.matchKey ? { matchKey: config.matchKey } : {}),
  }
  register(metadata)
  return { config, metadata }
}

/**
 * Derive a stable itemId from common identifier fields on the input data.
 * Falls back to the caller-provided `fallback` (typically a UUID) if no known
 * field is present.
 *
 * Recognized fields (in priority order): `emplId`, `docId`, `email`.
 */
export function deriveItemId<TData>(data: TData, fallback: string): string {
  const d = data as unknown as Record<string, unknown>
  return (
    (typeof d?.emplId === 'string' ? d.emplId : undefined) ??
    (typeof d?.docId === 'string' ? d.docId : undefined) ??
    (typeof d?.email === 'string' ? d.email : undefined) ??
    fallback
  )
}

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
  const { cleaned: cleanedData, prefilled } = splitPrefilled(data)
  const handlerInput = cleanedData as TData
  const inputForRow = toRecord(data)

  // 1. Validate data. Wrap to ensure error message matches /validation/i.
  try {
    wf.config.schema.parse(handlerInput)
  } catch (err) {
    throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Derive itemId from common id fields, fall back to UUID.
  const itemId = opts.itemId ?? deriveItemId(handlerInput, randomUUID())

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

    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      launchFn: opts.launchFn,
      observer,
      onReady: (sess) => onSessionReady?.(sess, runId, stepper, opts.trackerDir),
    })

    const ctx = makeCtx<TSteps, TData>({
      session,
      stepper,
      isBatch: false,
      runId,
      workflow: wf.config.name,
      itemId: String(itemId),
      emitScreenshotEvent: (ev) => emitScreenshotEvent(ev, { dir: opts.trackerDir }),
    })
    stepper.setScreenshotFn(ctx.screenshot)

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
      try {
        if (prefilled) ctx.updateData(prefilled as Partial<TData & Record<string, unknown>>)
        await wf.config.handler(ctx, handlerInput)
      } catch (err) {
        // Same screenshot-on-handler-throw hoist as runOneItem (see the
        // two other call sites). Best-effort; original throw always wins.
        try { await ctx.screenshot({ kind: 'error', label: 'handler-throw' }) } catch { /* best-effort */ }
        throw err
      }
    } finally {
      if (sigintHandler) process.off('SIGINT', sigintHandler)
      await session.close()
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
    const seedData = wf.config.initialData?.(handlerInput) ?? {}
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      async (setStep, updateData, _onCleanup, sessionCtx, emitFailed, trackerRunId, emitSkipped) => {
        // Strategy B: mutable holder so onReady can swap in a real ScreenshotFn.
        const boundScreenshot: { fn: import('./types.js').ScreenshotFn } = {
          fn: async () => ({ kind: 'error', label: '', step: null, ts: Date.now(), files: [] }),
        }
        const observer = buildSessionObserver(wf, sessionCtx, setStep, emitFailed, boundScreenshot)
        // Thread tracker's runId into run() so Stepper + screenshot events
        // share the same id as the JSONL rows (fixed 2026-04-23 — previously
        // the inner `run()` generated its own UUID while the tracker wrote
        // `{id}#N`, desyncing screenshot-to-run correlation).
        await run(setStep, updateData, false, observer, (session, runId, stepper, trackerDir) => {
          boundScreenshot.fn = makeScreenshotFn({
            session,
            runId,
            workflow: wf.config.name,
            itemId: String(itemId),
            emit: (ev) => emitScreenshotEvent(ev, { dir: trackerDir }),
            currentStep: () => stepper.getCurrentStep(),
          })
        }, trackerRunId, emitSkipped)
      },
      {
        ...buildTrackerOpts(wf),
        preAssignedRunId: opts.preAssignedRunId,
        dir: opts.trackerDir,
        initialData: stringifyMap(seedData),
        ...(inputForRow ? { input: inputForRow } : {}),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      },
    )
  }, opts.trackerDir)
}

export async function runWorkflowBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const batch = wf.config.batch
  if (batch?.mode === 'pool') {
    return runWorkflowPool(wf, items, opts)
  }
  if (batch?.mode === 'shared-context-pool') {
    return runWorkflowSharedContextPool(wf, items, opts)
  }

  // Sequential mode: validate all items upfront. Strip the prefilledData
  // channel before parsing so workflow schemas don't have to know about
  // the kernel-level edit-and-resume contract — strict()-mode schemas
  // would otherwise reject the channel as an unknown key.
  items.forEach((item) => {
    try {
      const { cleaned } = splitPrefilled(item)
      wf.config.schema.parse(cleaned)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Pre-generate one itemId + runId per item so pre-emit callbacks receive the same
  // runId that withTrackedWorkflow will later use. This lets callers emit the initial
  // `pending` row now and have withTrackedWorkflow skip its duplicate pending emit.
  // If the caller provides `deriveItemId`, use it — lets workflows like
  // emergency-contact produce `p{NN}-{emplId}`-shaped ids that `onPreEmitPending`
  // and the handler's withTrackedWorkflow both use.
  const itemIdFn = opts.deriveItemId ?? ((item) => deriveItemId(item, randomUUID()))
  const perItem = items.map((item) => ({
    item,
    itemId: itemIdFn(item),
    runId: randomUUID(),
  }))

  // Emit pending for all items upfront if requested — runIds are paired so the
  // caller writes the same runId that the handler's withTrackedWorkflow will use.
  // If the workflow doesn't opt into preEmitPending, we emit a minimal pending
  // row per item right before that item runs (below, inside the loop).
  const callerPreEmits = Boolean(batch?.preEmitPending && opts.onPreEmitPending)
  if (callerPreEmits) {
    for (const { item, runId } of perItem) {
      opts.onPreEmitPending!(item, runId)
    }
  }

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  return withBatchLifecycle(
    {
      workflow: wf.config.name,
      systems: wf.config.systems,
      perItem: perItem.map(({ item, itemId, runId }) => ({ item, itemId, runId })),
      trackerDir: opts.trackerDir,
    },
    async ({ instance, markTerminated, makeObserver }) => {
      const { observer, getAuthTimings } = makeObserver('1')
      const session = await Session.launch(wf.config.systems, {
        authChain: wf.config.authChain,
        launchFn: opts.launchFn,
        observer,
      })

      // Await every system's readyPromise before snapshotting authTimings
      // (interleaved authChain returns once first system is ready).
      for (const sys of wf.config.systems) {
        try { await session.page(sys.id) } catch { /* auth failure surfaces elsewhere */ }
      }
      const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

      // Sequential between-items hook — skipped on the first item (fresh
      // auth state). Threaded into runOneItem via `preHandler` so hook runs
      // INSIDE withTrackedWorkflow; throws surface as `failed` tracker rows
      // just like handler throws.
      const makePreHandler = (i: number): (() => Promise<void>) | undefined => {
        if (i === 0 || !batch?.betweenItems) return undefined
        return async () => {
          for (const hook of batch.betweenItems!) {
            if (hook === 'reset-browsers') {
              const t0 = Date.now()
              for (const s of wf.config.systems) await session.reset(s.id)
              log.step(`[Batch] Reset browsers (took ${Date.now() - t0}ms)`)
            } else if (hook === 'navigate-home') {
              for (const s of wf.config.systems) await session.reset(s.id)
            } else if (hook === 'health-check') {
              for (const s of wf.config.systems) {
                if (!(await session.healthCheck(s.id))) {
                  throw new Error(`health-check failed for ${s.id}`)
                }
              }
            }
          }
        }
      }

      try {
        for (let i = 0; i < perItem.length; i++) {
          const { item, itemId, runId } = perItem[i]
          log.step(`[Batch] Item ${i + 1}/${perItem.length}: itemId='${itemId}'`)
          const r = await runOneItem({
            wf,
            session,
            item,
            itemId,
            runId,
            trackerStub: opts.trackerStub,
            trackerDir: opts.trackerDir,
            callerPreEmits,
            preHandler: makePreHandler(i),
            preAssignedInstance: instance,
            authTimings,
          })
          markTerminated(runId)
          if (r.ok) result.succeeded++
          else { result.failed++; result.errors.push({ item, error: r.error }) }
        }
      } finally {
        await session.close()
      }
      return result
    },
  )
}
