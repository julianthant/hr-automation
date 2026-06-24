import type { RegisteredWorkflow } from './types.js'
import { makeAuthObserver } from '../../tracker/sessions/auth-observer.js'
import type { ScreenshotFn } from './types.js'
import { buildIdleRefreshHooks, buildBrowserHealthHooks } from './idle-refresh-hooks.js'

/**
 * Build a SessionObserver that routes Session.launch lifecycle hooks into
 * the tracker's SessionContext (for Events-tab events) and `setStep` /
 * `emitFailed` (for the StepPipeline + entry-status flip to "running" /
 * "failed"). Auth step names follow the `auth:<systemId>` convention that
 * `defineWorkflow` auto-prepends to the effective step list.
 *
 * Guard: if `authSteps: false` is set (workflow already declares its own
 * custom auth step names), the `setStep` / `emitFailed` calls are skipped so
 * we never emit a `running` row for an unregistered step name.
 */
export function buildSessionObserver<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  sessionCtx: import('../../tracker/jsonl.js').SessionContext,
  setStep: (step: string) => void,
  emitFailed: (step: string, error: string) => void = () => {},
  screenshotFnPromise: Promise<ScreenshotFn> = Promise.resolve(
    async () => ({ kind: 'error', label: '', step: null, ts: Date.now(), files: [] }),
  ),
  trackerDir?: string,
): import('./types.js').SessionObserver {
  const sessionId = '1'
  let registered = false
  // Use wf.metadata.steps (effective steps, including auto-prepended auth:<id>
  // entries) so the guard reflects what the registry actually declared.
  const effectiveSteps = new Set<string>(wf.metadata.steps)

  const authObs = makeAuthObserver({
    emitStep: (stepName) => {
      if (effectiveSteps.has(stepName)) setStep(stepName)
    },
    emitFailed: (stepName, error) => {
      if (effectiveSteps.has(stepName)) emitFailed(stepName, error)
    },
    screenshot: async (opts) => (await screenshotFnPromise)(opts),
  })

  return {
    instance: sessionCtx.instance,
    onBrowserLaunch: (systemId, browserId) => {
      if (!registered) {
        sessionCtx.registerSession(sessionId)
        registered = true
      }
      sessionCtx.registerBrowser(sessionId, browserId, systemId)
    },
    onAuthStart: (systemId, browserId) => {
      authObs.onAuthStart!(systemId, browserId)
      sessionCtx.setAuthState(browserId, systemId, 'start')
    },
    onAuthComplete: (systemId, browserId) => {
      authObs.onAuthComplete!(systemId, browserId)
      sessionCtx.setAuthState(browserId, systemId, 'complete')
    },
    onAuthFailed: (systemId, browserId) => {
      void authObs.onAuthFailed!(systemId, browserId)
      sessionCtx.setAuthState(browserId, systemId, 'failed')
    },
    ...buildIdleRefreshHooks(sessionCtx.instance, trackerDir),
    ...buildBrowserHealthHooks(sessionCtx.instance, trackerDir),
  }
}
