import type { Page } from 'playwright'
import type { Ctx, RetryOpts } from './types.js'
import { CancelledError } from './types.js'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Session } from './session.js'
import type { Stepper } from './stepper.js'
import { log } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { makeScreenshotFn } from './screenshot.js'
import type { ScreenshotEvent } from './screenshot.js'
import { wrapPageWithSignal } from './page-proxy.js'
import { buildDelegateApi } from '../delegate.js'
import { emitItemStart, emitStepChange } from '../../tracker/session-events.js'
import { findFrozenTraceId } from '../../tracker/find-latest-entry.js'
import { tracePrefix } from '../../domain/queue-trace-id.js'
import { buildDataPointLog } from '../../domain/data-point.js'
import type { DataPoint } from '../../domain/data-point.js'

export interface MakeCtxOpts {
  session: Session
  stepper: Stepper
  isBatch: boolean
  runId: string
  workflow: string
  /** Parent workflow's 2-char code — forwarded to delegated children as the trace-id provenance prefix. */
  code?: string
  /**
   * Inherited ROOT trace PREFIX for trace-id propagation (trace/span model).
   * When present this run was itself a delegated child carrying the originating
   * run's `<code>-<HHMMSS>` prefix; `buildDelegateApi` forwards it (transitively)
   * to this run's own children so a whole delegation tree SHARES one operation
   * prefix (each row composes its own tail). Absent on a physical root run,
   * which derives the prefix from its own frozen id (`tracePrefix(findFrozenTraceId)`).
   */
  rootTracePrefix?: string
  itemId: string
  /**
   * Delegated scope — the parent run's id when this run was spawned via
   * `delegateTo`/`delegateToAll`. The kernel already stamps it on the rows it
   * emits; it's surfaced on `ctx` so handlers that own their OWN tracker
   * emission (today: OCR) can re-stamp it on every self-emitted row and stay a
   * recognizable delegated row under the dashboard's latest-wins dedupe.
   */
  parentRunId?: string
  emitScreenshotEvent: (event: ScreenshotEvent) => void
  trackerDir?: string
  /**
   * Per-run AbortSignal. Sourced from the kernel's per-item
   * `AbortController` (see `run-one-item.ts`). Wired into `ctx.signal` for
   * handler-level use and into the `ctx.page(id)` proxy so every Playwright
   * call that accepts a `signal` option auto-injects this one.
   */
  signal: AbortSignal
  /**
   * Session-drawer instance name owning this run (e.g. "OCR 1"). Surfaced on
   * `ctx.workflowInstance` and used by `ctx.reportPhase` to drive the session
   * timeline. Absent in trackerStub/test runs.
   */
  instance?: string
}

/**
 * True for a cancellation/abort-shaped error that must NEVER be retried — a
 * kernel `CancelledError`, or a DOMException/AbortError raised by an aborted
 * `AbortSignal` (a signal-aware Playwright call or the backoff `sleep` below).
 * Retrying one of these would burn attempts racing a run that is already being
 * torn down, and (worse) delay the cancelled terminal by the full backoff.
 */
function isCancellationError(err: unknown): boolean {
  if (err instanceof CancelledError) return true
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name
    if (name === 'AbortError') return true
    const code = (err as { code?: unknown }).code
    if (code === 'ABORT_ERR' || code === 20) return true
  }
  return false
}

/**
 * Linear-backoff retry primitive. Attempt N waits `backoffMs * (N-1)` before
 * retrying, so defaults (attempts=3, backoffMs=1000) yield waits of 0, 1s, 2s
 * before the three tries. Callers that want instant retries pass `backoffMs: 0`.
 * On exhaustion, the last error thrown by `fn` is rethrown verbatim so callers
 * can inspect the underlying cause.
 *
 * SIGNAL-AWARE (the `signal` is bound from the run's per-item AbortController by
 * `ctx.retry`, so handlers never pass it): the loop
 *   (a) throws the abort reason BEFORE starting any attempt once the signal is
 *       aborted (never retries THROUGH a cancellation),
 *   (b) rethrows a cancellation-type error verbatim instead of retrying it — an
 *       aborted signal or an AbortError escaping `fn` is a torn-down run, not a
 *       transient failure, so it surfaces immediately for the kernel to map to
 *       the standard cancelled terminal (the abort reason is never swallowed),
 *       and
 *   (c) sleeps signal-aware, so an abort mid-backoff rejects at once rather than
 *       blocking the full linear delay.
 * A genuinely transient error still retries exactly as before.
 */
