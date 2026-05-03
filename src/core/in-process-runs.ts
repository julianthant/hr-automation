import type { Session } from './session.js'
import { log } from '../utils/log.js'
import { errorMessage } from '../utils/errors.js'

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

export function registerInProcessRun(ident: InProcessRunIdent, session: Session): void {
  runs.set(key(ident.workflow, ident.itemId, ident.runId), { session, cancelled: false })
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
