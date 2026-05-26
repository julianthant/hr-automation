/**
 * Unified run registry — single source of truth for "what runs are alive in
 * this process and how do I cancel one" (Contract 5 Phase 1).
 *
 * Before this module, two parallel cancellation runtimes existed:
 *   1. The daemon's `state.cancelTarget` + `state.currentRunController` pair
 *      (mutated in lockstep on every cancel path — HTTP `/cancel-current`,
 *      worker-command `cancel_task`, browser-disconnect).
 *   2. A separate `Map<workflow::itemId::runId, { session, cancelled }>` in
 *      `daemon/in-process-runs.ts` that cancelled by hard-killing chromium
 *      (the `AbortController` was NOT wired through this path).
 *
 * The split produced user-visible inconsistency — a daemon-mode cancel
 * during `waitForSelector` returned a `step: "cancelled"` row in ms via the
 * Page proxy, but an in-process cancel during Duo took seconds via the
 * SIGTERM grace and produced a generic "Browser closed" failure row.
 *
 * `RunRegistry` collapses both into one mechanism keyed by `runId`. Every
 * `runOneItem` / `runWorkflow` invocation registers a `RunHandle` on entry
 * and unregisters in `finally`. `cancel(runId, opts)` always:
 *   1. Aborts the handle's `AbortController` (the signal-injecting Page
 *      proxy rejects in-flight Playwright calls within ms).
 *   2. Writes the SQLite cancel audit when the handle carries `control`
 *      metadata (in-process runs that need the worker-command audit trail
 *      so recovery sweeps don't double-target the chromium PIDs).
 *   3. Schedules a watchdog that hard-kills chromium after
 *      `hardKillAfterMs` (default 5000ms) if the run hasn't unregistered
 *      by then — covers pre-handler launch hangs (e.g. Duo) where the
 *      AbortController hasn't been observed by anything yet.
 *
 * One registry instance per process. The daemon process has its own; the
 * dashboard process has its own. They don't need to share because each
 * process can only cancel runs it owns.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { Session } from './kernel/session.js'
import type { ControlDb } from './control-db.js'
import type { ControlTaskStore } from './task-store/index.js'
import type { ControlWorkerStore } from './daemon/worker-store.js'
import { log } from '../utils/log.js'
import { errorMessage } from '../utils/errors.js'

/**
 * Optional SQLite audit context for in-process runs.
 *
 * When present on a `RunHandle`, `RunRegistry.cancel` writes a `cancel_task`
 * worker command + per-chromium-PID `kill_browser` commands (state =
 * "completed", so they are pure audit records, not driving any other
 * worker), and SIGTERMs the chromium PIDs directly. The daemon-side
 * `recoverClaimsFromDeadOrStaleWorkers` sweep then knows the browsers were
 * intentionally taken down and won't try to re-kill them.
 *
 * Absent on daemon-source handles — for those, the cancel SQLite trail
 * lives in `buildCancelRunningHandler` (which enqueues the `cancel_task`
 * command and lets the daemon's poller route through `RunRegistry.cancel`).
 */
export interface RunControlAudit {
  trackerDir: string
  workerId: string
  taskId: string
  attemptId: string
  controlDb: ControlDb
  taskStore: ControlTaskStore
  workerStore: ControlWorkerStore
}

/**
 * The unified handle for an in-flight run — daemon or in-process.
 *
 * `controller.signal` is the single source of truth for "operator wants
 * this run cancelled". It rides on `ctx.signal` (auto-injected into
 * Playwright methods via the Page proxy) so an in-flight `waitForSelector`
 * / `click` / `goto` rejects within ms instead of waiting on its declared
 * timeout. The stepper's between-step `isCancelRequested` probe reads the
 * same signal as a synchronous-checkpoint when no Playwright call is in
 * flight.
 *
 * `session` is the watchdog fallback only — if `cancel` aborts the
 * controller but the run doesn't unregister within `hardKillAfterMs`
 * (e.g. stuck on Duo before the handler starts, so nothing observes the
 * signal yet), `killChromeHard` is called to force teardown.
 */
