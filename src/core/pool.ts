import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { makeCtx } from './ctx.js'
import { deriveItemId, buildTrackerOpts } from './workflow.js'
import { trackEvent, withTrackedWorkflow } from '../tracker/jsonl.js'
import { withLogContext } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'

interface PoolItem<TData> {
  item: TData
  itemId: string
  runId: string
}

export async function runWorkflowPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = opts.poolSize ?? wf.config.batch?.poolSize ?? 4

  // Validate all items upfront.
  items.forEach((item) => {
    try {
      wf.config.schema.parse(item)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  // Pre-generate one itemId + runId per item so pre-emit callbacks receive the same
  // runId that withTrackedWorkflow will later use inside the worker. Callers can
  // supply `opts.deriveItemId` to shape itemIds that `deriveItemId`'s built-in
  // field list (`emplId`, `docId`, `email`) can't produce.
  const itemIdFn = opts.deriveItemId ?? ((item: unknown) => deriveItemId(item, randomUUID()))
  const perItem: PoolItem<TData>[] = items.map((item) => ({
    item,
    itemId: itemIdFn(item),
    runId: randomUUID(),
  }))

  const callerPreEmits = Boolean(wf.config.batch?.preEmitPending && opts.onPreEmitPending)
  if (callerPreEmits) {
    for (const { item, runId } of perItem) opts.onPreEmitPending!(item, runId)
  }

  const queue: PoolItem<TData>[] = [...perItem]
  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  async function worker(): Promise<void> {
    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      tiling: wf.config.tiling,
      launchFn: opts.launchFn,
    })
    try {
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) break
        const { item, itemId, runId } = next

        if (opts.trackerStub) {
          const stepper = new Stepper({
            workflow: wf.config.name,
            itemId,
            runId,
            emitStep: () => {},
            emitData: () => {},
            emitFailed: () => {},
            screenshotFn: async (stepName) => {
              await session.screenshotAll(`${wf.config.name}-${itemId}-${stepName}`)
            },
          })
          const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: true, runId })
          try {
            await wf.config.handler(ctx, item)
            result.succeeded++
          } catch (err) {
            result.failed++
            result.errors.push({ item, error: classifyError(err) })
          }
          continue
        }

        // Real-tracker path: wrap each item in withLogContext + withTrackedWorkflow
        // so each worker's items are reported live to the dashboard. Emit the
        // initial `pending` row here (unless caller opted into preEmitPending)
        // so the dashboard sees the row before the first step runs; withTrackedWorkflow
        // skips its own pending emit when preAssignedRunId is provided.
        if (!callerPreEmits) {
          trackEvent(
            {
              workflow: wf.config.name,
              timestamp: new Date().toISOString(),
              id: itemId,
              runId,
              status: 'pending',
            },
            opts.trackerDir,
          )
        }
        try {
          await withLogContext(wf.config.name, itemId, async () => {
            await withTrackedWorkflow(
              wf.config.name,
              itemId,
              {},
              async (setStep, updateData) => {
                const stepper = new Stepper({
                  workflow: wf.config.name,
                  itemId,
                  runId,
                  emitStep: setStep,
                  emitData: updateData,
                  emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
                  screenshotFn: async (stepName) => {
                    await session.screenshotAll(`${wf.config.name}-${itemId}-${stepName}`)
                  },
                })
                const ctx = makeCtx<TSteps, TData>({ session, stepper, isBatch: true, runId })
                await wf.config.handler(ctx, item)
              },
              runId,
              opts.trackerDir,
              buildTrackerOpts(wf),
            )
          }, opts.trackerDir)
          result.succeeded++
        } catch (err) {
          result.failed++
          result.errors.push({ item, error: classifyError(err) })
        }
      }
    } finally {
      await session.close()
    }
  }

  const workerCount = Math.min(poolSize, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return result
}
