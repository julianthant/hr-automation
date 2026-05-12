/**
 * Dashboard queue / search surfaces use raw tracker `status` ("done", …).
 * EID lookup and Active Check stamp a business outcome in `data` when no
 * Person Org row is found; those runs still emit `status: "done"` because the
 * automation succeeded. Operators should see "Not found" instead of "Done"
 * in the queue and related UI.
 */

export const TERMINAL_NOT_FOUND_LABEL = "Not found";

export function isTerminalNotFoundEntry(entry: {
  workflow: string;
  status: string;
  data?: Record<string, unknown>;
}): boolean {
  if (entry.status !== "done") return false;
  const w = entry.workflow;
  const d = entry.data ?? {};
  const s = (key: string): string => {
    const v = d[key];
    return v == null ? "" : String(v);
  };
  if (w === "eid-lookup") {
    return s("emplId") === "Not found" || s("hrStatus") === "Not found";
  }
  if (w === "active-check") {
    return s("activeStatus") === "not-found" || s("hrStatus") === "Not found";
  }
  return false;
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
