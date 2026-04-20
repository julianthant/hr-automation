import type { SessionObserver, ScreenshotFn } from '../core/types.js'

export interface AuthObserverDeps {
  /** Called with auth step name (`auth:<id>`). Caller wires to tracker step-start stream. */
  emitStep: (stepName: string) => void
  /** Called on final retry failure. */
  emitFailed: (stepName: string, error: string) => void
  /** Used to capture all open pages when auth fails. */
  screenshot: ScreenshotFn
}

export function makeAuthObserver(deps: AuthObserverDeps): SessionObserver {
  return {
    onAuthStart: (systemId) => {
      deps.emitStep(`auth:${systemId}`)
    },
    onAuthComplete: (systemId) => {
      deps.emitStep(`auth:${systemId}`)
    },
    onAuthFailed: async (systemId) => {
      const stepName = `auth:${systemId}`
      deps.emitFailed(stepName, 'auth failed')
      try { await deps.screenshot({ kind: 'error', label: stepName }) } catch { /* best-effort */ }
    },
  }
}
