import type { SessionObserver, SystemConfig } from './types.js'
import { trackEvent } from '../tracker/jsonl.js'
import {
  generateInstanceName,
  emitWorkflowStart,
  emitWorkflowEnd,
  emitSessionCreate,
  emitBrowserLaunch,
  emitAuthStart,
  emitAuthComplete,
  emitAuthFailed,
} from '../tracker/session-events.js'

/**
 * Per-system auth duration captured by `createBatchObserver`. `startTs` and
 * `endTs` are `Date.now()` values (ms since epoch). `runOneItem` converts
 * `startTs` into an ISO timestamp and emits a synthetic `running` tracker
 * entry per item so `computeStepDurations` tiles the auth window correctly.
 */
export interface AuthTiming {
  systemId: string
  startTs: number
  endTs: number
}

/**
 * What `createBatchObserver` returns: a `SessionObserver` ready to hand to
 * `Session.launch`, plus a `getAuthTimings()` snapshot of the start/complete
 * pairs observed so far. Callers snapshot *after* `Session.launch` resolves
 * and thread the array into every `runOneItem` in the batch.
 */
export interface BatchObserverHandle {
  observer: SessionObserver
  getAuthTimings: () => AuthTiming[]
}

/**
 * Build an observer that:
 *   1. Records per-system auth start/complete timestamps into an internal
 *      `AuthTiming[]` exposed via `getAuthTimings()`. `onAuthFailed` also
 *      records a timing so the dashboard still sees a chip for a failed
 *      auth attempt.
 *   2. Emits `auth_start` / `auth_complete` / `auth_failed` / `browser_launch`
 *      session events attributed to `instance` + `sessionId`, so the dashboard
 *      SessionPanel shows the pool/batch instance lighting up as it authenticates.
 *
 * Note: `SessionObserver.onBrowserLaunch` emits the session event but has no
 * timing component — the observer only pairs auth lifecycles.
 */
export function createBatchObserver(
  instance: string,
  sessionId: string,
  trackerDir?: string,
): BatchObserverHandle {
  const timings: AuthTiming[] = []
  // Pending starts keyed by systemId (since there's at most one in-flight auth
  // per system in a given Session.launch). `Session.launch` calls onAuthStart
  // exactly once per system even under retries — retries stay inside
  // `loginWithRetry` — so this map stays tidy.
  const pendingStart = new Map<string, number>()

  const observer: SessionObserver = {
    instance,
    onBrowserLaunch: (systemId, browserId) => {
      emitBrowserLaunch(instance, sessionId, browserId, systemId, trackerDir)
    },
    onAuthStart: (systemId, browserId) => {
      pendingStart.set(systemId, Date.now())
      emitAuthStart(instance, browserId, systemId, trackerDir)
    },
    onAuthComplete: (systemId, browserId) => {
      const startTs = pendingStart.get(systemId) ?? Date.now()
      pendingStart.delete(systemId)
      timings.push({ systemId, startTs, endTs: Date.now() })
      emitAuthComplete(instance, browserId, systemId, trackerDir)
    },
    onAuthFailed: (systemId, browserId) => {
      const startTs = pendingStart.get(systemId) ?? Date.now()
      pendingStart.delete(systemId)
      timings.push({ systemId, startTs, endTs: Date.now() })
      emitAuthFailed(instance, browserId, systemId, trackerDir)
    },
  }

  return {
    observer,
    getAuthTimings: () => timings.slice(),
  }
}

export interface BatchLifecycleOpts<TData> {
  /** Workflow name — threaded into `generateInstanceName` and tracker rows. */
  workflow: string
  /** Systems the workflow will authenticate — used to attribute the auth-
   * failure fanout step (e.g. `auth:ucpath`) when the body throws before any
   * item finishes. Optional for tests that never trigger auth-failure. */
  systems?: SystemConfig[]
  /** Every item the batch will process. The helper uses this list to fan out
   * `failed` tracker rows on SIGINT / auth failure. Terminal states are
   * signalled via `markTerminated(runId)`. Daemon mode passes an empty
   * array — items arrive dynamically, and in-flight state is tracked by
   * the daemon loop itself. */
  perItem: Array<{ item: unknown; itemId: string; runId: string }>
  /** Tracker directory override — defaults to `.tracker` via DEFAULT_DIR. */
  trackerDir?: string
  /**
   * Default `true`: install our own SIGINT handler that fans out `failed`
   * rows for every non-terminated `perItem` entry and calls
   * `process.exit(130)`. Pass `false` when the caller (e.g. daemon mode)
   * owns SIGINT and needs to run its own cleanup — unclaim in-flight
   * queue items, close browsers, unlink lockfiles — before exiting. When
   * `false`, the body is still wrapped in the try/catch that writes
   * `failed` rows on thrown errors; only the signal listener is skipped.
   */
  ownSigint?: boolean
}

