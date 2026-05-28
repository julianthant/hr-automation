import type { TrackerEntry } from "./types";
import type { MergedEntryGroup } from "../../../tracker/queue-row-count.js";
import { readQueueTitle } from "../../../domain/queue-title.js";
import { hasDelegationRole, resolveRowArchetype } from "../../../domain/row-archetype.js";
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

/** OCR prep rows — short queue labels by form instead of workflow "OCR". */
function ocrQueueDisplayBase(entry: TrackerEntry): string | null {
  if (entry.workflow !== "ocr") return null;
  const ft = (entry.data?.formType ?? "").trim();
  if (ft === "oath") return "OATH";
  if (ft === "emergency-contact") return "EMPL";
  return null;
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
 * shows "OATH 1", "EMPL 2", "Onboarding Roster 2", etc.
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
  if ((d.mode === "prepare" || resolveRowArchetype(entry) === "batch") && d.pdfOriginalName) {
    return d.pdfOriginalName;
  }
  if (entry.parentRunId) {
    const personName = resolveEmployeeLabel(d);
    if (personName) return personName;
  }
  const queueTitle = readQueueTitle(d);
  if (queueTitle) return queueTitle;
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
  // Dispatch rows use the group context label as the secondary footer ID
  // rather than the technical request item ID.
  if (hasDelegationRole(entry, "dispatch")) {
    if (d.__queueSubtitle) return d.__queueSubtitle;
    return d.__queueRootTitle || d.parentSubject || d.__id || entry.id;
  }
  if (d.mode === "prepare" && d.pdfOriginalName) {
    return readQueueTitle(d) || d.parentSubject || d.__name || d.__id || entry.id;
  }
  return d.__id || d.__name || entry.id;
}

