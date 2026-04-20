import { classifyError } from '../utils/errors.js'
import type { ScreenshotFn } from './types.js'

export interface StepperOpts {
  workflow: string
  itemId: string
  runId: string
  emitStep: (name: string) => void
  emitData: (data: Record<string, unknown>) => void
  emitFailed: (step: string, error: string) => void
  /**
   * Optional screenshot callable invoked inside `step`'s catch, BEFORE `emitFailed` runs.
   * When present, the stepper calls it with { kind: "error", label: stepName }.
   * Errors are swallowed; the original throw always wins.
   */
  screenshotFn?: ScreenshotFn
}

export class Stepper {
  private data: Record<string, unknown> = {}
  private currentStep: string | null = null

  constructor(private opts: StepperOpts) {}

  async step<R>(name: string, fn: () => Promise<R>): Promise<R> {
    this.currentStep = name
    this.opts.emitStep(name)
    try {
      return await fn()
    } catch (err) {
      // Best-effort screenshot BEFORE emitFailed so the filename correlates with
      // the failed-step event. Errors inside screenshotFn are swallowed — the
      // original throw must always win.
      if (this.opts.screenshotFn) {
        try { await this.opts.screenshotFn({ kind: 'error', label: name }) } catch { /* best-effort */ }
      }
      const classified = classifyError(err)
      this.opts.emitFailed(name, classified)
      throw err
    }
  }

  /**
   * Announce a step transition without wrapping a body. No try/catch, no
   * throw propagation — just updates `currentStep` and fires `emitStep`.
   * Useful for phases whose work is already managed elsewhere (e.g. auth
   * resolved by Session.launch before the first `ctx.page()` call).
   */
  markStep(name: string): void {
    this.currentStep = name
    this.opts.emitStep(name)
  }

  updateData(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch }
    this.opts.emitData({ ...this.data })
  }

  async parallel<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }> {
    const entries = Object.entries(tasks) as Array<[keyof T, () => Promise<unknown>]>
    const settled = await Promise.allSettled(entries.map(([, fn]) => fn()))
    const result = {} as { [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }
    entries.forEach(([key], i) => {
      ;(result as Record<string, unknown>)[key as string] = settled[i]
    })
    return result
  }

  /**
   * Fail-fast sibling of `parallel`. Uses Promise.all semantics — the first
   * rejected task tears the whole record down. Successful tasks' values are
   * returned unwrapped (no PromiseFulfilledResult envelope), keyed by the
   * same keys as the input `tasks` record.
   */
  async parallelAll<T extends Record<string, () => Promise<unknown>>>(
    tasks: T,
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const entries = Object.entries(tasks) as Array<[keyof T, () => Promise<unknown>]>
    const values = await Promise.all(entries.map(([, fn]) => fn()))
    const result = {} as { [K in keyof T]: Awaited<ReturnType<T[K]>> }
    entries.forEach(([key], i) => {
      ;(result as Record<string, unknown>)[key as string] = values[i]
    })
    return result
  }

  /** Back-patch the screenshot callable after construction. Used by makeCtx to
   *  supply a ScreenshotFn that closes over the stepper itself (for currentStep). */
  setScreenshotFn(fn: ScreenshotFn): void {
    this.opts.screenshotFn = fn
  }

  getData(): Record<string, unknown> {
    return { ...this.data }
  }

  getCurrentStep(): string | null {
    return this.currentStep
  }
}
