import type { TrackerEntry } from "./types";

/**
 * Resolve the display name for a tracker entry. The kernel computes
 * `getName` server-side and stamps it as `data.__name`; legacy workflows
 * populate `data.name` directly; as a last resort the entry id is used.
 *
 * Single source of truth for "what's this entry called" — used by QueuePanel,
 * LogPanel, and the toast system.
 */
export function resolveEntryName(entry: TrackerEntry): string {
  const d = entry.data ?? {};
  return d.__name || d.name || d.employeeName || "";
}

/**
 * Resolve the display id for a tracker entry. Prefers the server-computed
 * `getId` result (`data.__id`), falls back to `entry.id`.
 */
export function resolveEntryId(entry: TrackerEntry): string {
  const d = entry.data ?? {};
  return d.__id || entry.id;
}
