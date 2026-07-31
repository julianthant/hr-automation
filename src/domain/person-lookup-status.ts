/**
 * Person Lookup's queue-row status extensions.
 *
 * Owns two person-lookup-specific status rules that used to be hardcoded in the
 * generic `EntryItem` dashboard component:
 *
 *   - **notFound** — Search mode's Person Org/CRM chain resolved to terminal
 *     `activeStatus: "not-found"`, or Match mode's HR-Tasks search stamped
 *     `found: "false"`. The automation succeeded, so tracker status remains
 *     `done`; the queue should still present the negative business answer.
 *
 *   - **A / IA secondary tag** — Active / Inactive / "Active (non-HDH dept)"
 *     chip derived from `data.activeStatus` (`active` | `inactive` | `non-hdh`)
 *     with a legacy `isActive === "true"` fallback on terminal `done` rows.
 *     `n/a` (CRM-only) intentionally shows no chip.
 *
 * Lives in the domain layer (not `src/workflows/person-lookup/`) so the
 * dashboard can resolve it without importing a `src/workflows/*` module — the
 * person-lookup `defineWorkflow` call re-exports this object as its
 * `statusExtensions` declaration.
 */
import { isTerminalNotFoundEntry } from "./tracker-terminal-display.js";
import type { WorkflowStatusExtensions } from "./queue-row-status.js";

export const personLookupStatusExtensions: WorkflowStatusExtensions = {
  derivedStatus: (entry) =>
    entry.status === "done" &&
    (isTerminalNotFoundEntry(entry) || entry.data?.found === "false")
      ? "notFound"
      : null,
  secondaryTag: (entry, { isDone }) => {
    const activeStatus =
      typeof entry.data?.activeStatus === "string" ? entry.data.activeStatus : null;
    if (activeStatus === "inactive") {
      return {
        text: "IA",
        title: "Inactive",
        className: "bg-warning/12 text-warning border border-warning/30",
      };
    }
    if (
      activeStatus === "active" ||
      activeStatus === "non-hdh" ||
      (isDone && entry.data?.isActive === "true")
    ) {
      return {
        text: "A",
        title: activeStatus === "non-hdh" ? "Active (non-HDH dept)" : "Active",
        className: "bg-success/12 text-success border border-success/30",
      };
    }
    return null;
  },
};
