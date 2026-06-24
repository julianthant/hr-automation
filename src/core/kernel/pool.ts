import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { runOneItem } from './run-one-item.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { validateAndPrepareItems, callerPreEmitsPending, awaitAllSystemsReady } from './batch-helpers.js'
import type { PerItem } from './batch-helpers.js'
import { log } from '../../utils/log.js'

type PoolItem<TData> = PerItem<TData>

/**
 * Run N items across N workers, each with its OWN authenticated Session.
 * Use when per-worker auth isolation matters (e.g. onboarding: each worker
 * needs its own Duo-authenticated Kronos tab because tabs can't be shared).
 *
 * Lifecycle (instance allocation, workflow_start/end, SIGINT fanout, auth-
 * failure fanout) is owned by `withBatchLifecycle` — ONE instance per batch
 * regardless of worker count. Each worker builds its own observer via
 * `makeObserver('w${index}')` so:
 *
 *   - `authTimings` captured per worker are injected only into items that
 *     worker processes (workers authenticate independently, so timings are
 *     worker-specific and correct for each item).
 *   - `auth_start` / `auth_complete` session events fire once per worker ×
 *     system, all attributed to the same `workflowInstance` but with
 *     distinct `sessionId`s so the dashboard can distinguish Duo lanes.
 *
 * See `src/core/batch-lifecycle.ts` for the shared shell semantics.
 */
export async function runWorkflowPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const poolSize = opts.poolSize ?? wf.config.batch?.poolSize ?? 4

  const perItem: PoolItem<TData>[] = validateAndPrepareItems(wf, items, opts, (item) =>
    wf.config.schema.parse(item),
  )
  const callerPreEmits = callerPreEmitsPending(wf, opts)

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  return withBatchLifecycle(
    {
      workflow: wf.config.name,
      wf,
      archetype: wf.archetype,
      systems: wf.config.systems,
      perItem: perItem.map(({ item, itemId, runId }) => ({
        item,
        itemId,
        runId,
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      })),
      trackerDir: opts.trackerDir,
      trackerStub: opts.trackerStub,
    },
    async ({ instance, markTerminated, makeObserver }) => {
      const queue: PoolItem<TData>[] = [...perItem]

      async function worker(index: number): Promise<void> {
        const logPrefix = `[Pool W${index}]`
        log.step(`${logPrefix} Starting`)
        const { observer, getAuthTimings } = makeObserver(`w${index}`)
        const session = await Session.launch(wf.config.systems, {
          launchFn: opts.launchFn,
          observer,
        })
        await awaitAllSystemsReady(session, wf.config.systems)
        // Per-worker authTimings: each worker's Session.launch produced its
        // own auth start/complete events; items this worker processes get
        // THIS worker's timings (matches reality — one auth per worker).
        const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined
        log.success(`${logPrefix} Session ready`)
        try {
          while (queue.length > 0) {
            const next = queue.shift()
            if (next === undefined) break
            const remaining = queue.length
            log.step(`${logPrefix} Taking item (${remaining} remaining in queue)`)
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
          log.step(`${logPrefix} Queue empty — exiting`)
        } finally {
          await session.close()
        }
      }

      const workerCount = Math.min(poolSize, items.length)
      await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)))
      return result
    },
  )
}
