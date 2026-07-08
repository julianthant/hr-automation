import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import type { Session } from './session.js'
import type { AuthTiming, BatchObserverHandle } from './batch-lifecycle.js'
import { runOneItem } from './run-one-item.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { validateAndPrepareItems, callerPreEmitsPending } from './batch-helpers.js'
import type { PerItem } from './batch-helpers.js'
import { log } from '../../utils/log.js'

/**
 * The per-worker session strategy — the ONLY axis on which the two batch pools
 * differ. `runWorkflowPool` launches a fresh authenticated Session per worker
 * (per-worker Duo isolation); `runWorkflowSharedContextPool` authenticates ONE
 * parent Session and hands each worker a `forWorker` child (one-Duo-many-tabs).
 * Everything else — item validation, the `withBatchLifecycle` shell, the
 * work-stealing `queue.shift()` loop, the result tally, and the worker-failure
 * isolation — lives in `runPooledBatch` so a change there lands once, not twice.
 */
export interface WorkerStrategy {
  /** Acquire (or derive) this worker's session + the authTimings to inject into its items. */
  acquire(index: number): Promise<{ session: Session; authTimings: AuthTiming[] | undefined }>
  /** Release this worker's session (per-worker: `close`; shared-context: `closeWorkerPages`). */
  release(session: Session): Promise<void>
  /** One-time teardown after ALL workers finish (shared-context: `parent.close`). */
  teardown?(): Promise<void>
}

export interface PoolStrategyApi {
  makeObserver: (sessionId: string) => BatchObserverHandle
  instance: string
}

/**
 * Run `items` across up to `poolSize` concurrent workers, sharing the batch
 * lifecycle shell. The session model is injected via `makeStrategy` (see
 * `WorkerStrategy`).
 *
 * Worker-failure isolation (the reason this uses `Promise.allSettled`, not
 * `Promise.all`): a per-worker `Session.launch` / teardown / validation throw
 * must NOT abandon the OTHER workers' in-flight items mid-handler. A PARTIAL
 * failure is logged and the surviving workers keep draining the queue; only
 * when EVERY worker died (e.g. auth down for all) do we rethrow so
 * `withBatchLifecycle`'s catch owns the batch-level failed-row fanout. A
 * single-auth strategy whose ONE auth fails throws from `makeStrategy` (before
 * the workers start) → same batch-level fanout.
 */
export async function runPooledBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts,
  makeStrategy: (api: PoolStrategyApi) => Promise<WorkerStrategy>,
): Promise<BatchResult> {
  const poolSize = opts.poolSize ?? wf.config.batch?.poolSize ?? 4

  const perItem: PerItem<TData>[] = validateAndPrepareItems(wf, items, opts, (item) =>
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
      const strategy = await makeStrategy({ makeObserver, instance })
      const queue: PerItem<TData>[] = [...perItem]

      async function worker(index: number): Promise<void> {
        const { session, authTimings } = await strategy.acquire(index)
        // A worker drains MULTIPLE items off the shared queue on its OWN
        // session (work-stealing `queue.shift()`), so residual per-item
        // browser state (e.g. a stuck Person Profile page) can leak from
        // item N to item N+1 on the SAME worker exactly like sequential
        // mode's item loop — `betweenItems` was previously wired only into
        // `workflow.ts`'s sequential path and silently ignored here. Skipped
        // on each worker's OWN first item (fresh session from `acquire`).
        let firstItem = true
        try {
          while (queue.length > 0) {
            const next = queue.shift()
            if (next === undefined) break
            const { item, itemId, runId } = next
            const betweenItems = wf.config.batch?.betweenItems
            const preHandler = betweenItems && !firstItem
              ? async () => {
                  for (const hook of betweenItems) {
                    if (hook === 'reset') {
                      const t0 = Date.now()
                      await Promise.all(wf.config.systems.map((s) => session.reset(s.id)))
                      log.step(`[Pool W${index}] Reset systems (took ${Date.now() - t0}ms)`)
                    } else if (hook === 'health-check') {
                      const results = await Promise.all(
                        wf.config.systems.map(async (s) => ({ id: s.id, ok: await session.healthCheck(s.id) })),
                      )
                      const failed = results.find((r) => !r.ok)
                      if (failed) throw new Error(`health-check failed for ${failed.id}`)
                    }
                  }
                }
              : undefined
            firstItem = false
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
              preHandler,
            })
            markTerminated(runId)
            if (r.ok) result.succeeded++
            else {
              result.failed++
              result.errors.push({ item, error: r.error })
            }
          }
        } finally {
          await strategy
            .release(session)
            .catch((e) =>
              log.warn(`[Pool W${index}] session release failed: ${e instanceof Error ? e.message : String(e)}`),
            )
        }
      }

      try {
        const workerCount = Math.min(poolSize, items.length)
        const settled = await Promise.allSettled(
          Array.from({ length: workerCount }, (_, i) => worker(i)),
        )
        const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
        // EVERY worker died → a real batch-level failure: let withBatchLifecycle's
        // catch own the failed-row fanout. A PARTIAL failure must NOT abandon the
        // surviving workers' completed items — log and carry the result.
        if (workerCount > 0 && failures.length === workerCount) throw failures[0].reason
        for (const f of failures) {
          log.warn(
            `[Pool] a worker died but siblings completed: ${
              f.reason instanceof Error ? f.reason.message : String(f.reason)
            }`,
          )
        }
      } finally {
        if (strategy.teardown) {
          await strategy
            .teardown()
            .catch((e) => log.warn(`[Pool] teardown failed: ${e instanceof Error ? e.message : String(e)}`))
        }
      }
      return result
    },
  )
}
