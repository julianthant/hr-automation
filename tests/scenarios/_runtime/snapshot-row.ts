import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { dateLocal, rowFilePath, type TrackerEntry } from "../../../src/tracker/jsonl.js";
import { resolveRowArchetype } from "../../../src/domain/row-archetype.js";
import { buildTrackerQueueSurfaces } from "../../../src/tracker/queue-surfaces.js";
import { buildWorkflowRunProjection } from "../../../src/domain/workflow-runtime/projection.js";
import {
  resolveEntryName,
  resolveEntryId,
  buildDisplayNameMap,
} from "../../../src/dashboard/components/shared/entry-display.js";
import type { TrackerEntry as DashboardTrackerEntry } from "../../../src/dashboard/components/shared/types.js";
import { isTerminalNotFoundEntry } from "../../../src/domain/tracker-terminal-display.js";

/**
 * Structured "what the dashboard would render" snapshot for a single row.
 * Combines the latest tracker entry with the same display helpers `EntryItem`
 * uses so the snapshot reflects the actual UI contract, not just raw JSONL.
 *
 * Designed for `expect(snap).toMatchInlineSnapshot()` — vitest auto-fills the
 * literal on first run; regen all snapshots with `vitest -u` when the row
 * shape legitimately changes.
 */
export interface RowSnapshot {
  workflow: string;
  itemId: string;
  runId: string;
  /** Raw tracker status (`pending` | `running` | `done` | `failed` | `skipped`). */
  status: string;
  /** Dashboard-rendered status label (`STATUS_CONFIG[*].label` in EntryItem). */
  statusLabel: string;
  step: string | undefined;
  archetype: string;
  /** Title the dashboard renders for this row (resolveEntryName with displayNames map). */
  title: string;
  /** Secondary id rendered next to the title (resolveEntryId). */
  displayId: string;
  /** Projection subtitle — used by group cards and some flat rows. */
  subtitle: string | undefined;
  surfaceType: string;
  rowTypeLabel: string;
  /** `flat`: rendered as a flat queue row. `grouped`: inside a group card. */
  surfacePlacement: "flat" | "grouped" | "missing";
  parentRunId: string | null;
  data: Record<string, string>;
  error?: string;
}

function readTrackerEntries(dir: string, workflow: string): TrackerEntry[] {
  const path = rowFilePath(workflow, dateLocal(), dir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerEntry);
}

/**
 * Trace ids (`<code>-<mmddyyHHMMSS>-<runId4>`) embed a wall-clock timestamp +
 * a slice of the random run UUID, so they're non-deterministic. Redact them to
 * a stable placeholder so snapshots lock in the *shape* without churning every
 * run. Applies to `data.__traceId` and any title/subtitle/id that renders one.
 */
const TRACE_ID_RE = /\b[a-z0-9]{2,}-\d{12}-[a-z0-9]{4}\b/g;
function scrubTraceId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.replace(TRACE_ID_RE, "<traceId>");
}

/** Redact the non-deterministic `__traceId` field from a snapshotted data record. */
function scrubData(data: Record<string, string>): Record<string, string> {
  const out = { ...data };
  if (typeof out.__traceId === "string") out.__traceId = "<traceId>";
  return out;
}

function latestEntryForRunId(entries: TrackerEntry[], runId: string): TrackerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.runId === runId || entry.id === runId) return entry;
  }
  return undefined;
}

/**
 * Mirrors the cancel/not-found classification `EntryItem.resolveStatusConfig`
 * applies before picking a status badge. Extracted here so snapshot tests can
 * lock in the human-facing label without rendering React.
 */
function statusLabelFor(entry: TrackerEntry): string {
  if (entry.status === "failed" && entry.step === "cancelled") return "Cancelled";
  if (entry.status === "done" && isTerminalNotFoundEntry(entry)) return "Not found";
  switch (entry.status) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "pending":
      return "Queued";
    case "skipped":
      return "Skipped";
    default:
      return entry.status;
  }
}

export interface SnapshotRowOpts {
  trackerDir: string;
  workflow: string;
  runId: string;
  /**
   * Human-readable workflow label passed to `buildDisplayNameMap`. Defaults
   * to the workflow id when omitted — pass `workflow.config.label` to match
   * production exactly (e.g. "Oath Signature" vs "oath-signature").
   */
  workflowLabel?: string;
}

export function snapshotRow(opts: SnapshotRowOpts): RowSnapshot {
  const entries = readTrackerEntries(opts.trackerDir, opts.workflow);
  const entry = latestEntryForRunId(entries, opts.runId);
  if (!entry) {
    return {
      workflow: opts.workflow,
      itemId: "",
      runId: opts.runId,
      status: "missing",
      statusLabel: "Missing",
      step: undefined,
      archetype: "missing",
      title: "",
      displayId: "",
      subtitle: undefined,
      surfaceType: "missing",
      rowTypeLabel: "missing",
      surfacePlacement: "missing",
      parentRunId: null,
      data: {},
    };
  }

  // Use the SAME display-name pipeline the dashboard uses — buildDisplayNameMap
  // builds the per-entry label map (person rows → name, batch rows → numbered
  // workflow label, etc.) and resolveEntryName threads it through. This is
  // the production contract; without it, snapshots would diverge from what
  // the user actually sees.
  const dashEntries = entries as unknown as DashboardTrackerEntry[];
  const displayNames = buildDisplayNameMap(dashEntries, opts.workflowLabel ?? entry.workflow);
  const title = resolveEntryName(entry as unknown as DashboardTrackerEntry, displayNames);
  const displayId = resolveEntryId(entry as unknown as DashboardTrackerEntry);

  // Projection layer is still used for subtitle + surfaceType + rowTypeLabel —
  // the queue group cards render those, and any change to derivation surfaces
  // in the snapshot diff.
  const projection = buildWorkflowRunProjection(entry, {});

  const surfaces = buildTrackerQueueSurfaces({
    entries,
    delegationSourceEntries: entries,
  });
  const runIdKey = entry.runId ?? entry.id;
  const inFlat = surfaces.flatEntries.some((e) => (e.runId ?? e.id) === runIdKey);
  const inGroup = surfaces.groupRows.some((group) =>
    group.parentRunId === runIdKey
      || group.members.some((m) => (m.runId ?? m.id) === runIdKey)
      || (group.kind === "preview"
        && (group.parent.runId ?? group.parent.id) === runIdKey),
  );
  const surfacePlacement: RowSnapshot["surfacePlacement"] = inFlat
    ? "flat"
    : inGroup
      ? "grouped"
      : "missing";

  return {
    workflow: entry.workflow,
    itemId: entry.id,
    runId: runIdKey,
    status: entry.status,
    statusLabel: statusLabelFor(entry),
    step: entry.step,
    archetype: resolveRowArchetype(entry),
    title: scrubTraceId(title)!,
    displayId: scrubTraceId(displayId)!,
    subtitle: scrubTraceId(projection.subtitle),
    surfaceType: projection.surfaceType,
    rowTypeLabel: projection.rowTypeLabel,
    surfacePlacement,
    parentRunId: entry.parentRunId ?? null,
    data: scrubData(entry.data ?? {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

/** Read the raw tracker entries for a runId — useful for asserting on the full sequence. */
export function readRowTimeline(opts: SnapshotRowOpts): TrackerEntry[] {
  const entries = readTrackerEntries(opts.trackerDir, opts.workflow);
  return entries.filter((e) => e.runId === opts.runId || e.id === opts.runId);
}