async function retry<R>(
  fn: () => Promise<R>,
  opts: RetryOpts = {},
  signal?: AbortSignal,
): Promise<R> {
  const attempts = opts.attempts ?? 3
  const backoffMs = opts.backoffMs ?? 1000
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    // Never START a new attempt after cancellation — throw the abort reason.
    signal?.throwIfAborted()
    try {
      return await fn()
    } catch (err) {
      // A cancellation is not a retryable failure: rethrow it verbatim
      // (preserving the abort reason) so it surfaces immediately.
      if (signal?.aborted || isCancellationError(err)) throw err
      lastErr = err
      opts.onAttempt?.(i, err)
      if (i < attempts && backoffMs > 0) {
        // Signal-aware sleep — an abort during backoff rejects promptly
        // instead of blocking blind for the full linear delay.
        await sleep(backoffMs * i, undefined, signal ? { signal } : undefined)
      }
    }
  }
  throw lastErr
}

export async function tryScreenshot(
  ctx: Ctx<readonly string[], Record<string, unknown>>,
  label: string,
): Promise<void> {
  try {
    await ctx.screenshot({ kind: 'error', label })
  } catch {
    /* best-effort */
  }
}

/**
 * Construct a handler Ctx from a Session + Stepper. Shared by runWorkflow,
 * runWorkflowBatch, and runWorkflowPool so all three modes have identical
 * Ctx surface and stubs.
 */
