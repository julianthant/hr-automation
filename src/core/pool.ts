import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { deriveItemId, runOneItem } from './workflow.js'

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
        const r = await runOneItem({
          wf,
          session,
          item,
          itemId,
          runId,
          trackerStub: opts.trackerStub,
          trackerDir: opts.trackerDir,
          callerPreEmits,
        })
        if (r.ok) result.succeeded++
        else { result.failed++; result.errors.push({ item, error: r.error }) }
      }
    } finally {
      await session.close()
    }
  }

  const workerCount = Math.min(poolSize, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return result
}
