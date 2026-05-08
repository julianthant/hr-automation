import type { Session } from '../kernel/session.js'
import type { SystemConfig } from '../kernel/types.js'
import { log } from '../../utils/log.js'

export interface KeepaliveOpts {
  instanceId: string
  session: Session
  systems: readonly SystemConfig[]
  recoverOrphanedClaims: () => Promise<number>
}

/**
 * Runs one keepalive tick: orphan recovery + per-system healthCheck.
 * Called from the daemon's idle loop after the idle wait resolves without
 * a wake or shutdown signal (i.e., on the 15-min idle timeout path).
 * Not timer-based — the daemon's idle `setTimeout` drives the cadence.
 */
export async function runKeepaliveTick(opts: KeepaliveOpts): Promise<void> {
  const { instanceId, session, systems, recoverOrphanedClaims } = opts

  await recoverOrphanedClaims()

  // Per-system healthChecks are independent — parallelize. Sequential
  // (the previous shape) made the daemon's "phase=keepalive" window
  // ~N×3s; parallel makes it ~max(3s).
  await Promise.allSettled(
    systems.map(async (sys) => {
      try {
        const ok = await session.healthCheck(sys.id)
        if (!ok) {
          log.warn(
            `[Daemon ${instanceId}] healthCheck(${sys.id}) failed — next claim may re-auth`,
          )
        }
      } catch (e) {
        log.warn(
          `[Daemon ${instanceId}] healthCheck(${sys.id}) error: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      }
    }),
  )
}
