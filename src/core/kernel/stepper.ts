import { classifyError } from '../../utils/errors.js'
import { log } from '../../utils/log.js'
import { CancelledError, type ScreenshotFn } from './types.js'

export interface StepperOpts {
  workflow: string
  itemId: string
  runId: string
  emitStep: (name: string) => void
  emitData: (data: Record<string, unknown>) => void
  emitFailed: (step: string, error: string) => void
  /**
   * Announce that a step was intentionally bypassed. Routes to the tracker's
   * `skipped` status emit. Optional — older callers that haven't been
   * updated will see the no-op default and `skipStep` will silently do
   * nothing for them, which is safe (no false `running` row written).
   */
  emitSkipped?: (name: string) => void
  /**
   * Optional screenshot callable invoked inside `step`'s catch, BEFORE `emitFailed` runs.
   * When present, the stepper calls it with { kind: "error", label: stepName }.
   * Errors are swallowed; the original throw always wins.
   */
  screenshotFn?: ScreenshotFn
  /**
   * Cooperative-cancel probe. Polled at the start of every `step(name, fn)`
   * call before `emitStep`/`fn`. When it returns true, the stepper marks
   * the current step as `"cancelled"` (so the dashboard tracker row uses
   * that step name on the auto-emitted `failed` row) and throws
   * `CancelledError(name)` — `fn` never runs, no diagnostic screenshot is
   * captured, and the daemon's claim loop sees the typed error and resets
   * pages before the next item.
   *
   * Optional — older Stepper callers that don't pass this never check
   * for cancellation, preserving today's behavior verbatim.
   */
  isCancelRequested?: () => boolean
  /**
   * Names of steps the caller (dashboard step-preset gear, etc.) marked
   * skipped via the `runtimeOptions.skipSteps` channel. Exposed to the
   * handler via `ctx.shouldSkipStep(name)`. The Stepper does NOT auto-bypass
   * `step(name, fn)` calls — handlers must explicitly substitute fallbacks
   * because step bodies set closure variables downstream code depends on.
   */
  skipSteps?: ReadonlySet<string>
}

export class Stepper {
  private data: Record<string, unknown> = {}
  private currentStep: string | null = null
  /** Nesting depth of `step()` bodies currently executing (0 = no active step). */
  private stepDepth = 0

  constructor(private opts: StepperOpts) {}

  private throwCancelled(reason: string): never {
    this.currentStep = 'cancelled'
    // Run-scope `cancel:requested` event: the operator cancel (an aborted
    // per-run AbortSignal / cancel probe) has been observed by THIS run at a
    // step boundary and is becoming a CancelledError. The daemon's own
    // `cancel_task` command handler runs in daemon-scope (session log), so
    // this Stepper site is the run-scope observation the harness tails.
    // See docs/engineering/structured-log-events.md.
    log.warn({
      message: `Cancel requested at step '${reason}'`,
      event: 'cancel:requested',
      category: 'queue',
      occasion: 'cancelled',
      step: reason,
    })
    this.opts.emitStep('cancelled')
    throw new CancelledError(reason)
  }

  private announce(name: string, emit: (name: string) => void = this.opts.emitStep): void {
    this.currentStep = name
    // Annotate the per-step log line with the stable `step:start` event +
    // the step name so the Tier-1 harness can `waitForEvent("step:start",
    // { step })` to know a (child) run reached a given stage. Run-scope log
    // (persisted to logs/<workflow>-<date>.jsonl); see
    // docs/engineering/structured-log-events.md.
    log.step({ message: `Phase: ${name}`, event: "step:start", step: name })
    emit(name)
  }

