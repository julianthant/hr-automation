import type { RegisteredWorkflow, SessionObserver, SystemConfig } from './types.js'
import { emitTrackerRow, type StampedData } from '../../tracker/jsonl.js'
import {
  deriveRowArchetype,
  resolveArchetypeFromValue,
  type WorkflowArchetype,
  type WorkflowArchetypeOrResolver,
} from '../../domain/row-archetype.js'
import { buildPendingTrackerData } from '../pending-data.js'
import {
  generateInstanceName,
  emitWorkflowStart,
  emitWorkflowEnd,
  emitSessionCreate,
  emitBrowserLaunch,
  emitAuthStart,
  emitAuthComplete,
  emitAuthFailed,
} from '../../tracker/session-events.js'
import { buildUcpathIdleHooks } from './ucpath-idle-hooks.js'
import { log } from '../../utils/log.js'

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
 *      session drawer shows the pool/batch instance lighting up as it authenticates.
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
  // Pool mode passes worker-scoped sessionIds (`w0`, `w1`, …) that are NOT
  // pre-registered by `withBatchLifecycle` (which only emits `session_create`
  // for the default batch sessionId `'1'` at line 165). Without a matching
  // `session_create`, `rebuildSessionState` attaches
  // browsers to a phantom session. Lazy-emit it on first `onBrowserLaunch`
  // so per-worker sessions show up correctly. Suppress for `'1'` because the
  // batch-level pre-emit already covered that case.
  let registeredSession = sessionId === '1'

  const observer: SessionObserver = {
    instance,
    onBrowserLaunch: (systemId, browserId, chromiumPid) => {
      if (!registeredSession) {
        emitSessionCreate(instance, sessionId, trackerDir)
        registeredSession = true
      }
      emitBrowserLaunch(instance, sessionId, browserId, systemId, trackerDir, chromiumPid)
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
    ...buildUcpathIdleHooks(instance, trackerDir),
  }

  return {
    observer,
    getAuthTimings: () => timings.slice(),
  }
}

export interface BatchLifecycleOpts<TData = unknown> {
  /** Workflow name — threaded into `generateInstanceName` and tracker rows. */
  workflow: string
  /**
   * Workflow-level archetype — stamped onto the per-item `failed` rows the
   * SIGINT / auth-failure fanout emits. Required so the dashboard's
   * row-archetype resolver gets a stamped value even on synthetic terminal
   * rows. Accepts a literal or a resolver function; resolver form is
   * evaluated per-item against `perItem[i].item`.
   */
  archetype: WorkflowArchetypeOrResolver<TData>
  /**
   * Workflow definition — passed so the SIGINT / auth-failure fanout can
   * build rich `data` (operatorSubject, getName/getId, queue title) for
   * each synthetic failed row. Without this the row carries only
   * `{ archetype }` and the dashboard's dedupe surfaces a nameless
   * cancelled card. Optional only for back-compat with tests that omit
   * it; production callers always supply it.
   */
  wf?: RegisteredWorkflow<TData, readonly string[]>
  /** Systems the workflow will authenticate — used to attribute the auth-
   * failure fanout step (e.g. `auth:ucpath`) when the body throws before any
   * item finishes. Optional for tests that never trigger auth-failure. */
  systems?: SystemConfig[]
  /** Every item the batch will process. The helper uses this list to fan out
   * `failed` tracker rows on SIGINT / auth failure. Terminal states are
   * signalled via `markTerminated(runId)`. Daemon mode passes an empty
   * array — items arrive dynamically, and in-flight state is tracked by
   * the daemon loop itself. `parentRunId` (when set) flows onto the
   * synthetic `failed` row so archetype derivation produces the right
   * `delegate-child` / `passive-child` shape. */
  perItem: Array<{ item: unknown; itemId: string; runId: string; parentRunId?: string }>
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

  // Build a rich data record for each synthetic failed row so the dashboard
  // dedupe doesn't surface a nameless cancelled card. Use the same
  // buildPendingTrackerData seed the normal pending emit uses (with
  // `nameIdStamp: 'always-on-seed'` to force __name/__id stamping even when
  // the workflow's getName/getId can't extract them from the input alone).
  const buildRowData = (item: unknown, parentRunId: string | undefined): StampedData => {
    const concreteArchetype: WorkflowArchetype =
      typeof opts.archetype === 'function'
        ? resolveArchetypeFromValue(opts.archetype, item as TData, opts.workflow)
        : opts.archetype
    const archetype = deriveRowArchetype(concreteArchetype, parentRunId)
    if (!opts.wf) {
      return { archetype }
    }
    try {
      const data = buildPendingTrackerData({
        workflow: opts.wf,
        input: item as TData,
        useInitialTrackerSeed: true,
        nameIdStamp: 'always-on-seed',
        parentRunId,
      })
      return data
    } catch (err) {
      // Bad shape (e.g. input failed schema for stamping helpers) — fall
      // back to the minimal stamp so the failed row still lands. Surface
      // the underlying error first: this fallback reproduces the very
      // "nameless cancelled card" pathology that Bug 9 added the rich-row
      // emission to prevent, so a silent swallow hides regressions. Warn
      // loud and keep moving.
      log.warn(
        `[batch-lifecycle] buildRowData fallback for ${opts.wf?.config.name ?? '<unknown>'}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return { archetype }
    }
  }
  const fanoutFailed = (errorMessage: string, step?: string): void => {
    const now = new Date().toISOString()
    for (const { item, itemId, runId, parentRunId } of opts.perItem) {
      if (terminated.has(runId)) continue
      terminated.add(runId)
      emitTrackerRow(
        {
          workflow: opts.workflow,
          timestamp: now,
          id: itemId,
          runId,
          status: 'failed',
          ...(parentRunId ? { parentRunId } : {}),
          ...(step ? { step } : {}),
          data: buildRowData(item, parentRunId),
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
