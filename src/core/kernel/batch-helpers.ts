import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, RunOpts, SystemConfig } from './types.js'
import { Session } from './session.js'
import { deriveItemId } from './workflow.js'

export interface PerItem<TData> {
  item: TData
  itemId: string
  runId: string
}

/**
 * Validate items, derive itemIds + runIds, and fire pre-emit-pending if
 * the workflow opts in. Returns one entry per input item, in input order.
 *
 * Pass `validate` from the caller — `runWorkflowBatch` strips the
 * `prefilledData` channel via splitPrefilled before parsing, the pool
 * runners parse the raw item. This is a behavioral difference between
 * the runners that the helper preserves rather than papers over.
 */
export function validateAndPrepareItems<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts,
  validate: (item: TData) => void,
): PerItem<TData>[] {
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    try {
      validate(item)
    } catch (err) {
      throw new Error(`validation error at item ${i}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  const itemIdFn =
    opts.deriveItemId ??
    wf.config.deriveItemId ??
    ((item: unknown) => deriveItemId(item, randomUUID()))
  const perItem: PerItem<TData>[] = items.map((item) => ({
    item,
    itemId: itemIdFn(item),
    runId: randomUUID(),
  }))

  const callerPreEmits = Boolean(wf.config.batch?.preEmitPending && opts.onPreEmitPending)
  if (callerPreEmits) {
    for (const { item, runId } of perItem) opts.onPreEmitPending!(item, runId)
  }

  return perItem
}

/**
 * Indicates whether the caller pre-emitted pending rows. Computed the
 * same way every runner does: `wf.config.batch?.preEmitPending`
 * AND `opts.onPreEmitPending` is provided.
 */
export function callerPreEmitsPending<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  opts: RunOpts,
): boolean {
  return Boolean(wf.config.batch?.preEmitPending && opts.onPreEmitPending)
}

/**
 * Wait for every system's auth-ready promise to resolve. Per-system auth
 * failures are swallowed by default — that failure path is owned by the
 * observer / batch lifecycle helper, which surfaces it via auth-failure
 * tracker rows and does not need this loop to throw.
 *
 * `throwIfAllFailed` (pool callers): when EVERY system failed for this session,
 * rethrow the first failure instead of swallowing. A pool worker whose every
 * system is unauthenticated would otherwise loop running items against dead
 * pages (N per-item failures); throwing lets `runPooledBatch` fail that worker
 * cleanly (and, when all workers fail, fan out a single batch-level auth
 * failure). A PARTIAL failure (some systems up) still swallows so the workflow
 * can proceed on the systems it has.
 *
 * Must be called BEFORE snapshotting authTimings via the observer's
 * `getAuthTimings()` — `Session.launch` returns once every system has its
 * `readyPromise` registered, but Duo approvals for systems 2..N are still
 * pending in the background under the parallel-staggered chain.
 */
export async function awaitAllSystemsReady(
  session: Session,
  systems: readonly SystemConfig[],
  opts: { throwIfAllFailed?: boolean } = {},
): Promise<void> {
  const results = await Promise.allSettled(systems.map((sys) => session.page(sys.id)))
  if (opts.throwIfAllFailed && systems.length > 0 && results.every((r) => r.status === 'rejected')) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    throw first.reason
  }
  // else: per-system failures stay swallowed — see JSDoc.
}
