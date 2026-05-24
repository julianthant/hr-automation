import type { RegisteredWorkflow } from "./kernel/types.js";
import { buildPendingTrackerData } from "./pending-data.js";
import { emitTrackerRow } from "../tracker/jsonl.js";

/**
 * Build an `onPreEmitPending` callback for use with `runWorkflowBatch`.
 *
 * Handles the boilerplate every in-process batch path duplicated: snapshot
 * the timestamp once for the batch, resolve the operator subject per item,
 * and call `trackEvent` with a `pending` row.
 *
 * Use for **in-process** `runWorkflowBatch` paths. Daemon-mode paths go
 * through `buildCliAdapter` in `src/core/cli-adapter.ts`, which covers the
 * same pattern for `ensureDaemonsAndEnqueue`.
 *
 * @param workflow - The registered workflow (provides name + operatorSubject).
 * @param buildPendingData - Return the workflow-specific fields to merge into
 *   `data` alongside the operator-subject fields.
 * @param deriveId - Optional: derive the tracker row's `id` from the item.
 *   Defaults to `runId`.
 * @param trackerDir - Optional tracker directory override (tests use this).
 */
export function buildBatchPreEmitPending<TData>(opts: {
  workflow: RegisteredWorkflow<TData, readonly string[]>;
  buildPendingData: (item: TData, runId: string) => Record<string, string>;
  deriveId?: (item: TData, runId: string) => string;
  trackerDir?: string;
}): (item: unknown, runId: string) => void {
  const now = new Date().toISOString();
  return (item: unknown, runId: string) => {
    // Validate the item against the workflow schema BEFORE reading typed
    // properties. Pre-emit runs before runOneItem, so a malformed row would
    // otherwise crash inside operatorSubject/buildPendingData with no tracker
    // breadcrumb. Throws with "validation error" prefix so the kernel's
    // /validation/i classifier picks it up.
    let typed: TData;
    try {
      typed = opts.workflow.config.schema.parse(item) as TData;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `validation error in buildBatchPreEmitPending (workflow=${opts.workflow.config.name}, runId=${runId}): ${msg}`,
        { cause: err },
      );
    }
    const id = opts.deriveId?.(typed, runId) ?? runId;
    const data = buildPendingTrackerData({
      workflow: opts.workflow,
      input: typed,
      extraData: opts.buildPendingData(typed, runId),
      nameIdStamp: "omit",
    });
    emitTrackerRow(
      {
        workflow: opts.workflow.config.name,
        timestamp: now,
        id,
        runId,
        status: "pending",
        data,
      },
      opts.trackerDir,
    );
  };
}
