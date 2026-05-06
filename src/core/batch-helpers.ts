import { randomUUID } from 'node:crypto'
import type { RegisteredWorkflow, RunOpts } from './types.js'
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
      throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
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
