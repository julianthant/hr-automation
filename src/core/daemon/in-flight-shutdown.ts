/**
 * Shared reassign / fail-in-flight helpers for daemon teardown.
 *
 * Two places decide what happens to a daemon's IN-FLIGHT item when the daemon
 * stops: the claim-loop `isCancelOutcome` branch (`daemon.ts`) and the
 * outer-finally safety-net sweep (`runDaemonShutdownCleanup` in `shutdown.ts`).
 * Before this module they mirrored ~120 lines apiece — the same
 * `returnTaskToQueued` + re-emit-pending reassign block, the same
 * `markItemFailed` + emit-failed fail block, and the same copy-pasted fail
 * string. Drift between them is a correctness hazard (the two paths must agree
 * on row shape, error text, and dependency-settle behavior), so the logic
 * lives here once.
 *
 * These are a PURE extraction — the row shapes, error strings, and
 * dependency-settle calls are byte-for-byte what the two call sites emitted
 * before. Nothing here decides reassign-vs-fail; the caller does (it owns the
 * peer health-check + the three-way intent branch). These helpers only execute
 * a decision the caller already made.
 */
import type { RegisteredWorkflow } from '../kernel/types.js'
import { log } from '../../utils/log.js'
import { wakeDaemons, wakeDaemonsForReleasedParents } from './client.js'
import { markItemFailed } from './queue.js'
import { emitTrackerRow, type StampedData } from '../../tracker/jsonl.js'
import { buildHttpPendingData, buildTrackerDataForInput } from './enqueue-dispatch.js'
import { deriveRowArchetype, resolveArchetype } from '../../domain/row-archetype.js'
import { findFrozenTraceId } from '../../tracker/find-latest-entry.js'
import type { ControlTaskStore } from '../task-store/index.js'
import type { Daemon } from './types.js'

export interface ShutdownTrackerDataOpts {
  /**
   * The run's id. When provided, the frozen `data.__traceId` from this run's
   * pending row is carried forward onto the rebuilt cancelled/shutdown row.
   * The trace id is stamped once at pre-emit and embeds the original
   * timestamp, so it cannot be regenerated from `input` here — rebuilding
   * would mint a *different* id than the pending row displayed. Cancellation
   * must change status only, never the row's trace-id identity, so we inherit
   * the value instead of dropping it.
   */
  runId?: string
  trackerDir?: string
}

/**
 * Rebuild a cancelled/shutdown row's `data` from `input`. Reproduces
 * name/EID/archetype/queueRowKind and always stamps `data.archetype` (via
 * `buildHttpPendingData` or its minimal fallback). Lives here (not `shutdown.ts`)
 * so the in-flight helpers can use it without a module cycle; `shutdown.ts`
 * re-exports it for its other callers.
 */
