/**
 * OCR's queue-row status extensions.
 *
 * Owns the **needsReview** derived status that used to be hardcoded in the
 * generic `EntryItem` dashboard component: a delegated OCR row
 * (`parentRunId` set) that is awaiting operator approval. Under the
 * 2026-05-25 approval contract these rows carry `status: "running"` +
 * `step: "awaiting-approval"`, but the queue should read "Needs review".
 * Delegates to {@link isDelegatedOcrAwaitingApprovalEntry}, the same predicate
 * the queue-row-count and footer-action surfaces use.
 *
 * Co-located with the predicate (here in `tracker/dashboard/`, the predicate's
 * home) rather than under `src/workflows/ocr/`, so the dashboard can resolve it
 * without importing a `src/workflows/*` module — OCR's `defineWorkflow` call
 * re-exports this object as its `statusExtensions` declaration.
 */
import type { WorkflowStatusExtensions } from "../../domain/queue-row-status.js";
import { isDelegatedOcrAwaitingApprovalEntry } from "./prep-rows.js";

export const ocrStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) =>
    isDelegatedOcrAwaitingApprovalEntry(entry) ? "needsReview" : null,
};
