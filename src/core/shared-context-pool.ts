import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { deriveItemId, runOneItem } from './workflow.js'
import { withBatchLifecycle } from './batch-lifecycle.js'

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
 * Lifecycle (instance allocation, workflow_start/end, SIGINT fanout, auth-
 * failure fanout, per-system authTimings) is owned by `withBatchLifecycle`.
 * The body below just owns the per-worker Session fan-out. A single observer
 * (`sessionId: '1'`) is passed to `Session.launch` — shared-context-pool only
 * has one authenticated Session for the whole batch.
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

      const parent = await Session.launch(wf.config.systems, {
        authChain: wf.config.authChain,
        launchFn: opts.launchFn,
        observer,
      })

      // In interleaved authChain (default for >1 system), `Session.launch`
      // returns as soon as the FIRST system is authenticated — the rest
      // chain in the background. Wait for every system's ready promise
      // before snapshotting authTimings so we capture the full window
      // for every auth. `page(id)` awaits the ready promise without
      // opening a new page on the parent (persistent pages are reused).
      for (const sys of wf.config.systems) {
        try { await parent.page(sys.id) } catch { /* auth failure surfaces elsewhere */ }
      }

      // Snapshot authTimings AFTER every system is ready so every
      // onAuthComplete has fired. Shared across every runOneItem call —
      // all items ran through the one parent Session's auth.
      const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

      const queue: PoolItem<TData>[] = [...perItem]

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
              preAssignedInstance: instance,
              authTimings,
            })
            markTerminated(runId)
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
    },
  )
}
