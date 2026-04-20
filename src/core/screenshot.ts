import type { Session } from './session.js'
import type { ScreenshotFn, ScreenshotOpts, ScreenshotCapture } from './types.js'

export interface ScreenshotEvent {
  type: 'screenshot'
  runId: string
  ts: number
  kind: 'form' | 'error' | 'manual'
  label: string
  step: string | null
  files: Array<{ system: string; path: string }>
}

export interface ScreenshotDeps {
  session: Pick<Session, 'captureAll'>
  runId: string
  workflow: string
  itemId: string
  emit: (event: ScreenshotEvent) => void
  currentStep: () => string | null
}

export function makeScreenshotFn(deps: ScreenshotDeps): ScreenshotFn {
  return async (opts: ScreenshotOpts): Promise<ScreenshotCapture> => {
    const ts = Date.now()
    const rawFiles = await deps.session.captureAll({
      workflow: deps.workflow,
      itemId: deps.itemId,
      kind: opts.kind,
      label: opts.label,
      ts,
      systems: opts.systems,
      pages: opts.pages,
    })
    const files = rawFiles.map(({ system, path }) => ({ system, path }))
    const capture: ScreenshotCapture = {
      kind: opts.kind,
      label: opts.label,
      step: deps.currentStep(),
      ts,
      files,
    }
    try {
      deps.emit({
        type: 'screenshot',
        runId: deps.runId,
        ts,
        kind: opts.kind,
        label: opts.label,
        step: capture.step,
        files,
      })
    } catch {
      // never mask a successful capture
    }
    return capture
  }
}
