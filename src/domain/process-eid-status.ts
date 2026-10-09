import type { WorkflowStatusExtensions } from "./queue-row-status.js";

/**
 * Process EID business outcomes are terminal successful reads, not automation
 * failures. Replace the generic Done badge with the answer the operator needs
 * for manual roster transcription.
 */
export const processEidStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) => {
    if (entry.status !== "done") return null;
    if (entry.data?.eidResult === "Found") return "eidFound";
    if (entry.data?.eidResult === "Pending") return "eidPending";
    if (entry.data?.eidResult === "Not found") return "notFound";
    return null;
  },
};