export function buildShutdownTrackerData<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: unknown,
  parentRunId?: string,
  opts?: ShutdownTrackerDataOpts,
): Record<string, string> {
  let data: Record<string, string>
  try {
    data = buildHttpPendingData(wf, input, parentRunId)
  } catch (err) {
    log.warn(
      `[Daemon ${wf.config.name}] buildShutdownTrackerData fell back to minimal stamp: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    data = buildTrackerDataForInput(input)
    data.archetype = deriveRowArchetype(
      resolveArchetype(wf.config, input as TData),
      parentRunId,
    )
  }
  preserveFrozenTraceId(data, wf.config.name, opts)
  return data
}

/**
 * Carry the frozen `data.__traceId` from the run's pending row onto a rebuilt
 * cancelled/shutdown row. `buildShutdownTrackerData` re-derives display fields
 * from `input`, which reproduces name/EID/archetype/queueRowKind but NOT the
 * trace id (it embeds the original pre-emit timestamp). Without this, a
 * cancelled row would lose the trace-id subtitle/hover it showed while
 * pending — cancellation would silently mutate row identity, not just status.
 */
function preserveFrozenTraceId(
  data: Record<string, string>,
  workflow: string,
  opts: ShutdownTrackerDataOpts | undefined,
): void {
  if (!opts?.runId || data.__traceId) return
  const priorTraceId = findFrozenTraceId({
    workflow,
    runId: opts.runId,
    ...(opts.trackerDir ? { trackerDir: opts.trackerDir } : {}),
  })
  if (priorTraceId) data.__traceId = priorTraceId
}

/**
 * Canonical fail reason for "the daemon stopped and no daemon can finish this
 * item." Was copy-pasted verbatim in both call sites; centralized so the
 * operator-facing wording can't drift.
 */
export const SHUTDOWN_NO_DAEMON_FAIL_REASON =
  'Daemon stopped and no other daemon is available to finish this item.'

/**
 * Fail reason for the wedged-peer case: reassign was requested and a peer
 * LOOKED alive (PID + lockfile) but none answered `/whoami`, so we fail loud
 * instead of parking the item on a daemon that will never claim it (F5).
 */
export const SHUTDOWN_NO_RESPONSIVE_PEER_FAIL_REASON =
  'Daemon stopped and no responsive peer daemon was available to finish this item.'

/** Identity of the in-flight item being terminalized/reassigned. */
export interface InFlightShutdownItem {
  itemId: string
  runId: string
  taskId?: string
  input?: unknown
  parentRunId?: string
}

/**
 * Emit a tracker row for a shutdown-rebuilt item. Wraps the repeated
 * `emitTrackerRow({ ... data: buildShutdownTrackerData(...) as StampedData,
 * ...(parentRunId ? { parentRunId } : {}) })` block. `buildShutdownTrackerData`
 * always stamps `data.archetype`, so the cast to `StampedData` is sound at
 * runtime.
 */
export function emitShutdownRow<TData, TSteps extends readonly string[]>(args: {
  wf: RegisteredWorkflow<TData, TSteps>
  item: InFlightShutdownItem
  status: 'pending' | 'failed'
  step?: string
  error?: string
  trackerDir: string | undefined
  timestamp?: string
}): void {
  const { wf, item, status, step, error, trackerDir } = args
  emitTrackerRow(
    {
      workflow: wf.config.name,
      timestamp: args.timestamp ?? new Date().toISOString(),
      id: item.itemId,
      runId: item.runId,
      status,
      ...(step ? { step } : {}),
      data: buildShutdownTrackerData(wf, item.input, item.parentRunId, {
        runId: item.runId,
        trackerDir,
      }) as StampedData,
      ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
      ...(error ? { error } : {}),
    },
    trackerDir,
  )
}

/**
 * Reassign an in-flight item back to the queue for a RESPONSIVE peer to finish.
 * Un-claims the task (preserving the attempt/runId so the run continues under
 * the same id on the new daemon), re-emits a `pending` row so the dashboard
 * shows it back in queue, and wakes the responsive peers. No terminal row, no
 * dependency settle — the work isn't done, just moving. Best-effort: if the
 * re-queue throws, the item stays claimed and a peer's dead-worker recovery
 * sweep re-queues it.
 *
 * Caller must have already confirmed `item.taskId` is set and `responsivePeers`
 * is non-empty.
 */
export async function reassignInFlightItem<TData, TSteps extends readonly string[]>(args: {
  wf: RegisteredWorkflow<TData, TSteps>
  item: InFlightShutdownItem & { taskId: string }
  responsivePeers: Daemon[]
  taskStore: ControlTaskStore
  trackerDir: string | undefined
  /** Log prefix, e.g. `Daemon <wf>/<instanceId>` or `Daemon <instanceId>`. */
  logTag: string
}): Promise<void> {
  const { wf, item, responsivePeers, taskStore, trackerDir, logTag } = args
  try {
    taskStore.returnTaskToQueued({ taskId: item.taskId })
    emitShutdownRow({ wf, item, status: 'pending', trackerDir })
    await wakeDaemons(responsivePeers)
    log.step(
      `[${logTag}] per-instance stop — reassigned in-flight item ${item.itemId} to ${responsivePeers.length} responsive daemon(s)`,
    )
  } catch {
    /* best-effort — dead-worker recovery on a peer re-queues it */
  }
}

/**
 * Fail an in-flight item loudly (terminal red row, retriable — NO
 * `step:"cancelled"` sentinel). Marks the queue item failed, settles the
 * dependency edge to the parent (when the item is a delegated child), and emits
 * the failed tracker row.
 *
 * Two flags keep the call sites' exact prior semantics:
 *  - `bestEffort` — the `shutdown.ts` outer-finally sweep runs in the SIGINT
 *    grace window and wrapped each step in its own try/catch (`bestEffort:
 *    true`); the `daemon.ts` claim-loop branch let `markItemFailed` / the row
 *    emit throw (`bestEffort` omitted).
 *  - `settleDependency` — the `daemon.ts` claim-loop fail branches settle the
 *    delegated-child dependency edge (`markDependencyFromChildTerminal`); the
 *    `shutdown.ts` in-flight fail branches deliberately did NOT (only the
 *    QUEUED-item sweep settled dependencies). Defaults to true; pass false to
 *    match the shutdown in-flight path.
 */
export async function failInFlightItem<TData, TSteps extends readonly string[]>(args: {
  wf: RegisteredWorkflow<TData, TSteps>
  item: InFlightShutdownItem
  failReason: string
  taskStore: ControlTaskStore
  trackerDir: string | undefined
  /** Pre-resolved ISO timestamp shared by markItemFailed + the row. */
  timestamp?: string
  /** When true, swallow errors from both the mark + the emit (shutdown sweep). */
  bestEffort?: boolean
  /** When false, skip the child-dependency settle (shutdown in-flight path). */
  settleDependency?: boolean
  /**
   * Terminal-write guard (E2E-101 / E2E-105). When provided, called to claim
   * the run's single terminal-row write: the `failed` row is emitted ONLY when
   * it returns `true`. If a prior emitter (the kernel's `withTrackedWorkflow`
   * catch on a signal-only-wait abort) already terminalized this run, the
   * callback returns `false` and this defers — no duplicate terminal row. The
   * task is STILL marked failed + dependencies settled regardless (the SQLite
   * control truth must reflect the failure even when the tracker row already
   * exists). Absent → emit unconditionally (callers without a per-run registry
   * context, e.g. the queued-item sweep, pass nothing).
   */
  claimTerminalWrite?: () => boolean
}): Promise<void> {
  const { wf, item, failReason, taskStore, trackerDir, bestEffort, claimTerminalWrite } = args
  const settleDependency = args.settleDependency ?? true
  const nowIso = args.timestamp ?? new Date().toISOString()
  const markAndSettle = async (): Promise<void> => {
    await markItemFailed(wf.config.name, item.itemId, failReason, item.runId, trackerDir)
    if (settleDependency && item.taskId) {
      const released = taskStore.markDependencyFromChildTerminal({
        childTaskId: item.taskId,
        childState: 'failed',
      })
      // A failed child can be a released cross-workflow parent's LAST pending
      // dependency — wake that parent's daemons like every other settle site
      // (E2E-017), or it sits queued until its 15-min keepalive tick.
      void wakeDaemonsForReleasedParents(released, trackerDir)
    }
  }
  // Claim the single terminal-row token (E2E-101). The mark/settle below still
  // runs so SQLite reflects the failure; only the tracker ROW emit is gated.
  const shouldEmitRow = claimTerminalWrite ? claimTerminalWrite() : true
  if (bestEffort) {
    try {
      await markAndSettle()
    } catch {
      /* best-effort — queue event append; tracker row below is the user-visible signal */
    }
    if (shouldEmitRow) {
      try {
        emitShutdownRow({ wf, item, status: 'failed', error: failReason, trackerDir, timestamp: nowIso })
      } catch {
        /* best-effort */
      }
    }
    return
  }
  await markAndSettle()
  if (shouldEmitRow) {
    emitShutdownRow({ wf, item, status: 'failed', error: failReason, trackerDir, timestamp: nowIso })
  }
}
