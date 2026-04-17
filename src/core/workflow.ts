import { randomUUID } from 'node:crypto'
import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata, RunOpts, BatchResult } from './types.js'
import { register } from './registry.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { makeCtx } from './ctx.js'
import { withTrackedWorkflow } from '../tracker/jsonl.js'
import { withLogContext } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'
import { runWorkflowPool } from './pool.js'

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const metadata: WorkflowMetadata = {
    name: config.name,
    steps: config.steps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []) as string[],
  }
  register(metadata)
  return { config, metadata }
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
  const d = data as unknown as Record<string, unknown>
  const itemId =
    opts.itemId ??
    (typeof d?.emplId === 'string' ? d.emplId : undefined) ??
    (typeof d?.docId === 'string' ? d.docId : undefined) ??
    (typeof d?.email === 'string' ? d.email : undefined) ??
    randomUUID()

  const run = async (
    setStep: (s: string) => void,
    updateData: (d: Record<string, unknown>) => void,
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
    })

    const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: false, runId })

    const sigintHandler = () => {
      try {
        const step = stepper.getCurrentStep() ?? 'sigint'
        setStep(`${step}:failed:interrupted`)
      } catch { /* best-effort */ }
      // Fire-and-forget kill — we're exiting regardless.
      session.killChrome().catch(() => {})
      process.exit(1)
    }
    process.on('SIGINT', sigintHandler)

    try {
      await wf.config.handler(ctx, data)
    } finally {
      process.off('SIGINT', sigintHandler)
      await session.close()
    }
  }

  if (opts.trackerStub) {
    await run(
      () => {},
      () => {},
    )
    return
  }

  await withLogContext(wf.config.name, String(itemId), async () => {
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      {},                                               // initialData
      async (setStep, updateData /*, _onCleanup, _session */) => {
        await run(setStep, updateData)
      },
      opts.preAssignedRunId,                            // 5th positional
    )
  })
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

  // Emit pending for all items upfront if requested.
  if (batch?.preEmitPending && opts.onPreEmitPending) {
    for (const item of items) {
      opts.onPreEmitPending(item)
    }
  }

  const session = await Session.launch(wf.config.systems, {
    authChain: wf.config.authChain,
    tiling: wf.config.tiling,
    launchFn: opts.launchFn,
  })

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const itemId = randomUUID()
      const runId = randomUUID()
      const stepper = new Stepper({
        workflow: wf.config.name,
        itemId,
        runId,
        emitStep: () => {},
        emitData: () => {},
        emitFailed: () => {},
      })
      const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: true, runId })
      try {
        // Between-items hooks — skipped on the first item (fresh auth state).
        if (i > 0 && batch?.betweenItems) {
          for (const hook of batch.betweenItems) {
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
        await wf.config.handler(ctx, item)
        result.succeeded++
      } catch (err) {
        result.failed++
        result.errors.push({ item, error: classifyError(err) })
      }
    }
  } finally {
    await session.close()
  }
  return result
}
