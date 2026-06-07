/**
 * Idle-refresh registry: which authenticated systems keep their browser
 * session warm by reloading the page after a period of automation inactivity,
 * and at what cadence.
 *
 * Long-lived daemon sessions sit idle between queued items. Server-side
 * sessions (PeopleSoft UCPath, I-9 Complete) expire on their own idle clock,
 * so the next claimed item would otherwise hit a logged-out page and force a
 * re-auth. The kernel `Session` runs a per-system timer that reloads the page
 * once it has seen no `ctx.page(<system>)` activity for `thresholdMs`, polling
 * every `tickMs`. See `src/core/kernel/session.ts`.
 *
 * This is the single source of truth for the set of idle-refresh systems and
 * their cadence — shared by the kernel (session engine + daemon touch emits)
 * and the dashboard (countdown ring + session-state bootstrap). Add a system
 * here to give it idle-refresh; every workflow that declares that system then
 * inherits the behavior (the kernel keys on system id, not on a per-workflow
 * opt-in). Domain layer: no node/Playwright dependencies, safe in the client
 * bundle.
 */
export interface IdleRefreshCadence {
  /** Reload once automation has been idle on this system for at least this long. */
  thresholdMs: number
  /** How often the idle timer checks whether a reload is due. */
  tickMs: number
}

/** Default cadence — UCPath's original values, conservative for ≥15-min server timeouts. */
export const DEFAULT_IDLE_REFRESH_CADENCE: IdleRefreshCadence = {
  thresholdMs: 5 * 60 * 1000,
  tickMs: 30 * 1000,
}

/** System id → idle-refresh cadence. Presence here is the opt-in. */
export const IDLE_REFRESH_SYSTEMS: Readonly<Record<string, IdleRefreshCadence>> = {
  ucpath: DEFAULT_IDLE_REFRESH_CADENCE,
  i9: DEFAULT_IDLE_REFRESH_CADENCE,
}

/** True when the system keeps its session warm via idle-refresh reloads. */
export function isIdleRefreshSystem(systemId: string): boolean {
  return Object.prototype.hasOwnProperty.call(IDLE_REFRESH_SYSTEMS, systemId)
}

/** Cadence for an idle-refresh system, or `undefined` if it doesn't opt in. */
export function idleRefreshCadence(systemId: string): IdleRefreshCadence | undefined {
  return IDLE_REFRESH_SYSTEMS[systemId]
}