export function makeCtx<TSteps extends readonly string[], TData>(
  opts: MakeCtxOpts,
): Ctx<TSteps, TData> {
  const { session, stepper, isBatch, runId, workflow, code, rootTracePrefix, itemId, parentRunId, emitScreenshotEvent, trackerDir, signal, instance } = opts

  session.setIdleRefreshGuard(() => stepper.isInsideStep())

  // Session-timeline bridge for handlers that own their own queue-row emission
  // and so never call ctx.step (today: OCR). Emits session item_start (once)
  // + step_change so the terminal-drawer WorkflowBox advances. No queue row is
  // written here — that stays the handler's responsibility. No-op without an
  // instance (trackerStub/test runs).
  let phaseItemStarted = false
  let lastReportedPhase: string | null = null
  const reportPhase = (step: string): void => {
    if (!instance) return
    if (!phaseItemStarted) {
      emitItemStart(instance, itemId, trackerDir)
      phaseItemStarted = true
    }
    if (step !== lastReportedPhase) {
      emitStepChange(instance, step, trackerDir, workflow)
      lastReportedPhase = step
    }
  }

  const screenshotBase = makeScreenshotFn({
    session,
    runId,
    workflow,
    itemId,
    emit: emitScreenshotEvent,
    currentStep: () => stepper.getCurrentStep(),
  })
  const screenshot: typeof screenshotBase = async (opts) => {
    stepper.noteExplicitScreenshot()
    return screenshotBase(opts)
  }

  // Trace-id propagation (trace/span model): forward the INHERITED root PREFIX
  // (not a recompute) so a whole delegation tree SHARES one operation prefix and
  // each child composes its own tail. A physical root run has no
  // `rootTracePrefix`, so we read back its own frozen id from its first pending
  // row (`findFrozenTraceId`) and forward `tracePrefix(that)` — children then
  // compose `<rootPrefix>-<ownRunId4>`. A non-root parent already carries
  // `rootTracePrefix`; we pass it straight through so grandchildren still share
  // the ORIGINAL root prefix (the parentSubject pattern, which `rootCode`
  // deliberately does NOT do).
  const ownFrozen = findFrozenTraceId({ workflow, runId, ...(trackerDir ? { trackerDir } : {}) })
  const forwardRootTracePrefix =
    rootTracePrefix ??
    (ownFrozen ? tracePrefix(ownFrozen) : undefined)
  const delegateApi = buildDelegateApi({
    runId,
    trackerDir,
    signal,
    ...(code ? { code } : {}),
    ...(forwardRootTracePrefix ? { rootTracePrefix: forwardRootTracePrefix } : {}),
  })

  // `ctx.page(id)` returns a Playwright Page wrapped in the kernel's
  // signal-injecting Proxy (see `page-proxy.ts`). The wrapper merges
  // `ctx.signal` into the options object of every Playwright method that
  // accepts a `signal?: AbortSignal`, and returns proxied Locators / sub-
  // objects (`keyboard`, `mouse`, `frame`, `mainFrame`) so chained calls
  // stay signal-aware too. Sync getters (`url`, `title`, `context`, etc.)
  // pass through verbatim.
  const page = async (id: string): Promise<Page> => {
    const raw = await session.page(id)
    return wrapPageWithSignal(raw, signal)
  }

  // Emit one or more data-provenance points on the structured-log channel,
  // auto-tagged with the stepper's CURRENT step (same source the screenshot
  // helper uses). Each point rides `log.step` as an `event: "data:point"` line
  // so it persists + streams like any other log and surfaces in the dashboard's
  // "View Data" tab. Purely observational — never touches tracker data.
  const recordData = (point: DataPoint | DataPoint[]): void => {
    const points = Array.isArray(point) ? point : [point]
    const step = stepper.getCurrentStep()
    for (const p of points) {
      log.step(buildDataPointLog(p, step))
    }
  }

  const ctx = {
    page,
    step: <R>(name: string, fn: () => Promise<R>) => stepper.step(name, fn),
    markStep: (name: string) => stepper.markStep(name),
    skipStep: (name: string) => stepper.skipStep(name),
    shouldSkipStep: (name: string) => stepper.shouldSkipStep(name),
    parallel: <T extends Record<string, () => Promise<unknown>>>(tasks: T) => stepper.parallel(tasks),
    parallelAll: <T extends Record<string, () => Promise<unknown>>>(tasks: T) => stepper.parallelAll(tasks),
    // Bind the run's AbortSignal so retries are cancellation-aware without
    // handlers having to thread the signal (see `retry` above).
    retry: <R>(fn: () => Promise<R>, opts?: RetryOpts) => retry(fn, opts, signal),
    updateData: (patch: Record<string, unknown>) => stepper.updateData(patch),
    recordData,
    session: {
      page,
    },
    log,
    isBatch,
    runId,
    parentRunId,
    signal,
    screenshot,
    trackerDir,
    workflowInstance: instance,
    reportPhase,
    delegateTo: delegateApi.delegateTo,
    delegateToAll: delegateApi.delegateToAll,
  }
  Object.assign(ctx, {
    captureAndStampScreenshot: async (
      label: string,
      dataKey: string,
      opts?: { systems?: string[] },
    ) => {
      try {
        const cap = await ctx.screenshot({
          kind: 'form',
          label,
          ...(opts?.systems ? { systems: opts.systems } : {}),
        })
        // When a system filter was requested, stamp the file for that system
        // (the first requested one) ONLY — never fall back to another
        // captured system's file. This is audit evidence; silently stamping a
        // DIFFERENT system's screenshot under the requested system's data key
        // would mislabel the evidence (fail loud, per root CLAUDE.md "Fail
        // loud — no unverified silent fallbacks"). With no filter requested,
        // "the active page" is unambiguous, so `files[0]` there is a
        // documented-valid default, not a guess.
        const wanted = opts?.systems?.[0]
        const file = wanted ? cap.files?.find((f) => f.system === wanted) : cap.files?.[0]
        if (wanted && !file) {
          log.warn(
            `Screenshot capture for "${label}": requested system "${wanted}" produced no file — not stamping ${dataKey} with a different system's screenshot`,
          )
        } else {
          const filename = file?.path.split('/').pop()
          if (filename) stepper.updateData({ [dataKey]: filename })
        }
      } catch (err) {
        log.warn(`Screenshot capture failed for ${label}: ${errorMessage(err)}`)
      }
    },
  })
  // `data` is a live getter — each access returns a fresh shallow copy of
  // the stepper's accumulated data, including anything pre-merged from the
  // input's `prefilledData` channel before the handler started.
  Object.defineProperty(ctx, 'data', {
    get: () => stepper.getData(),
    enumerable: true,
  })
  return ctx as unknown as Ctx<TSteps, TData>
}
