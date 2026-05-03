import type { TrackerEntry } from "./types";

/**
 * Resolve the display name for a tracker entry. The kernel computes
 * `getName` server-side and stamps it as `data.__name`; legacy workflows
 * populate `data.name` directly; as a last resort the entry id is used.
 *
 * When a `displayNames` map is supplied (built via `buildDisplayNameMap`),
 * the precomputed "<base> <ordinal>" label takes precedence so the queue
 * shows "OCR 1", "Onboarding Roster 2", etc.
 *
 * Single source of truth for "what's this entry called" — used by QueuePanel,
 * LogPanel, and the toast system.
 */
export function resolveEntryName(
  entry: TrackerEntry,
  displayNames?: Map<string, string>,
): string {
  const fromMap = displayNames?.get(entry.id);
  if (fromMap) return fromMap;
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

/**
 * Build a per-entry "<base> <ordinal>" label map.
 *
 * The base name is the entry's existing display name (data.__name / .name /
 * .employeeName) when present, else the workflow's registry label as a
 * fallback. Entries are bucketed by base name and assigned a 1-indexed
 * ordinal in chronological order of their earliest tracker timestamp
 * (firstLogTs when known, else the entry's `timestamp`). This way:
 *
 *   - OCR rows have no `__name`, so the base is "OCR" and rows render as
 *     "OCR 1", "OCR 2", ...
 *   - SharePoint rows carry `__name = "Onboarding Roster"` (or whatever the
 *     spec label is), so they render as "Onboarding Roster 1", ...
 *
 * Pass the result as the second arg to `resolveEntryName`.
 */
export function buildDisplayNameMap(
  entries: TrackerEntry[],
  workflowLabel: string,
): Map<string, string> {
  const baseFor = (e: TrackerEntry): string => {
    const d = e.data ?? {};
    const fromData = (d.__name || d.name || d.employeeName || "").trim();
    return fromData || workflowLabel;
  };
  const sortKey = (e: TrackerEntry): string => e.firstLogTs || e.timestamp || "";
  const sorted = [...entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const counters = new Map<string, number>();
  const result = new Map<string, string>();
  for (const e of sorted) {
    const base = baseFor(e);
    const next = (counters.get(base) ?? 0) + 1;
    counters.set(base, next);
    result.set(e.id, `${base} ${next}`);
  }
  return result;
}
