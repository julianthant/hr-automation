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
  // A done verify run with unverified records keeps its green Done badge (the
  // run DID complete) but gains a warning tally chip — an unqualified Done on
  // a 0/N-verified report read as verified-ok to an operator scanning the
  // queue (E2E-011).
  secondaryTag: (entry, { isDone }) => {
    if (!isDone) return null;
    if (entry.data?.formType !== "verify") return null;
    const verified = Number.parseInt(entry.data?.verifiedCount ?? "", 10);
    const total = Number.parseInt(entry.data?.recordCount ?? "", 10);
    if (!Number.isFinite(verified) || !Number.isFinite(total) || total <= 0) return null;
    if (verified >= total) return null;
    return {
      text: `${verified}/${total} verified`,
      title: `${verified} of ${total} records verified — open the report for the unresolved records`,
      className: "bg-warning/12 text-warning border border-warning/30",
    };
  },
};
