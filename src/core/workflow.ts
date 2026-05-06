import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { WorkflowConfig, RegisteredWorkflow, WorkflowMetadata, RunOpts, BatchResult } from './types.js'
import { register, autoLabel, normalizeDetailField } from './registry.js'
import { Session } from './session.js'
import { Stepper } from './stepper.js'
import { makeCtx } from './ctx.js'
import { trackEvent, withTrackedWorkflow, emitScreenshotEvent, type WithTrackedWorkflowOpts } from '../tracker/jsonl.js'
import { makeScreenshotFn } from './screenshot.js'
import { withLogContext, log } from '../utils/log.js'
import { runWorkflowPool } from './pool.js'
import { runWorkflowSharedContextPool } from './shared-context-pool.js'
import { withBatchLifecycle } from './batch-lifecycle.js'
import { validateAndPrepareItems, callerPreEmitsPending, awaitAllSystemsReady } from './batch-helpers.js'
import { makeAuthObserver } from '../tracker/auth-observer.js'
import { registerInProcessRun, unregisterInProcessRun } from './in-process-runs.js'
import { operatorSubjectData } from '../domain/operator-subject.js'
import { openControlDb } from './control-db.js'
import { createTaskStore } from './task-store/index.js'
import { createWorkerStore } from './worker-store.js'
import type { InProcessRunControl } from './in-process-runs.js'
import { runOneItem } from './run-one-item.js'
export { runOneItem } from './run-one-item.js'
export type { RunOneItemOpts, RunOneItemResult } from './run-one-item.js'

/**
 * Coerce an arbitrary key → unknown map into the `Record<string, string>`
 * shape that withTrackedWorkflow's `initialData` expects. Non-string values
 * are stringified via String(); null/undefined become empty string.
 */
function stringifyMap(d: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(d)) {
    out[k] = v == null ? '' : String(v)
  }
  return out
}

/**
 * Best-effort coercion of an arbitrary input into a `Record<string, unknown>`
 * so it can ride on the `pending` tracker row's `input` field. Non-objects
 * become `null` (caller skips writing the field). Does NOT clone — the
 * returned reference is the same object the kernel got, by design: the
 * tracker line is JSON-stringified at write time, so downstream mutation
 * by the handler can't reach back into the file.
 */
export function toRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

/**
 * Split a `prefilledData` channel out of an arbitrary input object without
 * mutating the original. Used by the kernel's edit-and-resume path: the
 * dashboard re-enqueues an item with `prefilledData: <user-edited fields>`,
 * the kernel strips the channel before handing the input to the workflow's
 * Zod schema (so the schema doesn't need to know about it), and merges the
 * stripped values into `ctx.data` via `updateData(...)` BEFORE the handler
 * runs. Handlers gate their extraction step on data presence (e.g.
 * `if (!ctx.data.foo) await ctx.step("extraction", ...)`) to opt in.
 *
 * Returns `{ cleaned, prefilled }`. `prefilled` is null when the input has
 * no `prefilledData` field or it's not an object — both are "no-op" cases.
 */
export function splitPrefilled(input: unknown): {
  cleaned: unknown
  prefilled: Record<string, unknown> | null
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { cleaned: input, prefilled: null }
  }
  const obj = input as Record<string, unknown>
  if (!('prefilledData' in obj)) return { cleaned: input, prefilled: null }
  const { prefilledData, ...rest } = obj
  const prefilled =
    prefilledData && typeof prefilledData === 'object' && !Array.isArray(prefilledData)
      ? (prefilledData as Record<string, unknown>)
      : null
  return { cleaned: rest, prefilled }
}

/**
 * Build the richness-hook bundle for `withTrackedWorkflow` from a workflow
 * config. Extracted so all three modes (runWorkflow, runWorkflowBatch,
 * runWorkflowPool) pass the identical shape — keeps the runtime warning,
 * getName, and getId in lockstep across modes.
 */
export function buildTrackerOpts<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
): WithTrackedWorkflowOpts {
  return {
    declaredDetailFields: (wf.config.detailFields ?? [])
      .map(normalizeDetailField)
      .map((f) => f.key),
    nameFn: wf.config.getName,
    idFn: wf.config.getId,
  }
}

