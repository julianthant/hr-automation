import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { awaitAllSystemsReady } from './batch-helpers.js'
import { runPooledBatch } from './pool-core.js'

/**
 * Run N workflow items concurrently against a SINGLE authenticated Session:
 * one browser + context per system (one Duo per system), N per-worker Pages
 * spawned lazily from each system's BrowserContext via `Session.forWorker`.
 * Each item gets its own `withTrackedWorkflow` envelope via the shared
 * `runOneItem`, so the dashboard shows one row per item with its own timing.
 *
 * The batch shell (instance allocation, lifecycle events, fanout, the
 * work-stealing queue loop, worker-failure isolation) is owned by
 * `runPooledBatch`. This supplies the shared-Session strategy: ONE observer
 * (`sessionId: '1'`) + ONE `Session.launch` (so only one authenticated Session
 * exists for the whole batch), each worker getting a `forWorker` child, and a
 * `teardown` that closes the parent after all workers finish.
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
  return runPooledBatch(wf, items, opts, async ({ makeObserver }) => {
    const { observer, getAuthTimings } = makeObserver('1')
    const parent = await Session.launch(wf.config.systems, {
      launchFn: opts.launchFn,
      observer,
    })
    // The single auth: if EVERY system failed, throw here (before any worker
    // starts) so withBatchLifecycle's catch fans out the batch-level failure.
    // Close the parent on the throw — teardown is only registered once this
    // strategy is returned, so an all-failed auth would otherwise leak it.
    try {
      await awaitAllSystemsReady(parent, wf.config.systems, { throwIfAllFailed: true })
    } catch (e) {
      await parent.close().catch(() => {})
      throw e
    }
    // Snapshot authTimings AFTER every system is ready so every onAuthComplete
    // has fired. Shared across every runOneItem call — all items ran through
    // the one parent Session's auth.
    const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

    return {
      acquire: async () => ({ session: Session.forWorker(parent), authTimings }),
      release: (session) => session.closeWorkerPages(),
      teardown: () => parent.close(),
    }
  })
}
