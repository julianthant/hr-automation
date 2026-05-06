import {
  listWorkflows,
  readEntries,
  trackEvent,
  DEFAULT_DIR,
} from "../jsonl.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { detectFailurePattern } from "../failure-detector.js";
import { notify } from "../notify.js";
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
 * orphaned. As of 2026-04-28 (Cluster A spec), the grace is **0 ms**.
 *
 * Rationale: `ensureDaemonsAndEnqueue` was reordered so SQLite task rows are
 * only inserted AFTER `spawnDaemon` returns (lockfile registered). Therefore
 * every queued task has a registered daemon by construction;
 * "queued task + 0 alive daemons" can only happen if that daemon
 * died after writing. Failing the items immediately matches the user's
 * "if the daemon dies, fail all queued ones" rule.
 *
 * Pre-2026-04-28 the grace was 5 minutes to cover the spawn-to-lockfile
 * window; with the new ordering that window is closed. Legacy queue items
 * left over from earlier runs (where a daemon died without exit cleanup)
 * are correctly treated as orphaned and failed on first poll.
 */
const ORPHAN_QUEUE_GRACE_MS = 0;

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
 * **Grace = 0 (2026-04-28)**: with the spawn-then-enqueue reorder in
 * `ensureDaemonsAndEnqueue`, task rows are only inserted after a daemon
 * lockfile is registered. Any queued task + 0 alive daemons is a
 * genuine orphan, not a spawn-in-flight race. Failing immediately matches
 * the "daemon dies -> fail queued" rule. The legacy 5-minute grace was
 * removed because the spawn-to-lockfile window is now closed by ordering.
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
      const taskStore = createTaskStore(openControlDb({ trackerDir: dir }));
      for (const item of stale) {
        const runId = item.runId ?? `${item.id}#1`;
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
    }
  } catch (err) {
    log.warn(`scanOrphanedQueueItems skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
