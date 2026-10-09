/**
 * The ONE decision authority for what happens to a daemon's IN-FLIGHT item when
 * an aborted controller surfaces a stop intent. Two sites used to hand-mirror
 * this four-way branch — the claim-loop `isCancelOutcome` branch (`daemon.ts`)
 * and the outer-finally safety-net sweep (`runDaemonShutdownCleanup` in
 * `shutdown.ts`). The 2026-06-07 lesson warns the two paths MUST agree on the
 * decision or they silently drift (the failure mode behind VQ-003 / F5 /
 * E2E-105). The shared EMIT layer already lives in `in-flight-shutdown.ts`; this
 * completes the dedup by sharing the DECISION too.
 *
 * This is a PURE function (no imports, no side effects) so it is exhaustively
 * unit-testable and a new intent is a compile error at the `switch`. It decides
 * ONLY which of reassign / fail / cancel applies — the per-site BODIES
 * (reassign vs the two fail flavors vs each site's distinct cancel) stay at the
 * call sites, which keep their own emit args (`bestEffort`/`settleDependency`/
 * `claimTerminalWrite`) and their own cancel semantics (deliberate
 * `/cancel-current` in the claim loop vs browser-disconnect/crash in the sweep).
 *
 * The `skipShutdownEmit` pre-gate (shutdown.ts: the run already reached a
 * terminal state in the kill→cleanup window) is NOT part of this decision — it
 * is checked BEFORE calling the resolver and just clears `state.activeRun`.
 */

/** The fail flavor — maps to the canonical fail strings in `in-flight-shutdown.ts` at the call site. */
export type TeardownFailReason = 'no-responsive-peer' | 'no-daemon'

/** What to do with the in-flight item. The `cancel` body is site-specific (see module doc). */
export type TeardownAction =
  | { kind: 'reassign' }
  | { kind: 'fail'; reason: TeardownFailReason }
  | { kind: 'cancel' }

export interface TeardownTransitionArgs {
  /** `state.reassignInFlight` — set only by a per-instance stop requesting hand-off. */
  reassignInFlight: boolean
  /** `state.forceShutdown` — stop-all / SIGINT / the last daemon. */
  forceShutdown: boolean
  /** Whether the in-flight item carries a SQLite `taskId` (reassign needs one). */
  hasTaskId: boolean
  /**
   * Count of peers AVAILABLE FOR HAND-OFF — responsive `/whoami` MATCH AND not
   * themselves shutting down (`filterPeersAvailableForHandoff`). Only a peer in
   * this set will actually claim the re-queued item.
   */
  responsivePeerCount: number
  /**
   * Count of peers that are merely PID-alive (`findAliveDaemons` minus self).
   * A reassign request with PID-alive but no AVAILABLE peers means the peers are
   * wedged/zombie — fail loud (F5) rather than park the item forever.
   */
  pidAlivePeerCount: number
}

/**
 * Resolve the in-flight teardown action. Faithful transcription of the chains in
 * `daemon.ts` (claim loop) and `shutdown.ts` (sweep):
 *
 *   1. reassign requested + a peer can actually take it + we have a taskId → reassign
 *   2. reassign requested + peers look alive but none available     → fail (no-responsive-peer, F5)
 *   3. force-shutdown with no spare                                  → fail (no-daemon)
 *   4. otherwise (neither flag)                                      → cancel
 */
export function resolveTeardownTransition(args: TeardownTransitionArgs): TeardownAction {
  const { reassignInFlight, forceShutdown, hasTaskId, responsivePeerCount, pidAlivePeerCount } = args
  if (reassignInFlight && responsivePeerCount > 0 && hasTaskId) return { kind: 'reassign' }
  if (reassignInFlight && pidAlivePeerCount > 0) return { kind: 'fail', reason: 'no-responsive-peer' }
  if (forceShutdown) return { kind: 'fail', reason: 'no-daemon' }
  return { kind: 'cancel' }
}
