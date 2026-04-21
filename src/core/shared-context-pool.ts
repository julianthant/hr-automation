import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { deriveItemId, runOneItem } from './workflow.js'

interface PoolItem<TData> {
  item: TData
  itemId: string
  runId: string
}

/**
 * Run N workflow items concurrently against a SINGLE authenticated Session:
 * one browser + context per system (one Duo per system), N per-worker Pages
 * spawned lazily from each system's BrowserContext. Each item gets its own
 * `withTrackedWorkflow` envelope via the shared `runOneItem`, so the dashboard
 * shows one row per item with its own step timing.
 *
 * Use when parallelism is desired but launching per-worker Sessions would
 * re-trigger Duo on every worker (e.g. eid-lookup's N-tab fan-out from one
 * UCPath auth).
 */
export async function runWorkflowSharedContextPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = opts.poolSize ?? wf.config.batch?.poolSize ?? 4

  items.forEach((item) => {
    try {
      wf.config.schema.parse(item)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

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

  const parent = await Session.launch(wf.config.systems, {
    authChain: wf.config.authChain,
    tiling: wf.config.tiling,
    launchFn: opts.launchFn,
  })

  const queue: PoolItem<TData>[] = [...perItem]
  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  async function worker(): Promise<void> {
    const session = Session.forWorker(parent)
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
      await session.closeWorkerPages()
    }
  }

  try {
    const workerCount = Math.min(poolSize, items.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    await parent.close()
  }
  return result
}
