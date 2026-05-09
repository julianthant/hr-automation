import type { TrackerEntry } from "./types";
export {
  groupMergedTrackerEntries as groupMergedEntries,
  type MergedEntryGroup,
} from "../../../tracker/queue-row-count.js";

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
 * Suppress cancelled entries whose identifier is already covered by a
 * done/running entry in the same view.
 *
 * Two paths to a match:
 *
 *   1. Name → EID: a name-based check (entry.id = "Langley, Leo") is
 *      cancelled, and an EID-based done/running check resolves to
 *      data.name = "Langley, Leo". coveredIds picks up the name; the
 *      cancelled entry's id is in there → suppress.
 *
 *   2. EID via history: the cancelled name-based entry's latest tracker row
 *      has no emplId (cleanup row carries only the raw input), but an
 *      earlier successful run resolved one. `useEntries` carries that
 *      resolved emplId forward onto the entry's data, so we can match it
 *      against an EID-based done entry's id even when that done entry
 *      returned "not-found" (no name to match in path 1).
 *
 * Only cancelled entries are suppressed — genuine failures stay visible so
 * the operator can see what went wrong.
 */
export function deduplicateByResolvedId(entries: TrackerEntry[]): TrackerEntry[] {
  const coveredIds = new Set<string>();
  for (const e of entries) {
    if (e.status !== "done" && e.status !== "running") continue;
    const d = e.data ?? {};
    coveredIds.add(e.id);
    if (d.emplId) coveredIds.add(d.emplId);
    if (d.name) coveredIds.add(d.name);
    if (d.searchName) coveredIds.add(d.searchName);
  }
  return entries.filter((e) => {
    const isCancelled = e.status === "failed" && e.step === "cancelled";
    if (!isCancelled) return true;
    if (coveredIds.has(e.id)) return false;
    const carriedEmplId = e.data?.emplId;
    if (carriedEmplId && coveredIds.has(carriedEmplId)) return false;
    return true;
  });
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

  // First pass: count how many ordinal entries share each base name.
  // Ordinals are only meaningful when more than one entry shares the same base.
  const totals = new Map<string, number>();
  for (const e of sorted) {
    const { base, ordinal } = displayFor(e);
    if (ordinal) totals.set(base, (totals.get(base) ?? 0) + 1);
  }

  // Second pass: build the result map.
  const counters = new Map<string, number>();
  const result = new Map<string, string>();
  for (const e of sorted) {
    const { base, ordinal } = displayFor(e);
    if (!ordinal) {
      result.set(e.id, base);
      continue;
    }
    // Only one entry with this base — omit from map so resolveEntryName falls
    // through to data fields / entry.id, avoiding a pointless "Active Check 1".
    if ((totals.get(base) ?? 0) <= 1) continue;
    const next = (counters.get(base) ?? 0) + 1;
    counters.set(base, next);
    result.set(e.id, `${base} ${next}`);
  }
  return result;
}