export interface RunHandle {
  runId: string
  itemId: string
  workflow: string
  controller: AbortController
  session: Session
  startedAt: number
  /** Debug/audit only — `cancel` does not branch on this. */
  source: 'daemon' | 'in-process'
  /** Daemon-only — for worker-command targeting + heartbeat + shutdown reads. */
  taskId?: string
  attemptId?: string
  /** In-process-only — when present, cancel writes the SQLite audit trail. */
  control?: RunControlAudit
}

export interface CancelOptions {
  /**
   * Free-form label included in the abort reason + audit log. Helps
   * trace which trigger fired (`http_cancel_current`, `worker_command`,
   * `browser_disconnect`, `daemon_shutdown`, …).
   */
  reason: string
  /**
   * Watchdog timeout. After abort, if the run hasn't unregistered by
   * this many ms, the watchdog calls `session.killChromeHard()` to force
   * teardown. Default 5000ms; pass 0 to disable the watchdog entirely
   * (used by `daemon_shutdown` where chromium is already being torn down
   * by `abortLaunchAndKillSession`).
   */
  hardKillAfterMs?: number
}

export type CancelResult =
  | { ok: true; alreadyCancelled: boolean; hardKilled: boolean }
  | { ok: false; reason: 'not-found' }

export interface RunRegistry {
  register(handle: RunHandle): void
  get(runId: string): RunHandle | undefined
  list(): RunHandle[]
  unregister(runId: string): void
  cancel(runId: string, opts: CancelOptions): Promise<CancelResult>
}

const DEFAULT_HARD_KILL_AFTER_MS = 5_000
const KILL_CHROME_GRACE_MS = 2_000

/**
 * Construct a fresh `RunRegistry`. Production code uses the module-level
 * `runRegistry` singleton; tests use `createRunRegistry()` for isolation
 * or call `_resetRunRegistryForTests()` to clear the singleton.
 */
export function createRunRegistry(): RunRegistry {
  const handles = new Map<string, RunHandle>()
  /**
   * Per-runId "cancel already fired" flag. Separate from
   * `controller.signal.aborted` so a second cancel can return
   * `alreadyCancelled: true` even if the controller was aborted by some
   * other code path (a handler internally calling `controller.abort()`
   * for finer-grain reasons, the parent-signal hook in delegation, …).
   */
  const cancelled = new Set<string>()

  const register = (handle: RunHandle): void => {
    handles.set(handle.runId, handle)
  }

  const get = (runId: string): RunHandle | undefined => handles.get(runId)

  const list = (): RunHandle[] => Array.from(handles.values())

  const unregister = (runId: string): void => {
    handles.delete(runId)
    cancelled.delete(runId)
  }

  const cancel = async (
    runId: string,
    opts: CancelOptions,
  ): Promise<CancelResult> => {
    const handle = handles.get(runId)
    if (!handle) return { ok: false, reason: 'not-found' }
    if (cancelled.has(runId)) {
      return { ok: true, alreadyCancelled: true, hardKilled: false }
    }
    cancelled.add(runId)

    if (!handle.controller.signal.aborted) {
      // Best-effort: the controller's abort() with a reason argument is
      // standard since Node 17. Callers see the reason as the rejection of
      // any AbortSignal-aware await downstream.
      handle.controller.abort(new Error(`cancel requested (${opts.reason})`))
    }

    if (handle.control) {
      writeInProcessCancelAudit(handle)
    }

    const hardKillAfterMs = opts.hardKillAfterMs ?? DEFAULT_HARD_KILL_AFTER_MS
    if (hardKillAfterMs === 0) {
      return { ok: true, alreadyCancelled: false, hardKilled: false }
    }

    // Race: handle gets unregistered (graceful unwind via runOneItem's
    // finally) vs. watchdog timeout. Polling-based to avoid wiring an
    // EventTarget through every handle; 50ms granularity is plenty for a
    // 5s-default window.
    const watchdog = await waitForUnregisterOrTimeout(runId, handles, hardKillAfterMs)
    if (watchdog === 'unregistered') {
      return { ok: true, alreadyCancelled: false, hardKilled: false }
    }
    // Timeout: the run is still registered — operator wants it gone.
    // killChromeHard is best-effort (the session may have no chromium PIDs
    // if it's a worker session); failures never propagate.
    try {
      await handle.session.killChromeHard(KILL_CHROME_GRACE_MS)
    } catch (err) {
      log.warn(
        `[run-registry] killChromeHard failed for ${handle.workflow}/${handle.itemId} runId=${runId}: ${errorMessage(err)}`,
      )
    }
    return { ok: true, alreadyCancelled: false, hardKilled: true }
  }

  return { register, get, list, unregister, cancel }
}

