import {
  listWorkflows,
  readEntries,
  trackEvent,
  dateLocal,
  DEFAULT_DIR,
} from "../jsonl.js";
import type { TrackerEntry } from "../jsonl.js";
import { log } from "../../utils/log.js";
import { detectFailurePattern } from "../alerts/failure-detector.js";
import { notify } from "../alerts/notify.js";
import { findAliveDaemons } from "../../core/daemon/registry.js";
import { readQueueState, markItemFailed } from "../../core/daemon/queue.js";
import { buildTrackerDataForInput } from "../../core/daemon/enqueue-dispatch.js";
import { openControlDb } from "../../core/control-db.js";
import { createTaskStore } from "../../core/task-store/index.js";
import type { Database } from "../../infra/sqlite/index.js";

/**
 * Cooldown map for failure-pattern alerts. Module-level so it survives the
 * lifetime of the dashboard process - keyed by `${workflow}:${error}`, value
 * is the last-alerted ms timestamp. Exposed via `__resetFailureAlertCooldown`
 * for test isolation.
 */
const failureAlertCooldown = new Map<string, number>();

/**
 * Test helper - clears the cooldown map so tests can re-run scans without
 * state bleed. Not part of the public API.
 */
export function __resetFailureAlertCooldown(): void {
  failureAlertCooldown.clear();
}

/**
 * Read today's failed entries for failure-pattern detection.
 *
 * SQLite path (when projection is ready): one indexed SELECT on
 * `run_events WHERE status = 'failed' AND error IS NOT NULL` for all workflows
 * on today's date. Uses `idx_run_events_workflow_date` so the scan is bounded
 * to today's rows only — avoids the full-table read the JSONL path incurs.
 *
 * JSONL fallback: per-workflow `readEntries` (unchanged behavior).
 */
