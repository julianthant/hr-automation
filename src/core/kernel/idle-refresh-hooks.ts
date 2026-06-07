import { emitIdleSignal } from '../../tracker/session-events.js'
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
