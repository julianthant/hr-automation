import type { Session } from './session.js'
import { log } from '../utils/log.js'
import { errorMessage } from '../utils/errors.js'
import { openControlDb } from './control-db.js'
import { createWorkerStore } from './worker-store.js'

/**
 * Module-level registry of fire-and-forget kernel runs that live INSIDE the
 * dashboard process (not in a separate daemon). The dashboard's
 * `/api/cancel-running` endpoint falls back here when no daemon claim is
 * found for the requested (workflow, itemId, runId) — which happens for
 * workflows like `sharepoint-download` that the dashboard launches via a
 * fire-and-forget `runWorkflow(...)` call.
 *
 * Without this registry, an in-process run stuck during `Session.launch` (e.g.
 * waiting on Duo) cannot be cancelled from the dashboard at all — the
 * cooperative `Stepper.step` cancel signal only gets checked once the handler
 * starts, and the handler can't start until auth completes. The user's only
 * recourse was restarting the dashboard.
 *
 * Cancellation strategy: hard-kill the chromium parent via
 * `session.killChromeHard()`. Pending Playwright awaits reject immediately
 * with "browser closed", `loginWithRetry`'s remaining attempts each fail
 * fast against the dead browser, then the kernel emits a `failed` tracker
 * row through the normal failure path. Total cancel-to-failed-row latency
 * is a few seconds (SIGTERM grace + 1-2 retry rounds), versus indefinite
 * Duo polling.
 */

const KEY_SEP = '::'

interface Entry {
  session: Session
  cancelled: boolean
  control?: InProcessRunControl
}

const runs = new Map<string, Entry>()

function key(workflow: string, itemId: string, runId: string): string {
  return `${workflow}${KEY_SEP}${itemId}${KEY_SEP}${runId}`
}

export interface InProcessRunIdent {
  workflow: string
  itemId: string
  runId: string
}

export interface InProcessRunControl {
  trackerDir: string
  workerId: string
  taskId: string
  attemptId: string
}

export function registerInProcessRun(
  ident: InProcessRunIdent,
  session: Session,
  control?: InProcessRunControl,
): void {
  runs.set(key(ident.workflow, ident.itemId, ident.runId), {
    session,
    cancelled: false,
    ...(control ? { control } : {}),
  })
}

export function unregisterInProcessRun(ident: InProcessRunIdent): void {
  runs.delete(key(ident.workflow, ident.itemId, ident.runId))
}

export type CancelInProcessRunResult =
  | { ok: true; alreadyCancelled: boolean }
  | { ok: false; reason: 'not-found' }

/**
 * Cancel an in-process run by hard-killing its session's chromium processes.
 * Idempotent: a second call against an already-cancelled run returns
 * `{ ok: true, alreadyCancelled: true }` so the dashboard can surface a
 * benign "already cancelling" message instead of an error.
 *
 * The session reference is left registered so a subsequent
 * `unregisterInProcessRun` call from `runWorkflow`'s `finally` block still
 * cleans up — `cancelled` is just a flag, not a removal.
 */
export async function cancelInProcessRun(
  ident: InProcessRunIdent,
): Promise<CancelInProcessRunResult> {
  const k = key(ident.workflow, ident.itemId, ident.runId)
  const entry = runs.get(k)
  if (!entry) return { ok: false, reason: 'not-found' }
  if (entry.cancelled) return { ok: true, alreadyCancelled: true }
  entry.cancelled = true
  markSqliteInProcessCancel(ident, entry.control)
  try {
    await entry.session.killChromeHard(2_000)
  } catch (err) {
    log.warn(
      `[in-process-cancel] killChromeHard failed for ${ident.workflow}/${ident.itemId}: ${errorMessage(err)}`,
    )
  }
  return { ok: true, alreadyCancelled: false }
}

export function _listInProcessRunsForTests(): string[] {
  return Array.from(runs.keys())
}

export function _resetInProcessRunsForTests(): void {
  runs.clear()
}

function markSqliteInProcessCancel(
  ident: InProcessRunIdent,
  control: InProcessRunControl | undefined,
): void {
  if (!control) return
  try {
    const workerStore = createWorkerStore(openControlDb({ trackerDir: control.trackerDir }))
    workerStore.enqueueWorkerCommand({
      commandType: 'cancel_task',
      workflow: ident.workflow,
      targetWorkerId: control.workerId,
      targetTaskId: control.taskId,
      targetAttemptId: control.attemptId,
      state: 'completed',
      payload: { itemId: ident.itemId, runId: ident.runId, source: 'in-process' },
    })
    const browsers = workerStore.listBrowserProcessesForTask({
      taskId: control.taskId,
      attemptId: control.attemptId,
    })
    for (const browser of browsers) {
      const commandId = workerStore.enqueueWorkerCommand({
        commandType: 'kill_browser',
        workflow: ident.workflow,
        targetWorkerId: browser.workerId,
        ...(browser.taskId ? { targetTaskId: browser.taskId } : {}),
        ...(browser.attemptId ? { targetAttemptId: browser.attemptId } : {}),
        targetBrowserProcessId: browser.browserProcessId,
        state: 'completed',
        payload: { pid: browser.pid, systemId: browser.systemId, source: 'in-process' },
      })
      workerStore.markBrowserProcessKillRequested({
        browserProcessId: browser.browserProcessId,
        commandId,
      })
      try {
        process.kill(browser.pid, 'SIGTERM')
      } catch {
        /* best-effort */
      }
    }
  } catch (err) {
    log.warn(
      `[in-process-cancel] SQLite control update failed for ${ident.workflow}/${ident.itemId}: ${errorMessage(err)}`,
    )
  }
}
