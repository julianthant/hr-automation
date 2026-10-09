import type { RegisteredWorkflow, BatchResult, RunOpts } from './types.js'
import { Session } from './session.js'
import { awaitAllSystemsReady } from './batch-helpers.js'
import { runPooledBatch } from './pool-core.js'
import { log } from '../../utils/log.js'

/**
 * Run N items across N workers, each with its OWN authenticated Session.
 * Use when per-worker auth isolation matters (e.g. onboarding: each worker
 * needs its own Duo-authenticated Kronos tab because tabs can't be shared).
 *
 * The batch shell (instance allocation, workflow_start/end, SIGINT/auth-failure
 * fanout, the work-stealing queue loop, and worker-failure isolation) is owned
 * by `runPooledBatch`; this function supplies only the per-worker session
 * strategy. Each worker builds its own observer via `makeObserver('w${index}')`
 * so:
 *
 *   - `authTimings` captured per worker are injected only into items that
 *     worker processes (workers authenticate independently, so timings are
 *     worker-specific and correct for each item).
 *   - `auth_start` / `auth_complete` session events fire once per worker ×
 *     system, all attributed to the same `workflowInstance` but with
 *     distinct `sessionId`s so the dashboard can distinguish Duo lanes.
 */
export async function runWorkflowPool<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  return runPooledBatch(wf, items, opts, async ({ makeObserver }) => ({
    async acquire(index: number) {
      const logPrefix = `[Pool W${index}]`
      log.step(`${logPrefix} Starting`)
      const { observer, getAuthTimings } = makeObserver(`w${index}`)
      const session = await Session.launch(wf.config.systems, {
        launchFn: opts.launchFn,
        observer,
      })
      // A worker whose every system failed to authenticate fails cleanly here
      // (rather than draining the queue against dead pages); a partial failure
      // proceeds on the systems it has. Close this worker's own session on the
      // throw — acquire runs before runPooledBatch's release finally, so the
      // launched browser would otherwise leak.
      try {
        await awaitAllSystemsReady(session, wf.config.systems, { throwIfAllFailed: true })
      } catch (e) {
        await session.close().catch(() => {})
        throw e
      }
      // Per-worker authTimings: each worker's Session.launch produced its own
      // auth start/complete events; items this worker processes get THIS
      // worker's timings (matches reality — one auth per worker).
      const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined
      log.success(`${logPrefix} Session ready`)
      return { session, authTimings }
    },
    release: (session) => session.close(),
  }))
}