async function waitForUnregisterOrTimeout(
  runId: string,
  handles: Map<string, RunHandle>,
  timeoutMs: number,
): Promise<'unregistered' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  const POLL_MS = 50
  while (Date.now() < deadline) {
    if (!handles.has(runId)) return 'unregistered'
    const remaining = Math.max(0, deadline - Date.now())
    await sleep(Math.min(POLL_MS, remaining))
  }
  return handles.has(runId) ? 'timeout' : 'unregistered'
}

/**
 * Replicates the audit-write logic that previously lived in
 * `daemon/in-process-runs.ts#markSqliteInProcessCancel`. Called only when
 * the handle was registered with an in-process `RunControlAudit`. Best-
 * effort: SQLite errors are logged but never throw, so a transient DB
 * issue cannot block the abort from taking effect.
 */
function writeInProcessCancelAudit(handle: RunHandle): void {
  const control = handle.control
  if (!control) return
  try {
    control.workerStore.enqueueWorkerCommand({
      commandType: 'cancel_task',
      workflow: handle.workflow,
      targetWorkerId: control.workerId,
      targetTaskId: control.taskId,
      targetAttemptId: control.attemptId,
      state: 'completed',
      payload: { itemId: handle.itemId, runId: handle.runId, source: 'in-process' },
    })
    const browsers = control.workerStore.listBrowserProcessesForTask({
      taskId: control.taskId,
      attemptId: control.attemptId,
    })
    for (const browser of browsers) {
      const commandId = control.workerStore.enqueueWorkerCommand({
        commandType: 'kill_browser',
        workflow: handle.workflow,
        targetWorkerId: browser.workerId,
        ...(browser.taskId ? { targetTaskId: browser.taskId } : {}),
        ...(browser.attemptId ? { targetAttemptId: browser.attemptId } : {}),
        targetBrowserProcessId: browser.browserProcessId,
        state: 'completed',
        payload: { pid: browser.pid, systemId: browser.systemId, source: 'in-process' },
      })
      control.workerStore.markBrowserProcessKillRequested({
        browserProcessId: browser.browserProcessId,
        commandId,
      })
      try {
        process.kill(browser.pid, 'SIGTERM')
      } catch {
        /* best-effort — process may already be dead */
      }
    }
  } catch (err) {
    log.warn(
      `[run-registry] SQLite control update failed for ${handle.workflow}/${handle.itemId}: ${errorMessage(err)}`,
    )
  }
}

/**
 * Module-level singleton. Daemon and dashboard processes each get their
 * own copy by virtue of being separate Node processes; this module is
 * imported in both, but each process has its own ES module instance.
 */
export const runRegistry: RunRegistry = createRunRegistry()

/** Test helper — clear every registered run. Mirrors the prior `_resetInProcessRunsForTests`. */
export function _resetRunRegistryForTests(): void {
  for (const handle of runRegistry.list()) {
    runRegistry.unregister(handle.runId)
  }
}

/** Test helper — runIds of every registered run, in insertion order. */
export function _listRunRegistryForTests(): string[] {
  return runRegistry.list().map((h) => h.runId)
}