export interface BatchLifecycleCtx {
  /** Allocated workflow instance name (e.g. "EID Lookup 3"). */
  instance: string
  /** Signal that a specific runId has reached a terminal state so the SIGINT
   * / auth-failure fanout skips it. Safe to call multiple times per runId. */
  markTerminated: (runId: string) => void
  /** Build an observer + authTimings handle scoped to the same batch
   * instance. Pool-mode passes a unique `sessionId` per worker so the dash
   * sees multiple Duo lanes; shared-context-pool / sequential use `'1'`. */
  makeObserver: (sessionId: string) => BatchObserverHandle
}

/**
 * Shared lifecycle shell for every batch runner. It handles:
 *
 *   1. **Instance allocation** via `generateInstanceName` (which self-heals
 *      dead-pid orphans — see session-events.ts).
 *   2. **`workflow_start` + `session_create`** emitted ONCE at the start.
 *   3. **SIGINT handling**: writes a `failed` tracker row for every runId
 *      that hasn't called `markTerminated`, emits `workflow_end(failed)`,
 *      then `process.exit(130)`.
 *   4. **Auth-failure fanout**: if `body` throws BEFORE any `markTerminated`
 *      call, treat it as an auth-phase failure. Every per-item runId gets a
 *      `failed` row with `step: auth:<firstSystem>` so the dashboard shows
 *      the right chip. `workflow_end(failed)` is emitted, then the error
 *      rethrows.
 *   5. **Happy-path close**: if `body` resolves, emit `workflow_end(done)`.
 *   6. **Handler deregistration**: always remove the SIGINT handler in
 *      `finally` so tests / long-lived parents don't accumulate listeners.
 *
 * Callers supply `body` which receives a `ctx` object containing the
 * `instance` name, `markTerminated`, and a `makeObserver` factory. The body
 * is responsible for (a) launching its Session(s), (b) processing items via
 * `runOneItem` with the returned `preAssignedInstance` + `authTimings`, and
 * (c) calling `markTerminated(runId)` after each item reaches done/failed.
 *
 * Design note: we intentionally don't wrap `Session.launch` inside the helper
 * because `pool` mode launches one Session per worker and `sequential` /
 * `shared-context-pool` launch one at batch scope. Putting Session.launch in
 * the helper would couple it to browser lifecycle which limits reuse.
 */
export async function withBatchLifecycle<TData, R>(
  opts: BatchLifecycleOpts<TData>,
  body: (ctx: BatchLifecycleCtx) => Promise<R>,
): Promise<R> {
  const instance = generateInstanceName(opts.workflow, opts.trackerDir)
  emitWorkflowStart(instance, opts.trackerDir)
  emitSessionCreate(instance, '1', opts.trackerDir)

  const terminated = new Set<string>()
  const markTerminated = (runId: string): void => {
    terminated.add(runId)
  }

  let workflowClosed = false
  const closeWorkflow = (status: 'done' | 'failed'): void => {
    if (workflowClosed) return
    workflowClosed = true
    emitWorkflowEnd(instance, status, opts.trackerDir)
  }

  const fanoutFailed = (errorMessage: string, step?: string): void => {
    const now = new Date().toISOString()
    for (const { itemId, runId } of opts.perItem) {
      if (terminated.has(runId)) continue
      terminated.add(runId)
      trackEvent(
        {
          workflow: opts.workflow,
          timestamp: now,
          id: itemId,
          runId,
          status: 'failed',
          ...(step ? { step } : {}),
          error: errorMessage,
        },
        opts.trackerDir,
      )
    }
  }

  const ownSigint = opts.ownSigint !== false
  const sigintHandler: (() => void) | null = ownSigint
    ? (): void => {
        fanoutFailed('Process terminated (SIGINT)')
        closeWorkflow('failed')
        process.exit(130)
      }
    : null
  if (sigintHandler) process.on('SIGINT', sigintHandler)

  const makeObserver = (sessionId: string): BatchObserverHandle =>
    createBatchObserver(instance, sessionId, opts.trackerDir)

  try {
    const result = await body({ instance, markTerminated, makeObserver })
    closeWorkflow('done')
    return result
  } catch (err) {
    // Every un-terminated item needs a failed tracker row or the dashboard
    // leaves them hanging. Attribution differs by how much progress was made:
    //
    //   - `noProgress` (no item reached terminal) → the body threw before
    //     items could run, which is almost always an auth-phase failure
    //     (e.g. `Session.launch` threw on Duo denial). Stamp the step as
    //     `auth:<firstSystem>` so the dashboard chip points at the right
    //     layer.
    //   - otherwise → post-auth throw (unlikely; per-item throws are caught
    //     inside `runOneItem`). Write failed rows without a step so the
    //     dashboard shows them as "failed before any step ran" instead of
    //     misattributing to auth.
    const noProgress = terminated.size === 0
    const errorMessage = err instanceof Error ? err.message : String(err)
    const firstSystem = opts.systems?.[0]?.id
    fanoutFailed(
      noProgress ? `Auth failed: ${errorMessage}` : errorMessage,
      noProgress && firstSystem ? `auth:${firstSystem}` : undefined,
    )
    closeWorkflow('failed')
    throw err
  } finally {
    if (sigintHandler) process.off('SIGINT', sigintHandler)
  }
}
