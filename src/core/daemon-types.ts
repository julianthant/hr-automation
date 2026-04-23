/**
 * Daemon-mode type surface. See docs/superpowers/specs/2026-04-22-workflow-daemon-mode-design.md
 * for the full design rationale.
 */

/**
 * On-disk shape of a daemon lockfile. Written atomically via tmp + rename.
 * One file per alive daemon at `.tracker/daemons/{workflow}-{instanceId}.lock.json`.
 */
export interface DaemonLockfile {
  workflow: string
  /** Short random hex per daemon, e.g. "sep-4a8e". Distinct per process. */
  instanceId: string
  pid: number
  /** HTTP listener port (from `server.address()`). */
  port: number
  startedAt: string
  hostname: string
  version: 1
}

/**
 * Hydrated daemon after liveness probe passes. Includes lockfile path for
 * cleanup when the daemon exits or is observed dead.
 */
export interface Daemon {
  workflow: string
  instanceId: string
  pid: number
  port: number
  startedAt: string
  lockfilePath: string
}

/**
 * Shared-queue JSONL event shapes. Latest event per `id` wins during fold.
 * File path: `.tracker/daemons/{workflow}.queue.jsonl`.
 */
export type QueueEvent =
  | {
      type: 'enqueue'
      id: string
      workflow: string
      input: unknown
      enqueuedAt: string
      enqueuedBy: string
      /**
       * Optional pre-assigned runId. When set, the claiming daemon reuses
       * this runId in its claim event + all downstream tracker rows instead
       * of generating a fresh UUID. Lets the CLI pre-emit a `pending` tracker
       * row at enqueue time without risking two rows per item.
       */
      runId?: string
    }
  | {
      type: 'claim'
      id: string
      claimedBy: string
      claimedAt: string
      runId: string
    }
  | {
      type: 'unclaim'
      id: string
      reason: 'recovered' | 'sigint-soft' | 'voluntary'
      ts: string
    }
  | {
      type: 'done'
      id: string
      completedAt: string
      runId: string
    }
  | {
      type: 'failed'
      id: string
      failedAt: string
      runId: string
      error: string
    }

/** A queue item in its current folded state. */
export interface QueueItem {
  id: string
  workflow: string
  input: unknown
  enqueuedAt: string
  state: 'queued' | 'claimed' | 'done' | 'failed'
  claimedBy?: string
  claimedAt?: string
  completedAt?: string
  failedAt?: string
  runId?: string
  error?: string
}

/** Output of `readQueueState`. */
export interface QueueState {
  queued: QueueItem[]
  claimed: QueueItem[]
  done: QueueItem[]
  failed: QueueItem[]
}

/** CLI flags that drive daemon spawn decisions. */
export interface DaemonFlags {
  new?: boolean
  parallel?: number
}

/** Result of `ensureDaemonsAndEnqueue`. */
export interface EnqueueResult {
  enqueued: Array<{ id: string; position: number }>
  daemons: Daemon[]
}
