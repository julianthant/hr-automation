import type { ScenarioBeat } from "../_runtime/index.js";

/**
 * Scripted beats for a person-lookup run, mirroring the real handler's step
 * sequence (searching → cross-verification → active-status; crm-dates is
 * skipped unless `includeCrmDates`). The terminal `data.activeStatus` drives
 * the dashboard's person-lookup status extensions:
 *
 *   - `"not-found"` → `notFound` DERIVED status ("Not found" label). The
 *     automation still succeeded, so the tracker status stays `done`.
 *   - `"active"` / `"inactive"` / `"non-hdh"` → an A / IA / "Active (non-HDH
 *     dept)" SECONDARY TAG rendered alongside the base "Done" badge.
 */
export function personLookupBeats(opts: {
  searchName: string;
  emplId?: string;
  /** Terminal disposition stamped on the final row's data. */
  activeStatus: "not-found" | "active" | "inactive" | "non-hdh";
  /** Extra terminal data (e.g. department) merged onto the row. */
  finalData?: Record<string, unknown>;
}): ScenarioBeat[] {
  return [
    { kind: "updateData", data: { searchName: opts.searchName } },
    { kind: "step", name: "searching" },
    { kind: "step", name: "cross-verification" },
    {
      kind: "step",
      name: "active-status",
      updateData: {
        ...(opts.emplId ? { emplId: opts.emplId } : {}),
        activeStatus: opts.activeStatus,
        ...(opts.finalData ?? {}),
      },
    },
    { kind: "skipStep", name: "crm-dates" },
  ];
}
