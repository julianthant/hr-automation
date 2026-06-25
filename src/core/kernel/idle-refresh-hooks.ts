import { emitIdleSignal, emitBrowserHealth } from '../../tracker/session-events.js'
import type { SessionObserver } from './types.js'

/**
 * Build the per-system idle-refresh observer hooks: bridge the kernel
 * `Session`'s idle touch/reload lifecycle into `idle_signal` session-JSONL
 * events that drive the dashboard's countdown ring. See
 * `src/domain/idle-refresh.ts` for which systems opt in.
 */
export function buildIdleRefreshHooks(
  instance: string,
  trackerDir?: string,
): Pick<SessionObserver, 'onIdleTouch' | 'onIdleRefresh'> {
  return {
    onIdleTouch: (systemId) => {
      emitIdleSignal(instance, trackerDir, systemId, 'touch')
    },
    onIdleRefresh: (systemId, phase) => {
      emitIdleSignal(instance, trackerDir, systemId, phase === 'start' ? 'refresh_start' : 'refresh_end')
    },
  }
}

/**
 * Build the per-browser health observer hook: bridge the kernel `Session`'s
 * health monitor / refresh / disconnect lifecycle into `browser_health`
 * session-JSONL events. The event is keyed by `browserId` (=== systemId today)
 * so the dashboard binds it to the right tile regardless of tile order. Shared
 * by `buildSessionObserver` and the batch observer so both paths emit identically.
 */
export function buildBrowserHealthHooks(
  instance: string,
  trackerDir?: string,
): Pick<SessionObserver, 'onBrowserHealth'> {
  return {
    onBrowserHealth: (systemId, status, reason, url) => {
      emitBrowserHealth(instance, systemId, systemId, status, reason, trackerDir, url)
    },
  }
}
