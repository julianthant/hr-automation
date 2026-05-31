import { resolveQueueRowKind } from "./queue-row-kind.js";
import { readQueueTitle } from "./queue-title.js";

/**
 * Single source of truth for a queue row's **title + subtitle**, dispatched on
 * the stamped `data.queueRowKind`. Replaces the title/subtitle fallbacks that
 * were duplicated across the server projection (`fallbackEntryTitle` /
 * `fallbackEntrySubtitle`) and the dashboard (`resolveEntryName` /
 * `resolveEntryId`).
 *
 * Title / subtitle by kind:
 *   - person  — title: resolved employee name (pending: typed name/EID).
 *               subtitle: EID, else the trace id.
 *   - file    — title: PDF filename. subtitle: trace id.
 *   - catalog — title: registry/spec label. subtitle: trace id.
 *
 * Returns `undefined` for rows with no stamped kind (legacy/unmigrated), so the
 * caller falls back to its pre-kind logic during migration.
 */
export interface QueueRowPresentation {
  title: string;
  subtitle?: string;
}

interface PresentationEntry {
  id: string;
  data?: Record<string, string> | null;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** The employee's EID, under whichever field the workflow stamps it. */
function resolveEid(data: Record<string, string>): string {
  return firstNonBlank(data.emplId, data.eid, data.employeeId);
}

/**
 * The person's display name — resolved name fields first, falling back to the
 * operator subject when it names a person/EID/email. Returns "" before any
 * name resolves (caller supplies the pending typed-input fallback).
 */
function resolvePersonName(data: Record<string, string>): string {
  const direct = firstNonBlank(data.name, data.employeeName, data.searchName);
  if (direct) return direct;
  const subjectKind = data.__subjectKind;
  if (subjectKind === "person" || subjectKind === "eid" || subjectKind === "email") {
    return firstNonBlank(data.__name, data.__subject);
  }
  return "";
}

export function resolveQueueRowPresentation(entry: PresentationEntry): QueueRowPresentation | undefined {
  const kind = resolveQueueRowKind(entry);
  if (!kind) return undefined;
  const data = entry.data ?? {};
  const traceId = firstNonBlank(data.__traceId) || undefined;

  if (kind === "person") {
    const name = resolvePersonName(data);
    return {
      title: name || firstNonBlank(data.searchName, data.__subject, data.__name) || entry.id,
      subtitle: resolveEid(data) || traceId,
    };
  }

  if (kind === "file") {
    return {
      title: firstNonBlank(data.pdfOriginalName, data.__name, readQueueTitle(data) ?? "") || entry.id,
      subtitle: traceId,
    };
  }

  // catalog
  return {
    title: firstNonBlank(readQueueTitle(data) ?? "", data.__name, data.label) || entry.id,
    subtitle: traceId,
  };
}