  async step<R>(name: string, fn: () => Promise<R>): Promise<R> {
    // Cooperative-cancel check at step boundary. If the daemon set the
    // cancel flag for the in-flight item, mark step="cancelled" on the
    // tracker (so the auto-emitted `failed` row carries that step name)
    // and throw without invoking `fn` or capturing a screenshot. The
    // daemon's claim loop catches `CancelledError`, resets pages, and
    // claims the next item.
    if (this.opts.isCancelRequested?.()) {
      this.throwCancelled(name)
    }
    this.announce(name)
    this.stepDepth++
    const startedAt = Date.now()
    try {
      const result = await fn()
      // Run-scope `step:done` event — the harness can `waitForEvent(
      // "step:done", { step })` to know a step's body completed (vs
      // `step:start`, which fires at the boundary before the body runs).
      // Carries the wall-clock duration. See
      // docs/engineering/structured-log-events.md.
      log.step({ message: `Phase done: ${name}`, event: "step:done", step: name, durationMs: Date.now() - startedAt })
      return result
    } catch (err) {
      // CancelledError thrown from inside `fn` (e.g. handler explicitly
      // checks ctx and throws): same suppression rule — no screenshot,
      // no emitFailed; let runOneItem's catch produce the cancelled row.
      if (err instanceof CancelledError) {
        throw err
      }
      // Contract 5: when an in-flight Playwright call rejects because the
      // per-run AbortController was aborted (operator cancel), or when
      // cancellation was otherwise requested while the step was running,
      // reclassify any thrown error as CancelledError so the daemon's
      // claim-loop classifier sees `r.kind === 'cancelled'` and writes a
      // cancelled tracker row instead of a failed one. The literal
      // 'cancelled' step name matches `runOneItem`'s outer-boundary
      // CancelledError — operator-visible cancel messages stay consistent
      // regardless of where the cancellation was intercepted.
      if (this.opts.isCancelRequested?.()) {
        this.throwCancelled('cancelled')
      }
      // Best-effort screenshot BEFORE emitFailed so the filename correlates with
      // the failed-step event. Errors inside screenshotFn are swallowed — the
      // original throw must always win.
      if (this.opts.screenshotFn) {
        try { await this.opts.screenshotFn({ kind: 'error', label: name }) } catch { /* best-effort */ }
      }
      const classified = classifyError(err)
      this.opts.emitFailed(name, classified)
      throw err
    } finally {
      this.stepDepth--
    }
  }

  /**
   * Announce a step transition without wrapping a body. No try/catch, no
   * throw propagation — just updates `currentStep` and fires `emitStep`.
   * Useful for phases whose work is already managed elsewhere (e.g. auth
   * resolved by Session.launch before the first `ctx.page()` call).
   */
  markStep(name: string): void {
    this.announce(name)
  }

  /**
   * Announce that a step was intentionally bypassed. Updates `currentStep`
   * and fires `emitSkipped` (if wired) so the dashboard's pipeline shows a
   * distinct "skipped" treatment rather than the green "done" dot. Use for
   * edit-and-resume-style flows where extracted data was pre-populated by
   * the kernel's `prefilledData` channel and the extraction step is
   * intentionally not executed.
   */
  skipStep(name: string): void {
    this.announce(name, (step) => this.opts.emitSkipped?.(step))
  }

  /**
   * True when the caller's `skipSteps` set contains this step name. Surfaced
   * on the handler `Ctx` as `ctx.shouldSkipStep(name)`. Returns false when
   * `skipSteps` is omitted (default — no preset active).
   */
  shouldSkipStep(name: string): boolean {
    return this.opts.skipSteps?.has(name) ?? false
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
    return Object.fromEntries(
      entries.map(([key], i) => [key, settled[i]]),
    ) as { [K in keyof T]: PromiseSettledResult<Awaited<ReturnType<T[K]>>> }
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
    return Object.fromEntries(
      entries.map(([key], i) => [key, values[i]]),
    ) as { [K in keyof T]: Awaited<ReturnType<T[K]>> }
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

  /** True while a `step(name, fn)` body is executing (including awaiting inside `fn`). */
  isInsideStep(): boolean {
    return this.stepDepth > 0
  }
}
