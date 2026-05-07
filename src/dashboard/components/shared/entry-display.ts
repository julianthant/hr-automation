import type { TrackerEntry } from "./types";

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function resolveEmployeeLabel(data: Record<string, string>): string {
  const directName = firstNonBlank(data.name, data.employeeName, data.searchName);
  if (directName) return directName;

  const subjectKind = data.__subjectKind;
  if (subjectKind === "person" || subjectKind === "eid" || subjectKind === "email") {
    return firstNonBlank(data.__name);
  }

  return "";
}

/**
 * Resolve the display name for a tracker entry. The kernel stamps the
 * operator-facing label as `data.__subject`; older rows may only have
 * `data.__name` or workflow-owned name fields.
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
  return resolveEmployeeLabel(d) || d.__name || d.__subject || "";
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
 * Build a per-entry display label map.
 *
 * The base name is the entry's existing display name (data.__subject /
 * data.__name / .name / .employeeName) when present, else the workflow's registry label as a
 * fallback. Person rows keep their literal operator-facing name. Workflow-level
 * rows are bucketed by base name and assigned a 1-indexed ordinal in
 * chronological order of their earliest tracker timestamp (firstLogTs when
 * known, else the entry's `timestamp`). This way:
 *
 *   - EID rows render as "Zaw, Hein Thant" rather than "Zaw, Hein Thant 1".
 *   - OCR rows use a workflow-level label, so rows render as
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
  const displayFor = (e: TrackerEntry): { base: string; ordinal: boolean } => {
    const d = e.data ?? {};
    const personName = resolveEmployeeLabel(d);
    if (personName) return { base: personName, ordinal: false };
    const workflowName = firstNonBlank(d.__name);
    return { base: workflowName || workflowLabel, ordinal: true };
  };
  const sortKey = (e: TrackerEntry): string => e.firstLogTs || e.timestamp || "";
  const sorted = [...entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const counters = new Map<string, number>();
  const result = new Map<string, string>();
  for (const e of sorted) {
    const { base, ordinal } = displayFor(e);
    if (!ordinal) {
      result.set(e.id, base);
      continue;
    }
    const next = (counters.get(base) ?? 0) + 1;
    counters.set(base, next);
    result.set(e.id, `${base} ${next}`);
  }
  return result;
}
