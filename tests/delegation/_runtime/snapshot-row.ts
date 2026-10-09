import { existsSync, readFileSync } from "node:fs";

import { dateLocal, rowFilePath, type TrackerEntry } from "../../../src/tracker/jsonl.js";
import { resolveRowArchetype } from "../../../src/domain/row-archetype.js";
import {
  buildTrackerQueueSurfaces,
  type TrackerQueueGroupSurface,
} from "../../../src/tracker/queue-surfaces.js";
import {
  dedupeLatestByIdWithCarriedEmplId,
  groupMergedTrackerEntries,
} from "../../../src/tracker/queue-row-count.js";
import {
  buildWorkflowRunProjection,
  buildProjectionFromQueueSurface,
} from "../../../src/domain/workflow-runtime/projection.js";
import {
  resolveQueueRowStatus,
  type QueueRowStatusTag,
  type StatusExtensionEntry,
} from "../../../src/domain/queue-row-status.js";
// Side-effect import: registers each workflow's status extensions
// (person-lookup notFound / A·IA, OCR needsReview) into the queue-row-status
// registry — exactly as the dashboard does via this same index. `defineWorkflow`
// also registers them server-side when a workflow module is imported, so this is
// belt-and-suspenders, but it pins the harness to the SAME registration path the
// React queue panel uses regardless of which workflow modules a test loads.
import "../../../src/domain/queue-row-status-index.js";
import {
  resolveEntryName,
  resolveEntryId,
  buildDisplayNameMap,
} from "../../../src/dashboard/components/shared/entry-display.js";
import type { TrackerEntry as DashboardTrackerEntry } from "../../../src/dashboard/components/shared/types.js";

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
  /**
   * Supplemental status chip text/title rendered ALONGSIDE the badge (NOT a
   * replacement) — today only person-lookup's A / IA / "Active (non-HDH dept)"
   * tag. Omitted entirely when the row has no secondary tag, so flat single
   * rows (oath-signature etc.) keep their pre-existing snapshot shape.
   */
  secondaryTag?: { text: string; title: string };
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

/**
 * Structured "what the dashboard would render for a GROUP CARD" snapshot. A
 * batch / preview surface renders as one anchor card (count badge, member-name
 * preview, group footer) over zero-or-more member rows. The anchor's footer
 * subtitle is resolved with `preferTraceIdSubtitle: true` (see
 * `buildProjectionFromQueueSurface`), so for a person batch/preview the subtitle
 * is the TRACE ID — never a repeated EID. `snapshotRow` routes flat rows through
 * the per-row projection and never exercises that rule; this helper does.
 */
export interface GroupAnchorSnapshot {
  kind: "operation" | "preview";
  workflowId: string;
  /** The group card's resolved title (empty string for a person operation anchor). */
  title: string;
  /**
   * The group card's footer subtitle — the anchor's `preferTraceIdSubtitle`
   * subtitle. For a person batch/preview this is the trace id.
   */
  subtitle: string | undefined;
  /** Aggregate group status derived from member/parent statuses. */
  status: string;
  rowTypeLabel: string;
  surfaceType: string;
  /** Member count rendered under the anchor. */
  memberCount: number;
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
 * Trace ids (`<code>-<HHMMSS>-<runId4>`) embed a wall-clock time + a slice of
 * the random run UUID, so they're non-deterministic. Redact them to a stable
 * placeholder so snapshots lock in the *shape* without churning every run.
 * Applies to `data.__traceId` and any title/subtitle/id that renders one.
 */
const TRACE_ID_RE = /\b[a-z0-9]{2,}-\d{6}-[a-z0-9]{4}\b/g;
function scrubTraceId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.replace(TRACE_ID_RE, "<traceId>");
}

/** Redact the non-deterministic `__traceId` field from a snapshotted data record. */
function scrubData(data: Record<string, string>): Record<string, string> {
  const out = { ...data };
  if (typeof out.__traceId === "string") out.__traceId = "<traceId>";
  return out;
}

/**
 * Collapse the raw per-step JSONL into one primary row per run, mirroring the
 * dashboard's TWO-stage pipeline so queue-surface construction sees exactly what
 * the React queue panel does:
 *
 *   1. `useEntries` → `dedupeLatestByIdWithCarriedEmplId(raw)` — one LATEST row
 *      per tracker `id` (deterministic last-write-wins by timestamp). This is
 *      the critical first stage: without it, a single run's pending/running/done
 *      rows all share the same `firstLogTs`, so the later `activityTimestamp`
 *      sort ties and may pick a stale (e.g. `running`) row as the bucket primary
 *      — a real flake source.
 *   2. `App` → `groupMergedTrackerEntries(deduped)` → `.primary` — merge same-
 *      employee rows into one card primary.
 *
 * Surfaces MUST be built from this collapsed set, not every historical step row,
 * or a run that emitted N `running` rows (e.g. an OCR prep walking its phases)
 * would spawn N phantom group surfaces.
 */
function collapseToLatestPrimaries(entries: TrackerEntry[]): TrackerEntry[] {
  const latestById = dedupeLatestByIdWithCarriedEmplId(entries);
  return groupMergedTrackerEntries(latestById).map((group) => group.primary);
}

function latestEntryForRunId(entries: TrackerEntry[], runId: string): TrackerEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.runId === runId || entry.id === runId) return entry;
  }
  return undefined;
}

/**
 * Human-facing status labels keyed exactly as the dashboard's `STATUS_CONFIG`
 * map (`EntryItem.tsx`). Kept in lockstep with that component — the displayed
 * badge text is `cfg.label`, where `cfg` is `STATUS_CONFIG[derivedStatus]` (when
 * the workflow promotes one) or `STATUS_CONFIG[status]`. EntryItem is a `.tsx`
 * React module that can't be imported into a node test, so the label strings are
 * mirrored here; the *rule* that picks which key applies is the real
 * `resolveQueueRowStatus` + the cancelled override below.
 */
