import type { AuthTiming } from '../kernel/batch-lifecycle.js'
import type { SystemConfig } from '../kernel/types.js'

/**
 * Snapshot per-system auth durations captured during daemon startup.
 * Returns undefined when the workflow disables synthetic auth steps.
 */
export function snapshotStartupAuthTimings(
  getAuthTimings: () => AuthTiming[],
  authStepsEnabled: boolean,
): AuthTiming[] | undefined {
  return authStepsEnabled ? getAuthTimings() : undefined
}

/**
 * Zero-duration auth timings anchored at item claim time. Used for daemon
 * items after the first — auth was free (session reuse) but the step
 * pipeline still needs auth:<systemId> rows at the item's own anchor.
 */
export function buildClaimAnchoredAuthTimings(
  systems: readonly SystemConfig[],
  claimTs: number,
): AuthTiming[] {
  return systems.map((sys) => ({
    systemId: sys.id,
    startTs: claimTs,
    endTs: claimTs,
  }))
}

export interface DaemonItemAuthTimingResolver {
  /** Resolve authTimings for the next claimed item and advance first-item state. */
  resolveForNextItem: () => AuthTiming[] | undefined
}

/**
 * Daemon-mode auth timing rotation: item #1 inherits real startup Duo
 * durations; every subsequent item gets claim-anchored zero-duration
 * synthetic timings so elapsed timers aren't inflated by queue-wait gap.
 */
export function createDaemonItemAuthTimingResolver(
  getAuthTimings: () => AuthTiming[],
  authStepsEnabled: boolean,
  systems: readonly SystemConfig[],
): DaemonItemAuthTimingResolver {
  const startupAuthTimings = snapshotStartupAuthTimings(getAuthTimings, authStepsEnabled)
  let firstItemClaimed = false
  return {
    resolveForNextItem: (): AuthTiming[] | undefined => {
      if (!authStepsEnabled) return undefined
      if (firstItemClaimed) {
        return buildClaimAnchoredAuthTimings(systems, Date.now())
      }
      firstItemClaimed = true
      return startupAuthTimings
    },
  }
}
