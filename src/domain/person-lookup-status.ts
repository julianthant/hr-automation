/**
 * Person Lookup's queue-row status extensions.
 *
 * Owns two person-lookup-specific status rules that used to be hardcoded in the
 * generic `EntryItem` dashboard component:
 *
 *   - **notFound** — UCPath had no matching Person Org row. The automation
 *     succeeded, so the tracker status is still `done`; the queue should read
 *     "Not found" instead. Delegates to {@link isTerminalNotFoundEntry}, the
 *     same predicate the search/sort/snapshot surfaces use.
 *
 *   - **A / IA secondary tag** — Active / Inactive / "Active (non-HDH dept)"
 *     chip derived from `data.activeStatus` (`active` | `inactive` | `non-hdh`)
 *     with a legacy `isActive === "true"` fallback on terminal `done` rows.
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
    entry.status === "done" && isTerminalNotFoundEntry(entry) ? "notFound" : null,
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