function readFailedEntriesForScan(
  stateDb: Database | null,
  projectionReady: boolean,
  dir: string,
): TrackerEntry[] {
  if (projectionReady && stateDb) {
    try {
      const today = dateLocal();
      const rows = stateDb.prepare(`
        SELECT workflow, item_id AS id, run_id AS runId, event_ts AS timestamp, error
        FROM run_events
        WHERE tracker_date = @date
          AND status = 'failed'
          AND error IS NOT NULL
          AND error != ''
      `).all({ date: today }) as Array<{
        workflow: string;
        id: string;
        runId: string;
        timestamp: string;
        error: string;
      }>;
      return rows.map((r) => ({
        workflow: r.workflow,
        id: r.id,
        runId: r.runId,
        timestamp: r.timestamp,
        status: "failed" as const,
        error: r.error,
        data: {},
      }));
    } catch (err) {
      log.warn(
        `[sweeps] SQLite failed-entries read error, falling back to JSONL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  // JSONL fallback — same as before.
  const workflows = listWorkflows(dir);
  return workflows.flatMap((w) => readEntries(w, dir));
}

/**
 * Scan the current day's tracker entries across all known workflows for
 * repeated-failure patterns. Fires macOS notifications + log.warn for any
 * pattern that crosses the threshold and isn't in cooldown. Best-effort -
 * a notification failure never stalls the SSE poll cycle.
 *
 * Pulled out of the `/events` handler so it can be smoke-tested in isolation.
 *
 * @param stateDb  - Live SQLite handle from `createDashboardServer` (or null
 *   when called from tests / paths without a projection). When non-null and
 *   `projectionReady` is true the SQLite fast-path is used; otherwise falls
 *   back to the JSONL `readEntries` scan.
 * @param projectionReady - Mirror of `deps.projectionReady` from the server
 *   startup. Keeps the same dual-path gate used everywhere else in the module.
 * @param dir - Tracker dir (default `.tracker`).
 */
export async function scanFailurePatterns(
  stateDb: Database | null = null,
  projectionReady = false,
  dir = DEFAULT_DIR,
): Promise<void> {
  try {
    const all = readFailedEntriesForScan(stateDb, projectionReady, dir);
    const patterns = detectFailurePattern(all, {
      cooldownState: failureAlertCooldown,
    });
    for (const p of patterns) {
      const windowMin = Math.round((Date.parse(p.lastTs) - Date.parse(p.firstTs)) / 60_000) || 1;
      const msg = `${p.workflow}: ${p.count}x ${p.error} in ${windowMin}m`;
      log.warn(`failure pattern detected - ${msg}`);
      // Don't block the poll cycle waiting for osascript - fire-and-forget.
      void notify("HR automation: failures", msg);
    }
  } catch (err) {
    // Best-effort - never crash the poll cycle.
    log.warn(`scanFailurePatterns skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Grace period before treating a queued-with-no-alive-daemons item as truly
 * orphaned. Dashboard-initiated delegation can enqueue before a just-spawned
 * daemon has finished browser launch, Duo, and lockfile registration; failing
 * immediately blocks the parent workflow even though the daemon is healthy.
 */
const ORPHAN_QUEUE_GRACE_MS = 5 * 60 * 1000;

/**
 * Safety net: detect queued items whose workflow has zero alive daemons,
 * mark them failed in both the SQLite queue and the tracker so the dashboard's
 * pending rows don't stick when the daemon's own teardown cleanup didn't run
 * (force-kill, OS crash, daemon process killed without graceful exit).
 *
 * Runs alongside `scanFailurePatterns` from the `/events` SSE poll. Cheap:
 * one `readQueueState` + one `findAliveDaemons` per workflow with non-empty
 * queue. Idempotent - once an item is marked failed, the next pass sees
 * `state.queued.length === 0` for that id.
 *
 * **Grace = 5 minutes**: a new daemon may spend several minutes in
 * browser/auth/Duo startup before it is visible to `findAliveDaemons`.
 * Within that window, "queued task + 0 alive daemons" can be a legitimate
 * spawn-in-flight state, not an orphan.
 *
 * Does NOT touch claimed items: those are owned by a daemon (alive or
 * recently dead). The daemon's own `recoverOrphanedClaims` keepalive sweep
 * handles dead-daemon claim recovery; this sweep handles "queued, no one to
 * pick up" specifically.
 */
export async function scanOrphanedQueueItems(dir = DEFAULT_DIR): Promise<void> {
  try {
    const workflows = listWorkflows(dir);
    const nowMs = Date.now();
    for (const wf of workflows) {
      const state = await readQueueState(wf, dir);
      if (state.queued.length === 0) continue;
      // Filter to items that have aged past the grace window. If everything
      // queued is fresh, skip the alive-daemon probe entirely.
      const stale = state.queued.filter((item) => {
        const enqMs = Date.parse(item.enqueuedAt);
        if (!Number.isFinite(enqMs)) return true; // unparseable -> treat as old
        return nowMs - enqMs >= ORPHAN_QUEUE_GRACE_MS;
      });
      if (stale.length === 0) continue;
      const alive = await findAliveDaemons(wf, dir);
      if (alive.length > 0) continue;
      log.warn(
        `[orphan-sweep] ${wf}: ${stale.length} queued item(s) past grace with 0 alive daemons; marking failed`,
      );
      const nowIso = new Date().toISOString();
      const failError =
        "No alive daemon available to process this item. Start a daemon and retry.";
      const controlDb = openControlDb({ trackerDir: dir });
      try {
        const taskStore = createTaskStore(controlDb);
        for (const item of stale) {
          const runId = item.runId;
          if (!runId) {
            log.warn(`[orphan-sweep] ${wf}: item ${item.id} has no runId — skipping`);
            continue;
          }
          try {
            await markItemFailed(wf, item.id, failError, runId, dir);
            if (item.taskId) {
              taskStore.markDependencyFromChildTerminal({
                childTaskId: item.taskId,
                childState: "failed",
              });
            }
          } catch {
            /* best-effort */
          }
          try {
            // Same shape as the pending row from `onPreEmitPending` so
            // prefilledData (edit-and-resume) lands as flat top-level keys.
            // Otherwise the failed row's barer `data` overrides the pending
            // row in the dashboard's latest-per-id dedupe and the user's
            // edits disappear from the detail grid.
            const data = buildTrackerDataForInput(item.input);
            trackEvent(
              {
                workflow: wf,
                timestamp: nowIso,
                id: item.id,
                runId,
                status: "failed",
                data,
                error: failError,
              },
              dir,
            );
          } catch {
            /* best-effort */
          }
        }
      } finally {
        controlDb.close();
      }
    }
  } catch (err) {
    log.warn(`scanOrphanedQueueItems skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
