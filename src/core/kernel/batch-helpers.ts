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
  items.forEach((item) => {
    try {
      validate(item)
    } catch (err) {
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    }
  })

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
 * Wait for every system's auth-ready promise to resolve. Auth failures
 * are swallowed — the failure path is owned by the observer / batch
 * lifecycle helper, which surfaces it via auth-failure tracker rows
 * and does not need this loop to throw.
 *
 * Must be called BEFORE snapshotting authTimings via the observer's
 * `getAuthTimings()` — `Session.launch` with `authChain: 'interleaved'`
 * returns once the FIRST system is ready, so timings for systems 2..N
 * are still being captured asynchronously.
 */
export async function awaitAllSystemsReady(
  session: Session,
  systems: readonly SystemConfig[],
): Promise<void> {
  await Promise.all(systems.map(async (sys) => {
    try {
      await session.page(sys.id)
    } catch {
      // intentional swallow — see JSDoc above
    }
  }))
}
