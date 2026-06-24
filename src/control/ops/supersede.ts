/**
 * Enqueue supersede: enforce ONE active run per queue row.
 *
 * The dashboard's fresh input-run path (`POST /api/enqueue` →
 * `enqueueFromHttp`) mints a new `runId` + new SQLite task on every submit, and
 * its only de-dupe is the exact `(workflow, itemId, runId)` tuple — which never
 * matches a fresh run. So re-submitting the same EID/doc id stacked up multiple
 * `queued` runs for one row ("only 1 run can be queued at a time" was violated).
 *
 * This handler closes that gap the same way the retry path already does
 * (`ACTIVE_STATES_BLOCKING_RETRY` in `ops/retry.ts`): before a new run is
 * written, cancel every prior NON-TERMINAL root run for the same item, so the
 * latest run supersedes the rest. It is wired in via `enqueueFromHttp`'s
 * `supersedePriorRuns` option, fired from the kernel's `onPreparedItems` hook —
 * after stable itemIds/runIds are assigned but BEFORE the new pending row and
 * task are written, so `listActiveRootTasksForItem` sees only prior runs.
 *
 * Scope is deliberate:
 *   - ROOT runs only (`parent_run_id IS NULL`, enforced by the query) — a
 *     delegated OCR/batch member is never disturbed by a re-issued root run.
 *   - Both queued AND in-flight prior runs are cancelled (operator intent:
 *     "if a new run is issued all old runs are cancelled"). Narrow `RUNNING_
 *     STATES` → drop in-flight cancellation if a re-run should never interrupt
 *     a live automation.
 *
 * Best-effort: a cancel that fails (e.g. the prior run terminated in the race
 * window, or its tracker row is missing) is logged and skipped — superseding a
 * prior run must never block the new run from enqueuing.
 */
import { buildCancelQueuedHandler, buildCancelRunningHandler } from "./cancel.js";
import { openControlStores } from "./shared.js";
import { log } from "../../utils/log.js";

/** Control states that route through the running-cancel handler (vs queued). */
const RUNNING_STATES = new Set(["claimed", "running", "cancel_requested", "cancelling"]);

export interface SupersedePriorRunsRequest {
  workflow: string;
  /** Item ids of the runs about to be enqueued. */
  itemIds: string[];
  /** New runIds about to be enqueued — never cancelled even if already present. */
  exceptRunIds?: string[];
}

export interface SupersedePriorRunsResult {
  /** Number of prior runs cancelled across all items. */
  cancelled: number;
}

/**
 * Build the supersede handler bound to a tracker dir. Returns a function that,
 * given the items about to be enqueued, cancels any prior non-terminal root
 * run for the same `(workflow, itemId)`.
 */
export function buildSupersedePriorRunsHandler(dir: string) {
  const cancelQueued = buildCancelQueuedHandler(dir);
  const cancelRunning = buildCancelRunningHandler(dir);
  return async (req: SupersedePriorRunsRequest): Promise<SupersedePriorRunsResult> => {
    if (!req.workflow || req.itemIds.length === 0) return { cancelled: 0 };
    const except = new Set(req.exceptRunIds ?? []);
    const stores = openControlStores(dir);
    let cancelled = 0;

    for (const itemId of new Set(req.itemIds)) {
      let active: ReturnType<typeof stores.taskStore.listActiveRootTasksForItem>;
      try {
        active = stores.taskStore.listActiveRootTasksForItem({ workflow: req.workflow, itemId });
      } catch (err) {
        log.warn(
          `[supersede] could not list prior runs for ${req.workflow}/${itemId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }

      for (const task of active) {
        if (task.runId && except.has(task.runId)) continue;
        try {
          const result =
            task.runId && RUNNING_STATES.has(task.controlState)
              ? await cancelRunning({ workflow: req.workflow, id: itemId, runId: task.runId })
              : await cancelQueued({
                  workflow: req.workflow,
                  id: itemId,
                  ...(task.runId ? { runId: task.runId } : {}),
                });
          if (result.ok) {
            cancelled++;
            log.step(
              `[supersede] cancelled prior ${req.workflow}/${itemId} run=${task.runId ?? "?"} (was ${task.controlState}) — superseded by a newer run`,
            );
          } else {
            log.step(
              `[supersede] skipped prior ${req.workflow}/${itemId} run=${task.runId ?? "?"} (${task.controlState}): ${result.error}`,
            );
          }
        } catch (err) {
          log.warn(
            `[supersede] cancel threw for ${req.workflow}/${itemId} run=${task.runId ?? "?"}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return { cancelled };
  };
}