export function buildInitialTrackerData<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: TData,
): Record<string, string> {
  const initial = wf.config.initialData ? stringifyMap(wf.config.initialData(input)) : {}
  const subject = wf.config.operatorSubject ? operatorSubjectData(wf.config.operatorSubject(input)) : {}
  return { ...initial, ...subject }
}

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
  sessionCtx: import('../tracker/jsonl.js').SessionContext,
  setStep: (step: string) => void,
  emitFailed: (step: string, error: string) => void = () => {},
  /**
   * Mutable screenshot holder (Strategy B). Starts as a no-op; onReady swaps
   * in a real makeScreenshotFn once the Session reference is available.
   * The observer calls `boundScreenshot.fn(...)` at invocation time so it
   * always picks up the latest value — not the one captured at construction.
   */
  boundScreenshot: { fn: import('./types.js').ScreenshotFn } = {
    fn: async () => ({ kind: 'error', label: '', step: null, ts: Date.now(), files: [] }),
  },
): import('./types.js').SessionObserver {
  const sessionId = '1'
  let registered = false
  // Use wf.metadata.steps (effective steps, including auto-prepended auth:<id>
  // entries) so the guard reflects what the registry actually declared.
  const effectiveSteps = new Set<string>(wf.metadata.steps)

  // Build the auth-step observer — screenshot is indirected through
  // boundScreenshot.fn so onReady can swap in the real fn after construction.
  const authObs = makeAuthObserver({
    emitStep: (stepName) => {
      if (effectiveSteps.has(stepName)) setStep(stepName)
    },
    emitFailed: (stepName, error) => {
      if (effectiveSteps.has(stepName)) emitFailed(stepName, error)
    },
    screenshot: (opts) => boundScreenshot.fn(opts),
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
  }
}

export function defineWorkflow<TData, TSteps extends readonly string[]>(
  config: WorkflowConfig<TData, TSteps>,
): RegisteredWorkflow<TData, TSteps> {
  const authPrefix =
    config.authSteps === false ? [] : config.systems.map((s) => `auth:${s.id}`)
  const effectiveSteps: readonly string[] = [...authPrefix, ...config.steps]
  const metadata: WorkflowMetadata = {
    name: config.name,
    label: config.label ?? autoLabel(config.name),
    steps: effectiveSteps,
    systems: config.systems.map((s) => s.id),
    detailFields: (config.detailFields ?? []).map(normalizeDetailField),
    ...(config.category ? { category: config.category } : {}),
    ...(config.iconName ? { iconName: config.iconName } : {}),
    ...(config.matchKey ? { matchKey: config.matchKey } : {}),
    hasOperatorSubject: Boolean(config.operatorSubject),
  }
  register(metadata)
  return { config, metadata }
}

/**
 * Derive a stable itemId from common identifier fields on the input data.
 * Falls back to the caller-provided `fallback` (typically a UUID) if no known
 * field is present.
 *
 * Recognized fields (in priority order): `emplId`, `docId`, `email`.
 */
export function deriveItemId<TData>(data: TData, fallback: string): string {
  const d = data as unknown as Record<string, unknown>
  return (
    (typeof d?.emplId === 'string' ? d.emplId : undefined) ??
    (typeof d?.docId === 'string' ? d.docId : undefined) ??
    (typeof d?.email === 'string' ? d.email : undefined) ??
    (typeof d?.sessionId === 'string' ? d.sessionId : undefined) ??
    fallback
  )
}

function registerInProcessControl<TData>(
  wf: RegisteredWorkflow<TData, readonly string[]>,
  input: TData,
  itemId: string,
  runId: string,
  trackerDir: string | undefined,
): InProcessRunControl | null {
  if (!trackerDir) return null
  const workerId = `dashboard:${process.pid}`
  try {
    const control = openControlDb({ trackerDir })
    const taskStore = createTaskStore(control)
    const workerStore = createWorkerStore(control)
    workerStore.registerWorker({
      workerId,
      workflow: wf.config.name,
      kind: 'dashboard',
      pid: process.pid,
      parentPid: process.ppid,
      hostname: hostname(),
      phase: 'processing',
      status: 'alive',
      heartbeatTtlMs: 30_000,
    })
    const existing = taskStore.getTaskByRunId(runId)
    const task = existing && existing.workflow === wf.config.name && existing.itemId === itemId
      ? {
          taskId: existing.taskId,
          attemptId: existing.currentAttemptId,
        }
      : taskStore.enqueueTasks({
          workflow: wf.config.name,
          inputs: [input],
          deriveItemId: () => itemId,
          runIds: [runId],
          source: 'in-process',
          metadata: { workerId },
        })[0]
    if (!task?.attemptId) return null
    taskStore.markTaskRunning({ taskId: task.taskId, attemptId: task.attemptId, workerId })
    return { trackerDir, workerId, taskId: task.taskId, attemptId: task.attemptId }
  } catch (err) {
    log.warn(
      `[runWorkflow] SQLite in-process control registration skipped for ${wf.config.name}/${itemId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    return null
  }
}

function registerInProcessBrowsers<TData>(
  wf: RegisteredWorkflow<TData, readonly string[]>,
  session: Session,
  control: InProcessRunControl | null,
): void {
  if (!control) return
  try {
    const workerStore = createWorkerStore(openControlDb({ trackerDir: control.trackerDir }))
    for (const [systemId, pid] of Object.entries(session.chromePids)) {
      const sys = wf.config.systems.find((s) => s.id === systemId)
      workerStore.upsertBrowserProcess({
        workerId: control.workerId,
        workflow: wf.config.name,
        taskId: control.taskId,
        attemptId: control.attemptId,
        systemId,
        browserId: systemId,
        pid,
        ...(sys?.sessionDir ? { sessionDir: sys.sessionDir } : {}),
      })
    }
  } catch (err) {
    log.warn(
      `[runWorkflow] SQLite in-process browser registration skipped for ${wf.config.name}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

function markInProcessControlTerminal(
  control: InProcessRunControl | null,
  ok: boolean,
  error?: unknown,
): void {
  if (!control) return
  try {
    const taskStore = createTaskStore(openControlDb({ trackerDir: control.trackerDir }))
    if (ok) {
      taskStore.markTaskDone({ taskId: control.taskId, attemptId: control.attemptId })
    } else {
      taskStore.markTaskFailed({
        taskId: control.taskId,
        attemptId: control.attemptId,
        error: error instanceof Error ? error.message : String(error ?? 'in-process run failed'),
      })
    }
  } catch (err) {
    log.warn(
      `[runWorkflow] SQLite in-process terminal update skipped for task=${control.taskId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
}

export async function runWorkflow<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  data: TData,
  opts: RunOpts = {},
): Promise<void> {
  // Strip the kernel-level prefilledData channel out before anything else.
  // The schema validates the cleaned input (so workflow schemas don't need
  // to declare the channel), and `prefilled` is pre-merged into ctx.data so
  // handler-side `if (!ctx.data.foo) await ctx.step("extraction", ...)`
  // gates kick in. The full `data` (with channel) rides on the pending row
  // for retry.
  const { cleaned: cleanedData, prefilled } = splitPrefilled(data)
  const handlerInput = cleanedData as TData
  const inputForRow = toRecord(data)

  // 1. Validate data. Wrap to ensure error message matches /validation/i.
  try {
    wf.config.schema.parse(handlerInput)
  } catch (err) {
    throw new Error(`validation error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Derive itemId from workflow-specific/common id fields, fall back to UUID.
  const itemId = opts.itemId ?? wf.config.deriveItemId?.(handlerInput) ?? deriveItemId(handlerInput, randomUUID())

  const run = async (
    setStep: (s: string) => void,
    updateData: (d: Record<string, unknown>) => void,
    /**
     * Install a kernel-owned SIGINT handler. Only passed `true` in the
     * `trackerStub` branch — in real runs, `withTrackedWorkflow` owns SIGINT
     * and a second handler here would just duplicate cleanup.
     */
    installSigint: boolean,
    /**
     * Observer that bridges Session.launch lifecycle hooks into the tracker.
     * Undefined in the trackerStub branch (nothing to bridge to).
     */
    observer?: import('./types.js').SessionObserver,
    /**
     * Called from Session.launch's onReady hook (synchronously after Session
     * construction, before any browser launches). Gives the caller the live
     * Session reference + pre-built Stepper so it can swap a real ScreenshotFn
     * into a mutable holder before auth fires.
     */
    onSessionReady?: (session: Session, runId: string, stepper: Stepper, trackerDir: string | undefined) => void,
    /**
     * Pass the tracker's runId in from the real-run branch so the Stepper,
     * screenshot emitter, and tracker JSONL all share one id. When absent
     * (trackerStub / preAssignedRunId path), falls back to the legacy
     * generator — either a UUID from opts, or a fresh UUID.
     */
    forcedRunId?: string,
    /**
     * Routes Stepper's `skipStep` through the tracker. Wired by the
     * real-run branch from withTrackedWorkflow's body callback; the
     * trackerStub branch passes a no-op.
     */
    emitSkipped: (step: string) => void = () => {},
  ): Promise<void> => {
    const runId = forcedRunId ?? opts.preAssignedRunId ?? randomUUID()
    const stepper = new Stepper({
      workflow: wf.config.name,
      itemId: String(itemId),
      runId,
      emitStep: setStep,
      // Tracker's updateData now accepts unknown; it stringifies at the write boundary.
      emitData: updateData,
      emitFailed: (step, error) => setStep(`${step}:failed:${error}`),
      emitSkipped,
    })

    // Register for in-process cancellation BEFORE auth starts. `onReady`
    // fires synchronously after Session construction and before any browser
    // launches, so the dashboard's `/api/cancel-running` endpoint can find
    // this run and hard-kill chromium even while it's stuck waiting on Duo.
    // Unregistration lives in an outer try/finally so a `Session.launch`
    // throw (auth-failure-after-3-retries, browser launch failure) still
    // cleans up. See `src/core/in-process-runs.ts`.
    const cancelIdent = { workflow: wf.config.name, itemId: String(itemId), runId }
    const inProcessControl = opts.trackerStub
      ? null
      : registerInProcessControl(wf, handlerInput, String(itemId), runId, opts.trackerDir)
    let cancelRegistered = false
    let completed = false
    try {
      const session = await Session.launch(wf.config.systems, {
        authChain: wf.config.authChain,
        launchFn: opts.launchFn,
        observer,
        onReady: (sess) => {
          registerInProcessRun(cancelIdent, sess, inProcessControl ?? undefined)
          cancelRegistered = true
          onSessionReady?.(sess, runId, stepper, opts.trackerDir)
        },
      })
      registerInProcessBrowsers(wf, session, inProcessControl)

      const ctx = makeCtx<TSteps, TData>({
        session,
        stepper,
        isBatch: false,
        runId,
        workflow: wf.config.name,
        itemId: String(itemId),
        emitScreenshotEvent: (ev) => emitScreenshotEvent(ev, { dir: opts.trackerDir }),
      })
      stepper.setScreenshotFn(ctx.screenshot)

      let sigintHandler: (() => void) | null = null
      if (installSigint) {
        sigintHandler = () => {
          try {
            const step = stepper.getCurrentStep() ?? 'sigint'
            setStep(`${step}:failed:interrupted`)
          } catch { /* best-effort */ }
          // Fire-and-forget kill — we're exiting regardless.
          session.killChrome().catch(() => {})
          process.exit(1)
        }
        process.on('SIGINT', sigintHandler)
      }

      try {
        try {
          if (prefilled) ctx.updateData(prefilled as Partial<TData & Record<string, unknown>>)
          await wf.config.handler(ctx, handlerInput)
          completed = true
        } catch (err) {
          // Same screenshot-on-handler-throw hoist as runOneItem (see the
          // two other call sites). Best-effort; original throw always wins.
          try { await ctx.screenshot({ kind: 'error', label: 'handler-throw' }) } catch { /* best-effort */ }
          throw err
        }
      } finally {
        if (sigintHandler) process.off('SIGINT', sigintHandler)
        await session.close()
      }
    } catch (err) {
      markInProcessControlTerminal(inProcessControl, false, err)
      throw err
    } finally {
      if (completed) markInProcessControlTerminal(inProcessControl, true)
      if (cancelRegistered) unregisterInProcessRun(cancelIdent)
    }
  }

  if (opts.trackerStub) {
    // trackerStub mode is test-only injection: withTrackedWorkflow isn't
    // running, so the kernel must own SIGINT here. No observer — there's
    // no SessionContext to bridge hooks into.
    await run(
      () => {},
      () => {},
      true,
      undefined,
    )
    return
  }

  // Real-run mode: withTrackedWorkflow installs its own SIGINT handler that
  // writes a `failed` tracker entry + log entry before exiting. A kernel
  // handler on top would just duplicate cleanup, so don't install one.
  await withLogContext(wf.config.name, String(itemId), async () => {
    const seedData = buildInitialTrackerData(wf, handlerInput)
    await withTrackedWorkflow(
      wf.config.name,
      String(itemId),
      async (setStep, updateData, _onCleanup, sessionCtx, emitFailed, trackerRunId, emitSkipped) => {
        // Strategy B: mutable holder so onReady can swap in a real ScreenshotFn.
        const boundScreenshot: { fn: import('./types.js').ScreenshotFn } = {
          fn: async () => ({ kind: 'error', label: '', step: null, ts: Date.now(), files: [] }),
        }
        const observer = buildSessionObserver(wf, sessionCtx, setStep, emitFailed, boundScreenshot)
        // Thread tracker's runId into run() so Stepper + screenshot events
        // share the same id as the JSONL rows (fixed 2026-04-23 — previously
        // the inner `run()` generated its own UUID while the tracker wrote
        // `{id}#N`, desyncing screenshot-to-run correlation).
        await run(setStep, updateData, false, observer, (session, runId, stepper, trackerDir) => {
          boundScreenshot.fn = makeScreenshotFn({
            session,
            runId,
            workflow: wf.config.name,
            itemId: String(itemId),
            emit: (ev) => emitScreenshotEvent(ev, { dir: trackerDir }),
            currentStep: () => stepper.getCurrentStep(),
          })
        }, trackerRunId, emitSkipped)
      },
      {
        ...buildTrackerOpts(wf),
        preAssignedRunId: opts.preAssignedRunId,
        dir: opts.trackerDir,
        initialData: Object.keys(seedData).length > 0 ? seedData : undefined,
        ...(inputForRow ? { input: inputForRow } : {}),
        ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      },
    )
  }, opts.trackerDir)
}

export async function runWorkflowBatch<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  items: TData[],
  opts: RunOpts = {},
): Promise<BatchResult> {
  const batch = wf.config.batch
  if (batch?.mode === 'pool') {
    return runWorkflowPool(wf, items, opts)
  }
  if (batch?.mode === 'shared-context-pool') {
    return runWorkflowSharedContextPool(wf, items, opts)
  }

  // Sequential mode: strip the prefilledData channel before parsing so workflow
  // schemas don't have to know about the kernel-level edit-and-resume contract —
  // strict()-mode schemas would otherwise reject the channel as an unknown key.
  const perItem = validateAndPrepareItems(wf, items, opts, (item) => {
    const { cleaned } = splitPrefilled(item)
    wf.config.schema.parse(cleaned)
  })
  const callerPreEmits = callerPreEmitsPending(wf, opts)

  const result: BatchResult = { total: items.length, succeeded: 0, failed: 0, errors: [] }

  return withBatchLifecycle(
    {
      workflow: wf.config.name,
      systems: wf.config.systems,
      perItem: perItem.map(({ item, itemId, runId }) => ({ item, itemId, runId })),
      trackerDir: opts.trackerDir,
    },
    async ({ instance, markTerminated, makeObserver }) => {
      const { observer, getAuthTimings } = makeObserver('1')
      const session = await Session.launch(wf.config.systems, {
        authChain: wf.config.authChain,
        launchFn: opts.launchFn,
        observer,
      })

      await awaitAllSystemsReady(session, wf.config.systems)
      const authTimings = wf.config.authSteps !== false ? getAuthTimings() : undefined

      // Sequential between-items hook — skipped on the first item (fresh
      // auth state). Threaded into runOneItem via `preHandler` so hook runs
      // INSIDE withTrackedWorkflow; throws surface as `failed` tracker rows
      // just like handler throws.
      const makePreHandler = (i: number): (() => Promise<void>) | undefined => {
        if (i === 0 || !batch?.betweenItems) return undefined
        return async () => {
          for (const hook of batch.betweenItems!) {
            if (hook === 'reset-browsers') {
              const t0 = Date.now()
              for (const s of wf.config.systems) await session.reset(s.id)
              log.step(`[Batch] Reset browsers (took ${Date.now() - t0}ms)`)
            } else if (hook === 'navigate-home') {
              for (const s of wf.config.systems) await session.reset(s.id)
            } else if (hook === 'health-check') {
              for (const s of wf.config.systems) {
                if (!(await session.healthCheck(s.id))) {
                  throw new Error(`health-check failed for ${s.id}`)
                }
              }
            }
          }
        }
      }

      try {
        for (let i = 0; i < perItem.length; i++) {
          const { item, itemId, runId } = perItem[i]
          log.step(`[Batch] Item ${i + 1}/${perItem.length}: itemId='${itemId}'`)
          const r = await runOneItem({
            wf,
            session,
            item,
            itemId,
            runId,
            trackerStub: opts.trackerStub,
            trackerDir: opts.trackerDir,
            callerPreEmits,
            preHandler: makePreHandler(i),
            preAssignedInstance: instance,
            authTimings,
          })
          markTerminated(runId)
          if (r.ok) result.succeeded++
          else { result.failed++; result.errors.push({ item, error: r.error }) }
        }
      } finally {
        await session.close()
      }
      return result
    },
  )
}
