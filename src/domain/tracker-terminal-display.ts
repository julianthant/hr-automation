/**
 * Dashboard queue / search surfaces use raw tracker `status` ("done", …).
 * Person Lookup stamps a business outcome in `data` when BOTH UCPath and CRM
 * miss; those runs still emit `status: "done"` because the automation
 * succeeded. Operators should see "Not found" instead of "Done" in the queue
 * and related UI. A CRM-only hit uses `activeStatus: "n/a"` and is not treated
 * as terminal not-found.
 */

export const TERMINAL_NOT_FOUND_LABEL = "Not found";

export function isTerminalNotFoundEntry(entry: {
  workflow: string;
  status: string;
  data?: Record<string, unknown>;
}): boolean {
  if (entry.status !== "done") return false;
  const d = entry.data ?? {};
  return entry.workflow === "person-lookup" && d.activeStatus === "not-found";
}

/** Badge / pill text: either {@link TERMINAL_NOT_FOUND_LABEL} or the raw status. */
export function queueStatusDisplayLabel(entry: {
  workflow: string;
  status: string;
  data?: Record<string, unknown>;
}): string {
  if (isTerminalNotFoundEntry(entry)) return TERMINAL_NOT_FOUND_LABEL;
  return entry.status;
}