const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Queued",
  skipped: "Skipped",
  needsReview: "awaiting review",
  notFound: "Not found",
};

/**
 * Resolve a row's queue-status extension exactly as `EntryItem` does:
 *   - `derivedStatus` is resolved with `{ isDone: false }` (matches EntryItem,
 *     which computes derivedStatus first, before `isDone`).
 *   - `isDone` then mirrors EntryItem: terminal `done`, EXCLUDING the delegated
 *     OCR needs-review override.
 *   - `secondaryTag` is resolved with that `isDone` (the A/IA tag keys off it).
 */
function resolveStatusForSnapshot(entry: TrackerEntry): {
  derivedStatus: string | null;
  secondaryTag: QueueRowStatusTag | null;
} {
  const statusEntry = entry as unknown as StatusExtensionEntry;
  const derivedStatus = resolveQueueRowStatus(statusEntry, { isDone: false }).derivedStatus;
  const isDone = entry.status === "done" && derivedStatus !== "needsReview";
  const secondaryTag = resolveQueueRowStatus(statusEntry, { isDone }).secondaryTag;
  return { derivedStatus, secondaryTag };
}

/**
 * Mirror `EntryItem.resolveStatusConfig`'s label precedence — cancelled
 * override (failed + step "cancelled") → workflow-derived status (notFound /
 * needsReview, via the real `resolveQueueRowStatus`) → base tracker status.
 * Returns the exact badge label the dashboard would render, so the snapshot
 * locks the production contract instead of a reimplementation that can't see
 * `statusExtensions`.
 */
function statusLabelFor(entry: TrackerEntry, derivedStatus: string | null): string {
  if (entry.status === "failed" && entry.step === "cancelled") return STATUS_LABELS.cancelled!;
  if (derivedStatus && STATUS_LABELS[derivedStatus]) return STATUS_LABELS[derivedStatus]!;
  return STATUS_LABELS[entry.status] ?? entry.status;
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

  // Status label + secondary tag go through the REAL resolveQueueRowStatus,
  // identical to EntryItem, so statusExtensions (notFound / needsReview / A·IA)
  // appear in snapshots instead of being silently dropped by a reimplementation.
  const { derivedStatus, secondaryTag } = resolveStatusForSnapshot(entry);

  const primaries = collapseToLatestPrimaries(entries);
  const surfaces = buildTrackerQueueSurfaces({
    entries: primaries,
    delegationSourceEntries: primaries,
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
    statusLabel: statusLabelFor(entry, derivedStatus),
    ...(secondaryTag ? { secondaryTag: { text: secondaryTag.text, title: secondaryTag.title } } : {}),
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

export interface SnapshotGroupAnchorOpts {
  trackerDir: string;
  workflow: string;
  /**
   * The parent run id of the group surface to snapshot. For a delegated batch
   * (oath-signature / person-lookup fan-out) this is the parent's run id; for an
   * OCR preview it's the preview anchor's own run id.
   */
  parentRunId: string;
  workflowLabel?: string;
}

function findGroupSurface(
  surfaces: ReturnType<typeof buildTrackerQueueSurfaces>,
  parentRunId: string,
): TrackerQueueGroupSurface | undefined {
  return surfaces.groupRows.find((group) => {
    if (group.parentRunId === parentRunId) return true;
    if (group.kind === "preview" && (group.parent.runId ?? group.parent.id) === parentRunId) {
      return true;
    }
    return group.members.some((m) => (m.runId ?? m.id) === parentRunId);
  });
}

/**
 * Snapshot the GROUP-CARD projection for a batch / preview surface — the path
 * `snapshotRow` (per-row) never takes. Routes through the same
 * `buildProjectionFromQueueSurface` the dashboard uses for group cards, which
 * resolves the anchor footer subtitle with `preferTraceIdSubtitle: true`. That
 * makes the "person batch/preview anchor subtitle = trace id" rule visible in
 * the snapshot — the harness fidelity gap this helper closes.
 */
export function snapshotGroupAnchor(opts: SnapshotGroupAnchorOpts): GroupAnchorSnapshot {
  const entries = readTrackerEntries(opts.trackerDir, opts.workflow);
  const primaries = collapseToLatestPrimaries(entries);
  const surfaces = buildTrackerQueueSurfaces({
    entries: primaries,
    delegationSourceEntries: primaries,
  });
  const surface = findGroupSurface(surfaces, opts.parentRunId);
  if (!surface) {
    return {
      kind: "operation",
      workflowId: opts.workflow,
      title: "",
      subtitle: undefined,
      status: "missing",
      rowTypeLabel: "missing",
      surfaceType: "missing",
      memberCount: 0,
    };
  }
  const projection = buildProjectionFromQueueSurface(surface, {});
  return {
    kind: surface.kind,
    workflowId: projection.workflowId,
    title: scrubTraceId(projection.title)!,
    subtitle: scrubTraceId(projection.subtitle),
    status: projection.status,
    rowTypeLabel: projection.rowTypeLabel,
    surfaceType: projection.surfaceType,
    memberCount: surface.members.length,
  };
}

/** Read the raw tracker entries for a runId — useful for asserting on the full sequence. */
export function readRowTimeline(opts: SnapshotRowOpts): TrackerEntry[] {
  const entries = readTrackerEntries(opts.trackerDir, opts.workflow);
  return entries.filter((e) => e.runId === opts.runId || e.id === opts.runId);
}
