import type { Session } from '../kernel/session.js'
import type { ControlWorkerStore } from './worker-store.js'
import type { RunHandle } from '../run-registry.js'

/**
 * Daemon lifecycle phases — exposed via /status so CLI callers and
 * `npm run daemon-attach` can see what the daemon is doing at any moment.
 * Helps diagnose "browsers don't launch" (stuck in `authenticating`) vs
 * "queue isn't processing" (stuck in `idle` with queueDepth > 0) vs
 * "healthCheck hung" (stuck in `keepalive`).
 */
export type DaemonPhase =
  | 'launching'      // before session.launch
  | 'authenticating' // during session.launch + per-system page() waits
  | 'idle'           // claim loop, no item in flight
  | 'processing'     // runOneItem in progress
  | 'keepalive'      // 15min idle tick: healthCheck + orphan recovery
  | 'draining'       // shutdown, finishing in-flight teardown
  | 'exited'         // terminal

/**
 * Lightweight read-only projection of the in-flight `RunHandle` for HTTP
 * `/status` consumers and the worker heartbeat. Mirrors the legacy
 * `DaemonInFlight` shape so dashboards + tests don't need to unwrap a
 * full `RunHandle` (which carries an AbortController + Session reference).
 */
export type DaemonInFlight = { itemId: string; runId: string; taskId?: string; attemptId?: string }

export interface DaemonState {
  wakeResolve: (() => void) | null
  shutdownResolve: (() => void) | null
  /**
   * Latch for a `/wake` that arrived while no idle waiter was armed (ISS-008).
   * `resolveWake` (HTTP `/wake`) calls `state.wakeResolve?.()` — a NO-OP whenever
   * the claim loop is NOT parked (suspended at a top-of-iteration await, mid-
   * processing, or in the synchronous window between `claimNextItem` returning
   * null and the idle-wait arming its waiters). A wake dropped in that window
   * would otherwise be lost until the 15-min keepalive tick. Setting this flag
   * instead lets the loop's check-before-park guard observe + consume it and
   * re-claim immediately. Set true by `resolveWake` when `wakeResolve` is null;
   * cleared when the park guard consumes it.
   */
  wakePending: boolean
  forceShutdown: boolean
  drainOnlyShutdown: boolean
  shuttingDown: boolean
  /**
   * Per-instance stop with reassignment intent. Set true ONLY by the daemon
   * `/stop` handler when the caller passes `{ reassign: true }` — i.e. the
   * dashboard session-card per-instance stop. When true AND another daemon
   * for this workflow is still alive at teardown, the in-flight item is
   * un-claimed (`returnTaskToQueued`) and the peers are woken so an idle one
   * finishes it, instead of being terminalized. Stays false for workflow-
   * scoped "stop all", SIGINT/SIGTERM, and `/cancel-current` — those fail the
   * in-flight item (no spare to hand off to, or the user cancelled that one
   * item specifically). The fail-vs-reassign decision also requires a live
   * peer; a per-instance stop of the LAST daemon still fails the item.
   */
  reassignInFlight: boolean
  /**
   * The unified handle for the currently in-flight item — the daemon's
   * single source of truth for "what's running and how do I cancel it"
   * (Contract 5 Phase 1). Collapses three legacy fields:
   *
   *   - `state.inFlight` (the `{ itemId, runId, taskId?, attemptId? }`
   *     tuple) → derived as `daemonInFlight(activeRun)`
   *   - `state.cancelTarget` (the cooperative-cancel flag the stepper
   *     between-step probe consulted) → replaced by
   *     `activeRun.controller.signal.aborted`
   *   - `state.currentRunController` (the per-run AbortController the
   *     cancel paths aborted) → now `activeRun.controller`
   *
   * Set in lockstep with `runRegistry.register(handle)` on item claim;
   * cleared in lockstep with `runRegistry.unregister(handle.runId)` in
   * the per-item finally. The registry's `list()` view is the global
   * source of truth (shutdown sweeps + the HTTP /cancel-current route
   * use it); `state.activeRun` is the daemon's local fast-path reference.
   */
  activeRun: RunHandle | null
  queueDepthCache: number
  lastActivity: number
  phase: DaemonPhase
  activeSession: Session | null
  launchAbort: AbortController
  workerStore: ControlWorkerStore | null
  exitError: unknown
  workflowInstanceForCleanup: string | null
}

/**
 * Build the legacy `DaemonInFlight` projection from the active `RunHandle`.
 * Centralized so HTTP status, worker heartbeat, and shutdown sweep all
 * derive the same shape from one source.
 */
export function daemonInFlight(handle: RunHandle | null): DaemonInFlight | null {
  if (!handle) return null
  return {
    itemId: handle.itemId,
    runId: handle.runId,
    ...(handle.taskId ? { taskId: handle.taskId } : {}),
    ...(handle.attemptId ? { attemptId: handle.attemptId } : {}),
  }
}
