import {
  listWorkflows,
  readEntries,
  trackEvent,
  DEFAULT_DIR,
} from "../jsonl.js";
import { log } from "../../utils/log.js";
import { detectFailurePattern } from "../alerts/failure-detector.js";
import { notify } from "../alerts/notify.js";
import { findAliveDaemons } from "../../core/daemon/registry.js";
import { readQueueState, markItemFailed } from "../../core/daemon/queue.js";
import { buildTrackerDataForInput } from "../../core/daemon/enqueue-dispatch.js";
import { openControlDb } from "../../core/control-db.js";
import { createTaskStore } from "../../core/task-store/index.js";

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
 * Scan the current day's tracker entries across all known workflows for
 * repeated-failure patterns. Fires macOS notifications + log.warn for any
 * pattern that crosses the threshold and isn't in cooldown. Best-effort -
 * a notification failure never stalls the SSE poll cycle.
 *
 * Pulled out of the `/events` handler so it can be smoke-tested in isolation.
 */
export async function scanFailurePatterns(): Promise<void> {
  try {
    const workflows = listWorkflows();
    // Read today's entries for every workflow - concat and scan in one go.
    // The detector groups by (workflow, error) so cross-workflow mixing is fine.
    const all = workflows.flatMap((w) => readEntries(w));
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
