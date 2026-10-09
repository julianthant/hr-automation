import { resolveQueueRowKind } from "./queue-row-kind.js";
import { readQueueTitle } from "./queue-title.js";
import { formatTraceIdRunLabel } from "./queue-trace-id.js";
import { resolveNaming } from "./workflow-presentation/resolve.js";
import type { NamingConfig } from "./workflow-presentation/types.js";

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
  runOrdinal?: number;
}

export interface QueueRowPresentationOptions {
  /**
   * When the EID/name is already shown elsewhere on the card (the title-line
   * right of a batch-member preview, or a group anchor whose members carry the
   * person identity), the footer subtitle should NOT repeat the EID — it falls
   * through to the trace id instead. Set this for **batch / preview group
   * anchors and batch-member rows**; leave it off for a **flat single** row,
   * whose footer is the only place the EID appears.
   *
   * Only affects the `person` kind. `file` / `catalog` already yield the trace
   * id, so the flag is a no-op there.
   */
  preferTraceIdSubtitle?: boolean;
  /**
   * Effective naming config for this row's workflow. When present, title +
   * subtitle are resolved through the scheme library instead of the built-in
   * kind dispatch. Absent → legacy kind-based behavior (back-compat).
   */
  naming?: NamingConfig;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * The employee's EID, under whichever field the workflow stamps it. Defense in
 * depth against prose leaking into the identity field (e.g. a stale
 * `emplId: "Not found"` / `"Error"`): an EID is numeric, so anything containing
 * a non-digit is rejected and the caller falls through to the trace id. The
 * fix-at-source lives in the workflows that stamp these fields; this guard
 * keeps a regression from reaching the subtitle.
 */
function resolveEid(data: Record<string, string>): string {
  // `ucpathId` is the canonical EID field for the onbase workflow (its schema,
  // getId, and deriveItemId all key on it, never emplId) — without it onbase
  // operation-member subtitles fall through to the trace id (ISS-003, e2e
  // 2026-06-24). The numeric guard below still rejects any non-EID value.
  const candidate = firstNonBlank(data.emplId, data.eid, data.employeeId, data.ucpathId);
  return /^\d+$/.test(candidate) ? candidate : "";
}

function parseEmployeeBlobName(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    if (typeof parsed?.name === "string" && parsed.name.trim()) return parsed.name.trim();
  } catch {
    // Not JSON — rows stamped via initialData carry flat employeeName instead.
  }
  return "";
}

/**
 * The person's display name — resolved name fields first, falling back to the
 * operator subject when it names a person/EID/email. Returns "" before any
 * name resolves (caller supplies the pending typed-input fallback).
 */
export function resolvePersonNameFromData(data: Record<string, string>): string {
  const direct = firstNonBlank(data.name, data.employeeName, data.resolvedName, data.searchName);
  if (direct) return direct;
  const nested = parseEmployeeBlobName(data.employee);
  if (nested) return nested;
  const subjectKind = data.__subjectKind;
  if (subjectKind === "person" || subjectKind === "eid" || subjectKind === "email") {
    return firstNonBlank(data.__name, data.__subject);
  }
  return "";
}

function resolvePersonName(data: Record<string, string>): string {
  return resolvePersonNameFromData(data);
}

function displayTraceId(data: Record<string, string>, runOrdinal?: number): string | undefined {
  const raw = firstNonBlank(data.__traceId);
  if (!raw) return undefined;
  return formatTraceIdRunLabel(raw, runOrdinal) || undefined;
}

export function resolveQueueRowPresentation(
  entry: PresentationEntry,
  options: QueueRowPresentationOptions = {},
): QueueRowPresentation | undefined {
  const kind = resolveQueueRowKind(entry);
  if (!kind) return undefined;
  const data = entry.data ?? {};

  if (options.naming) {
    const vars: Record<string, string> = {
      ...data,
      traceId: data.__traceId ?? "",
      ...(entry.runOrdinal !== undefined ? { runOrdinal: String(entry.runOrdinal) } : {}),
    };
    const { title, subtitle } = resolveNaming(vars, options.naming, {
      preferTraceIdSubtitle: options.preferTraceIdSubtitle,
    });
    return { title: title || firstNonBlank(data.searchName, data.__subject, data.__name) || entry.id, subtitle };
  }

  const traceId = displayTraceId(data, entry.runOrdinal);

  if (kind === "person") {
    const name = resolvePersonName(data);
    // Flat single → EID in the footer (the only place it shows). Batch/preview
    // anchors + batch-member rows already show the EID on the title line, so
    // the footer subtitle falls through to the trace id instead of repeating it.
    const subtitle = options.preferTraceIdSubtitle
      ? traceId || resolveEid(data) || undefined
      : resolveEid(data) || traceId;
    return {
      title: name || firstNonBlank(data.searchName, data.__subject, data.__name) || entry.id,
      subtitle,
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
