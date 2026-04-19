import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata, RunOpts, BatchResult } from './types.js'
import { register, autoLabel, normalizeDetailField } from './registry.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { makeCtx } from './ctx.js'
import { trackEvent, withTrackedWorkflow, type WithTrackedWorkflowOpts } from '../tracker/jsonl.js'
import { withLogContext } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'
import { runWorkflowPool } from './pool.js'

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
}

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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { wf, session, item, itemId, runId, trackerDir, callerPreEmits } = args
  const screenshotFn = async (stepName: string): Promise<void> => {
    await session.screenshotAll(`${wf.config.name}-${itemId}-${stepName}`)
  }

  if (args.trackerStub) {
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId,
      runId,
      emitStep: () => {},
      emitData: () => {},
      emitFailed: () => {},
      screenshotFn,
    })
    const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: true, runId })
    try {
      if (args.preHandler) await args.preHandler()
      await wf.config.handler(ctx, item)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: classifyError(err) }
    }
  }

  // Real-tracker path: wrap each item in withLogContext + withTrackedWorkflow
  // so dashboard gets pending → running → done/failed rows per item, and logs
  // carry workflow/itemId/runId context. Emit the initial `pending` row here
  // (unless the caller opted into preEmitPending) so the dashboard shows the
  // row before the first step runs; withTrackedWorkflow skips its own pending
  // emit when preAssignedRunId is provided.
  if (!callerPreEmits) {
    trackEvent(
      {
        workflow: wf.config.name,
        timestamp: new Date().toISOString(),
        id: itemId,
        runId,
        status: 'pending',
      },
      trackerDir,
    )
  }
  try {
    await withLogContext(wf.config.name, itemId, async () => {
      await withTrackedWorkflow(
        wf.config.name,
        itemId,
        async (setStep, updateData) => {
          const stepper = new Stepper({
            workflow: wf.config.name,
            itemId,
            runId,
            emitStep: setStep,
            emitData: updateData,
            emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
            screenshotFn,
          })
          const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: true, runId })
          if (args.preHandler) await args.preHandler()
          await wf.config.handler(ctx, item)
        },
        {
          ...buildTrackerOpts(wf),
          preAssignedRunId: runId,
          dir: trackerDir,
        },
      )
    }, trackerDir)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: classifyError(err) }
  }
}

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const metadata: WorkflowMetadata = {
    name: config.name,
    label: config.label ?? autoLabel(config.name),
    steps: config.steps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []).map(normalizeDetailField),
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
  // 1. Validate data. Wrap to ensure error message matches /validation/i.
  try {
    wf.config.schema.parse(data)
  } catch (err) {
    throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Derive itemId from common id fields, fall back to UUID.
  const itemId = opts.itemId ?? deriveItemId(data, randomUUID())

  const run = async (
    setStep: (s: string) => void,
    updateData: (d: Record<string, unknown>) => void,
    /**
     * Install a kernel-owned SIGINT handler. Only passed `true` in the
     * `trackerStub` branch — in real runs, `withTrackedWorkflow` owns SIGINT
     * and a second handler here would just duplicate cleanup.
     */
    installSigint: boolean,
  ): Promise<void> => {
    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      tiling: wf.config.tiling,
      launchFn: opts.launchFn,
    })

    const runId = opts.preAssignedRunId ?? randomUUID()
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId: String(itemId),
      runId,
      emitStep: setStep,
      // Tracker's updateData now accepts unknown; it stringifies at the write boundary.
      emitData: updateData,
      emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
      screenshotFn: async (stepName) => {
        await session.screenshotAll(`${wf.config.name}-${String(itemId)}-${stepName}`)
      },
    })

    const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: false, runId })

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
      await wf.config.handler(ctx, data)
    } finally {
      if (sigintHandler) process.off('SIGINT', sigintHandler)
      await session.close()
    }
  }

  if (opts.trackerStub) {
    // trackerStub mode is test-only injection: withTrackedWorkflow isn't
    // running, so the kernel must own SIGINT here.
    await run(
      () => {},
      () => {},
      true,
    )
    return
  }

  // Real-run mode: withTrackedWorkflow installs its own SIGINT handler that
  // writes a `failed` tracker entry + log entry before exiting. A kernel
  // handler on top would just duplicate cleanup, so don't install one.
  await withLogContext(wf.config.name, String(itemId), async () => {
    const seedData = wf.config.initialData?.(data) ?? {}
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      async (setStep, updateData /*, _onCleanup, _session */) => {
        await run(setStep, updateData, false)
      },
      {
        ...buildTrackerOpts(wf),
        preAssignedRunId: opts.preAssignedRunId,
        dir: opts.trackerDir,
        initialData: stringifyMap(seedData),
      },
    )
  }, opts.trackerDir)
}

export async function runWorkflowBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts & { dryRun?: boolean } = {},
): Promise<BatchResult> {
  const batch = wf.config.batch
  if (batch?.mode === 'pool') {
    return runWorkflowPool(wf, items, opts)
  }

  // Sequential mode: validate all items upfront.
  items.forEach((item) => {
    try {
      wf.config.schema.parse(item)
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

  const session = await Session.launch(wf.config.systems, {
    authChain: wf.config.authChain,
    tiling: wf.config.tiling,
    launchFn: opts.launchFn,
  })

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  // Sequential between-items hook — skipped on the first item (fresh auth
  // state). Threaded into runOneItem via `preHandler` so the hook runs INSIDE
  // the withTrackedWorkflow envelope; throws here surface as failed tracker
  // entries the same way handler throws do.
  const makePreHandler = (i: number): (() => Promise<void>) | undefined => {
    if (i === 0 || !batch?.betweenItems) return undefined
    return async () => {
      for (const hook of batch.betweenItems!) {
        if (hook === 'reset-browsers' || hook === 'navigate-home') {
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
      })
      if (r.ok) result.succeeded++
      else { result.failed++; result.errors.push({ item, error: r.error }) }
    }
  } finally {
    await session.close()
  }
  return result
}
