import type { RegisteredWorkflow } from "./kernel/types.js";
import { trackEvent } from "../tracker/jsonl.js";
import { operatorSubjectData } from "../domain/operator-subject.js";

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
    const typed = item as TData;
    const subject = opts.workflow.config.operatorSubject?.(typed);
    const id = opts.deriveId?.(typed, runId) ?? runId;
    trackEvent(
      {
        workflow: opts.workflow.config.name,
        timestamp: now,
        id,
        runId,
        status: "pending",
        data: {
          ...opts.buildPendingData(typed, runId),
          ...operatorSubjectData(subject),
        },
      },
      opts.trackerDir,
    );
  };
}
