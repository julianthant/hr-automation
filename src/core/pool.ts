import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, BatchResult, Ctx, RunOpts } from './types.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { log } from '../utils/log.js'
import { classifyError } from '../utils/errors.js'

export async function runWorkflowPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = wf.config.batch?.poolSize ?? 4

  // Validate all items upfront.
  items.forEach((item) => {
    try {
      wf.config.schema.parse(item)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  if (wf.config.batch?.preEmitPending && opts.onPreEmitPending) {
    for (const item of items) opts.onPreEmitPending(item)
  }

  const queue = [...items]
  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  async function worker(): Promise<void> {
    const session = await Session.launch(wf.config.systems, {
      authChain: wf.config.authChain,
      tiling: wf.config.tiling,
      launchFn: opts.launchFn,
    })
    try {
      while (queue.length > 0) {
        const item = queue.shift()
        if (item === undefined) break
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
        const ctx: Ctx<TSteps, TData> = {
          page: (id) => session.page(id),
          step: (name, fn) => stepper.step(name as string, fn),
          parallel: (tasks) => stepper.parallel(tasks),
          updateData: (patch) => stepper.updateData(patch as Record<string, unknown>),
          session: {
            page: (id) => session.page(id),
            newWindow: async () => { throw new Error('newWindow not yet implemented') },
            closeWindow: async () => { throw new Error('closeWindow not yet implemented') },
          },
          log,
          isBatch: true,
          runId,
        }
        try {
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
  }

  const workerCount = Math.min(poolSize, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return result
}
