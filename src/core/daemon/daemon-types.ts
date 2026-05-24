import type { Session } from '../kernel/session.js'
import type { ControlWorkerStore } from './worker-store.js'

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

export type DaemonInFlight = { itemId: string; runId: string; taskId?: string; attemptId?: string }

export interface DaemonState {
  wakeResolve: (() => void) | null
  shutdownResolve: (() => void) | null
  forceShutdown: boolean
  drainOnlyShutdown: boolean
  shuttingDown: boolean
  inFlight: DaemonInFlight | null
  queueDepthCache: number
  lastActivity: number
  phase: DaemonPhase
  activeSession: Session | null
  launchAbort: AbortController
  workerStore: ControlWorkerStore | null
  exitError: unknown
  cancelTarget: { itemId: string; runId: string } | null
  /**
   * The per-run `AbortController` `runOneItem` constructed for the
   * currently in-flight item (Contract 5). The daemon's `cancel_task`
   * command handler and the HTTP `/cancel-current` route both call
   * `.abort()` on this so any in-flight Playwright work rejects within ms
   * via the signal injected by `ctx.page(id)`'s proxy — uniform fast
   * cancel without killing chrome.
   *
   * Cleared in the daemon claim loop alongside `cancelTarget` after each
   * item finishes; remains `null` between items so a late command can't
   * abort the next item by accident.
   */
  currentRunController: AbortController | null
  workflowInstanceForCleanup: string | null
}