export function getRunNumber(entry: TrackerEntry): number {
  if (typeof entry.runOrdinal === "number" && entry.runOrdinal > 0) {
    return entry.runOrdinal;
  }
  const parsed = Number.parseInt(entry.runId?.split("#")[1] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function formatEntryTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return ts.slice(11, 16);
  }
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
 *   - OCR rows use {@link ocrQueueDisplayBase}: "OATH 1", "EMPL 2", …
 *     (fallback: workflow label from registry if formType is missing).
 *   - SharePoint rows carry `__name = "Onboarding Roster"` (or whatever the
 *     spec label is), so they render as "Onboarding Roster 1", ...
 *
 * Pass the result as the second arg to `resolveEntryName`.
 */
export function buildDisplayNameMap(
  entries: TrackerEntry[],
  workflowLabel: string,
): Map<string, string> {
  const displayFor = (e: TrackerEntry): { base: string; ordinal: boolean; explicitWorkflowName: boolean } => {
    const d = e.data ?? {};
    if ((d.mode === "prepare" || resolveRowArchetype(e) === "batch") && d.pdfOriginalName) {
      return { base: d.pdfOriginalName, ordinal: false, explicitWorkflowName: false };
    }
    const personName = resolveEmployeeLabel(d);
    if (e.parentRunId && personName) {
      return { base: personName, ordinal: false, explicitWorkflowName: false };
    }
    const queueTitle = readQueueTitle(d);
    if (queueTitle) {
      return {
        base: queueTitle,
        ordinal: false,
        explicitWorkflowName: d.__queueTitleKind === "batch" || d.__queueTitleKind === "delegation",
      };
    }
    if (personName) return { base: personName, ordinal: false, explicitWorkflowName: false };
    const parentSubject = firstNonBlank(d.parentSubject);
    if (parentSubject) return { base: parentSubject, ordinal: false, explicitWorkflowName: true };
    const ocrBase = ocrQueueDisplayBase(e);
    if (ocrBase) return { base: ocrBase, ordinal: true, explicitWorkflowName: true };
    // Batch rows already have a unique batch id in __name (e.g. "Oath · 7596").
    // No ordinal suffix needed. OCR batch rows are handled above by ocrQueueDisplayBase.
    if (resolveRowArchetype(e) === "batch") {
      const workflowName = firstNonBlank(d.__name);
      return { base: workflowName || workflowLabel, ordinal: false, explicitWorkflowName: Boolean(workflowName) };
    }
    const workflowName = firstNonBlank(d.__name);
    return { base: workflowName || workflowLabel, ordinal: true, explicitWorkflowName: Boolean(workflowName) };
  };
  const sortKey = (e: TrackerEntry): string => e.firstLogTs || e.timestamp || "";
  const sorted = [...entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  // First pass: count how many ordinal entries share each base name.
  // Ordinals are only meaningful when more than one entry shares the same base.
  const totals = new Map<string, number>();
  for (const e of sorted) {
    if (e.parentRunId) continue;
    const { base, ordinal } = displayFor(e);
    if (ordinal) totals.set(base, (totals.get(base) ?? 0) + 1);
  }

  // Second pass: build own labels for non-delegated rows.
  const counters = new Map<string, number>();
  const result = new Map<string, string>();
  for (const e of sorted) {
    if (e.parentRunId) continue;
    const { base, ordinal, explicitWorkflowName } = displayFor(e);
    if (!ordinal) {
      result.set(e.id, base);
      continue;
    }
    // Only one entry with this base — omit from map so resolveEntryName falls
    // through to data fields / entry.id, avoiding a pointless workflow ordinal.
    // Explicit workflow-level names (incl. OATH/EMPL) still get an ordinal so the
    // parent row and all delegated children share the same numbered label as the OCR run.
    if ((totals.get(base) ?? 0) <= 1 && !explicitWorkflowName) continue;
    const next = (counters.get(base) ?? 0) + 1;
    counters.set(base, next);
    result.set(e.id, `${base} ${next}`);
  }

  // Final pass: delegated rows use the root parent's display label. This is
  // intentionally transitive: a parent workflow can delegate to OCR, and OCR
  // can delegate onward to Person Lookup / downstream daemon rows.
  //
  // Single-pass walk with path compression: build runId → parentRunId, then
  // for each delegated entry walk up to a labeled root and cache the result
  // back onto every visited runId. Bounded by parentRunId chain depth (≤3 in
  // practice), O(N) overall — replaces a former O(N × depth) fixed-point loop
  // that fired on every SSE tick.
  const labelByRunId = new Map<string, string>();
  const parentByRunId = new Map<string, string>();
  for (const e of sorted) {
    if (!e.runId) continue;
    if (e.parentRunId) {
      parentByRunId.set(e.runId, e.parentRunId);
    } else {
      labelByRunId.set(e.runId, result.get(e.id) ?? resolveEntryName(e, result));
    }
  }
  const MAX_CHAIN_DEPTH = 16;
  const resolveRootLabel = (startRunId: string): string | undefined => {
    const visited: string[] = [];
    let cursor: string | undefined = startRunId;
    let label: string | undefined;
    while (cursor && visited.length < MAX_CHAIN_DEPTH) {
      const cached = labelByRunId.get(cursor);
      if (cached) { label = cached; break; }
      visited.push(cursor);
      cursor = parentByRunId.get(cursor);
    }
    if (label) {
      for (const runId of visited) labelByRunId.set(runId, label);
    }
    return label;
  };
  for (const e of sorted) {
    if (!e.parentRunId) continue;
    const d = e.data as Record<string, string> | undefined;
    if (d?.mode === "prepare" && d.pdfOriginalName) {
      result.set(e.id, d.pdfOriginalName);
      continue;
    }
    const ownPersonName = d ? resolveEmployeeLabel(d) : "";
    if (ownPersonName) {
      result.set(e.id, ownPersonName);
      continue;
    }
    const parentLabel = resolveRootLabel(e.parentRunId);
    if (!parentLabel) continue;
    // Dispatch rows are named notification rows; keep their own __name rather
    // than inheriting the parent batch label.
    if (hasDelegationRole(e, "dispatch")) {
      const ownName = firstNonBlank(d?.__name);
      if (ownName) {
        result.set(e.id, ownName);
        continue;
      }
    }
    result.set(e.id, parentLabel);
  }
  return result;
}

export function buildDisplayNameEntries({
  visibleEntries,
  sourceEntries,
}: {
  visibleEntries: readonly TrackerEntry[];
  sourceEntries: readonly TrackerEntry[];
}): TrackerEntry[] {
  const delegatedParentRunIds = new Set<string>();
  for (const entry of sourceEntries) {
    if (entry.parentRunId) delegatedParentRunIds.add(entry.parentRunId);
  }

  const byKey = new Map<string, TrackerEntry>();
  const add = (entry: TrackerEntry) => {
    byKey.set(`${entry.workflow}\0${entry.id}\0${entry.runId ?? ""}`, entry);
  };

  for (const entry of visibleEntries) add(entry);
  for (const entry of sourceEntries) {
    if (entry.parentRunId) {
      add(entry);
      continue;
    }
    if (entry.runId && delegatedParentRunIds.has(entry.runId)) {
      add(entry);
    }
  }

  return [...byKey.values()];
}

/** Expand visible merged primaries to their hidden siblings for bulk queue controls. */
export function collectEntriesForMergedScope(
  mergeGroups: MergedEntryGroup[],
  primariesInScope: TrackerEntry[],
): TrackerEntry[] {
  const scope = new Set(primariesInScope.map((e) => e.id));
  const out: TrackerEntry[] = [];
  const seen = new Set<string>();
  for (const g of mergeGroups) {
    if (!scope.has(g.primary.id)) continue;
    for (const entry of [g.primary, ...g.siblings]) {
      const key = `${entry.workflow}#${entry.id}#${entry.runId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Merge-group peers for {@link LogPanel} run pooling — everyone in the same
 * `groupMergedEntries` bucket except the row currently selected.
 *
 * When the operator picks the primary, this matches `group.siblings`. When they
 * pick a sibling (visible only in delegation batch drill-in), returns the
 * primary plus the other siblings so pooled history stays complete.
 */
export function mergedGroupPeersForLogPanel(
  selectedEntryId: string,
  mergeGroups: MergedEntryGroup[],
): TrackerEntry[] {
  for (const g of mergeGroups) {
    const members = [g.primary, ...g.siblings];
    if (!members.some((m) => m.id === selectedEntryId)) continue;
    return members.filter((m) => m.id !== selectedEntryId);
  }
  return [];
}
