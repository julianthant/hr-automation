import { emitUcpathIdleSignal } from '../../tracker/session-events.js'
import type { SessionObserver } from './types.js'

export function buildUcpathIdleHooks(
  instance: string,
  trackerDir?: string,
): Pick<SessionObserver, 'onUcpathIdleTouch' | 'onUcpathIdleRefresh'> {
  return {
    onUcpathIdleTouch: () => {
      emitUcpathIdleSignal(instance, trackerDir, 'touch')
    },
    onUcpathIdleRefresh: (phase) => {
      emitUcpathIdleSignal(instance, trackerDir, phase === 'start' ? 'refresh_start' : 'refresh_end')
    },
  }
}
