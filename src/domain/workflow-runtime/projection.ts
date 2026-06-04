import { readQueueTitle } from "../queue-title.js";
import { resolveQueueRowPresentation } from "../queue-row-presentation.js";
import { resolveQueueRowKind } from "../queue-row-kind.js";
import {
  archetypeRowTypeLabel,
  hasDelegationRole,
  resolveRowArchetype,
} from "../row-archetype.js";
import type { TrackerEntry } from "../../tracker/jsonl.js";
import {
  buildTrackerQueueSurfaces,
  classifyTrackerRow,
} from "../../tracker/queue-surfaces.js";
import type { TrackerQueueGroupSurface } from "../../tracker/queue-surfaces.js";
import {
  getWorkflowRuntimePolicy,
  type WorkflowRuntimePolicyLookup,
} from "./registry.js";
import type {
  WorkflowActionDescriptor,
  WorkflowActionKind,
  WorkflowActionPolicy,
  WorkflowActionTargetDescriptor,
  WorkflowRunProjection,
  WorkflowRuntimePolicy,
  WorkflowSurfaceType,
} from "./types.js";

export interface WorkflowProjectionContext {
  workflowLabels?: ReadonlyMap<string, string> | Record<string, string>;
  policy?: WorkflowRuntimePolicy;
  runtimePolicies?: WorkflowRuntimePolicyLookup;
  resolveEntryTitle?: (entry: TrackerEntry) => string | undefined;
  resolveEntrySubtitle?: (entry: TrackerEntry) => string | undefined;
  resolveEntryStatus?: (entry: TrackerEntry) => string | undefined;
  resolveGroupTitle?: (surface: TrackerQueueGroupSurface) => string | undefined;
}

interface ProjectionOverrides {
  surfaceType?: WorkflowSurfaceType;
  title?: string;
  subtitle?: string;
  rowTypeLabel?: string;
  actions?: WorkflowActionDescriptor[];
  batchMembers?: WorkflowRunProjection[];
  /**
   * Resolve the person-kind subtitle to the trace id instead of the EID — used
   * for batch/preview group anchors (the member-name preview already shows the
   * EID, so the footer should not repeat it). No effect on flat single rows.
   */
  preferTraceIdSubtitle?: boolean;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function workflowLabel(
  workflowId: string,
  labels: WorkflowProjectionContext["workflowLabels"],
): string {
  if (!labels) return workflowId;
  if (typeof (labels as ReadonlyMap<string, string>).get === "function") {
    return (labels as ReadonlyMap<string, string>).get(workflowId) ?? workflowId;
  }
  return (labels as Record<string, string>)[workflowId] ?? workflowId;
}

function runIdFor(entry: Pick<TrackerEntry, "id" | "runId">): string {
  return entry.runId ?? entry.id;
}

function actionTargets(entries: readonly TrackerEntry[]): WorkflowActionTargetDescriptor[] {
  return entries.map((entry) => ({
    workflowId: entry.workflow,
    id: entry.id,
    runId: runIdFor(entry),
    status: entry.status,
  }));
}

function withTargets(
  actions: readonly WorkflowActionPolicy[],
  targets: readonly WorkflowActionTargetDescriptor[],
): WorkflowActionDescriptor[] {
  return actions.map((action) => ({
    ...action,
    targets: targets.map((target) => ({ ...target })),
  }));
}

/**
 * Which row-scoped actions a single row offers, by status. This is the one
 * source of truth for the unified footer's button matrix — the dashboard
 * footer renders a button per kind and self-hides on `enabled`, so the visible
 * cluster is exactly what this returns:
 *
 *   running          → cancel (×)
 *   pending (queued) → bump (▲) + cancel (×)
 *   terminal         → retry (↻) + delete (🗑)
 *
 * A queued row has no delete: cancelling it (×) moves it to a terminal state,
 * which is where delete (🗑) then becomes available. A cancelled row is
 * `status: "failed"` (with `step: "cancelled"`), so it falls into the terminal
 * branch — retry + delete, as intended.
 */
export function rowActionEnabledForStatus(
  kind: WorkflowActionKind,
  status: string | undefined,
): boolean {
  const terminal =
    status === "done" || status === "failed" || status === "skipped" || status === "cancelled";
  switch (kind) {
    case "cancel":
      return status === "running" || status === "pending";
    case "bump":
      return status === "pending";
    case "delete":
      return terminal;
    case "retry":
      return terminal;
    default:
      return false;
  }
}

/**
 * Build row-scoped action descriptors with `enabled` gated by the row's status.
 * Row actions target exactly one entry, so the gate reads `targets[0].status`.
 * Group/bulk descriptors keep `withTargets` (their footer selects targets by
 * kind/status itself).
 */
function withRowTargets(
  actions: readonly WorkflowActionPolicy[],
  targets: readonly WorkflowActionTargetDescriptor[],
): WorkflowActionDescriptor[] {
  const status = targets[0]?.status;
  return actions.map((action) => ({
    ...action,
    enabled: action.enabled && rowActionEnabledForStatus(action.kind, status),
    targets: targets.map((target) => ({ ...target })),
  }));
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

function isPrepRow(entry: TrackerEntry): boolean {
  const data = entry.data ?? {};
  const shape = classifyTrackerRow(entry).shape;
  return (shape === "batch" || shape === "preview") && (
    data.mode === "prepare" || Boolean(data.pdfOriginalName)
  );
}

function interpolateTemplate(template: string, entry: TrackerEntry): string {
  return template.replaceAll("<last4 run id>", runIdFor(entry).slice(-4));
}

function fallbackEntryTitle(entry: TrackerEntry, policy: WorkflowRuntimePolicy): string {
  const data = entry.data ?? {};
  if (
    policy.prepRow?.titleSource === "pdf-original-name" &&
    isPrepRow(entry) &&
    data.pdfOriginalName
  ) {
    return data.pdfOriginalName;
  }
  if (policy.memberRow?.titleSource === "person" && entry.parentRunId) {
    const personName = resolveEmployeeLabel(data);
    if (personName) return personName;
  }
  if (data.mode === "prepare" && data.pdfOriginalName) return data.pdfOriginalName;
  if (entry.parentRunId) {
    const personName = resolveEmployeeLabel(data);
    if (personName) return personName;
  }
  const queueTitle = readQueueTitle(data);
  if (queueTitle) return queueTitle;
  return resolveEmployeeLabel(data) || data.__name || data.__subject || entry.id;
}

function fallbackEntrySubtitle(entry: TrackerEntry, policy: WorkflowRuntimePolicy): string | undefined {
  const data = entry.data ?? {};
  if (policy.prepRow?.subtitleTemplate && isPrepRow(entry)) {
    return interpolateTemplate(policy.prepRow.subtitleTemplate, entry);
  }
  if (entry.parentRunId && policy.memberRow?.subtitle) {
    return policy.memberRow.subtitle;
  }
  if (policy.subtitleTemplate && !entry.parentRunId && !isPrepRow(entry)) {
    return interpolateTemplate(policy.subtitleTemplate, entry);
  }
  if (hasDelegationRole(entry, "dispatch")) {
    return firstNonBlank(data.__queueSubtitle, data.__queueRootTitle, data.parentSubject, data.__id, entry.id)
      || undefined;
  }
  if (data.mode === "prepare" && data.pdfOriginalName) {
    return firstNonBlank(readQueueTitle(data) ?? undefined, data.parentSubject, data.__name, data.__id, entry.id)
      || undefined;
  }
  return firstNonBlank(data.__id, data.__name, entry.id) || undefined;
}

/** Map stamped row archetype to queue surface type; batch-member renders as single. */
export function entrySurfaceType(entry: TrackerEntry): WorkflowSurfaceType {
  const archetype = resolveRowArchetype(entry);
  return archetype === "batch-member" ? "single" : archetype;
}

function rowTypeLabelFor(surfaceType: WorkflowSurfaceType): string {
  return archetypeRowTypeLabel(surfaceType);
}

function batchGroupTitle(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
  policy: WorkflowRuntimePolicy,
): string {
  const overridden = firstNonBlank(context.resolveGroupTitle?.(surface), surface.titleOverride);
  if (overridden) return overridden;

  const anchor = surface.kind === "preview"
    ? surface.parent
    : surface.kind === "batch"
      ? surface.parent
      : surface.kind === "operation"
        ? surface.parent
        : undefined;

  // Person batches carry no synthetic title — the count badge + member-name
  // preview already identify the bag of people. Session-local ordinals
  // ("Oath 1", "<label> · #1234") are retired across all batch kinds.
  const kindEntry = anchor ?? surface.members[0];
  if (kindEntry && resolveQueueRowKind(kindEntry) === "person") return "";

  if (anchor) {
    return context.resolveEntryTitle?.(anchor)
      ?? resolveQueueRowPresentation(anchor)?.title
      ?? fallbackEntryTitle(anchor, policy);
  }

  const first = surface.members[0];
  if (first) {
    return resolveQueueRowPresentation(first)?.title
      ?? workflowLabel(first.workflow, context.workflowLabels);
  }
  return "Batch";
}

export function buildWorkflowRunProjection(
  entry: TrackerEntry,
  context: WorkflowProjectionContext,
  overrides: ProjectionOverrides = {},
): WorkflowRunProjection {
  const policy = context.policy ?? getWorkflowRuntimePolicy(entry.workflow, context.runtimePolicies);
  const surfaceType = overrides.surfaceType ?? entrySurfaceType(entry);
  const runId = runIdFor(entry);
  const targets = actionTargets([entry]);
  // Kind-based title/subtitle (person/file/catalog) takes precedence over the
  // legacy fallbacks but yields to explicit overrides + context resolvers.
  const presentation = resolveQueueRowPresentation(entry, {
    preferTraceIdSubtitle: overrides.preferTraceIdSubtitle,
  });
  return {
    runId,
    workflowId: entry.workflow,
    itemId: entry.id,
    parentRunId: entry.parentRunId,
    title: overrides.title ?? context.resolveEntryTitle?.(entry) ?? presentation?.title ?? fallbackEntryTitle(entry, policy),
    subtitle: overrides.subtitle ?? context.resolveEntrySubtitle?.(entry)
      ?? (presentation ? presentation.subtitle : fallbackEntrySubtitle(entry, policy)),
    status: context.resolveEntryStatus?.(entry) ?? entry.status,
    step: entry.step,
    surfaceType,
    rowTypeLabel: overrides.rowTypeLabel ?? rowTypeLabelFor(surfaceType),
    actions: overrides.actions ?? withRowTargets(policy.rowActions, targets),
    batchMembers: overrides.batchMembers ?? [],
  };
}

/**
 * Log-panel row-type chip label for one tracker entry. Reuses queue-surface
 * classification + runtime projection instead of duplicating surface rules in
 * the dashboard.
 */
export function deriveRowTypeLabelForEntry(
  entry: TrackerEntry,
  childEntries: TrackerEntry[],
  allEntries: TrackerEntry[],
  previewAvailable: boolean,
  runtimePolicies?: WorkflowRuntimePolicyLookup,
): string {
  const runId = entry.runId ?? entry.id;
  const sourceEntries = allEntries.length > 0 ? allEntries : [entry, ...childEntries];
  const surfaces = buildTrackerQueueSurfaces({
    entries: sourceEntries,
    delegationSourceEntries: sourceEntries,
    runtimePolicies,
  });
  const surface = surfaces.groupRows.find((candidate) => {
    if (candidate.parentRunId === runId) return true;
    if (candidate.kind === "preview" && (candidate.parent.runId ?? candidate.parent.id) === runId) {
      return true;
    }
    return candidate.members.some((member) => (member.runId ?? member.id) === runId);
  });
  const label = surface
    ? buildProjectionFromQueueSurface(surface, { runtimePolicies }).rowTypeLabel
    : buildWorkflowRunProjection(entry, { runtimePolicies }).rowTypeLabel;
  if (previewAvailable && label !== "Preview" && !label.endsWith("· Preview")) {
    return `${label} · Preview`;
  }
  return label;
}

/** Aggregate a batch/operation group's status from its member rows. */
function memberAggregateStatus(members: readonly TrackerEntry[]): string {
  if (members.some((member) => member.status === "running")) return "running";
  if (members.some((member) => member.status === "pending" || member.status === "skipped")) {
    return "pending";
  }
  if (members.some((member) => member.status === "failed")) return "failed";
  return "done";
}

function operationSurfaceStatus(surface: Extract<TrackerQueueGroupSurface, { kind: "operation" }>): string {
  if (surface.members.length > 0) return memberAggregateStatus(surface.members);
  if (surface.parent.status === "failed" || surface.parent.status === "done") {
    return surface.parent.status;
  }
  if (surface.ocr?.status === "failed" || surface.ocr?.status === "discarded") {
    return "failed";
  }
  if (surface.ocr?.status === "approved" || surface.ocr?.status === "done") {
    return "done";
  }
  return surface.parent.status || "running";
}

/**
 * The entry whose title / subtitle / step / itemId anchors a group surface
 * card. Preview and operation surfaces always carry a real parent row; a batch
 * surface uses its parent when present and otherwise falls back to its first
 * member (an `alwaysBatchDelegatedMembers` one-member batch has no parent row).
 */
function surfaceAnchorEntry(surface: TrackerQueueGroupSurface): TrackerEntry | undefined {
  switch (surface.kind) {
    case "preview":
    case "operation":
      return surface.parent;
    case "batch":
      return surface.parent ?? surface.members[0];
  }
}

/** Roll up a group surface's card status from its parent row + member rows. */
function computeGroupStatus(surface: TrackerQueueGroupSurface): string {
  switch (surface.kind) {
    case "preview":
      return surface.parent.status;
    case "operation":
      return operationSurfaceStatus(surface);
    case "batch":
      return surface.parent && surface.parent.status !== "done"
        ? surface.parent.status
        : memberAggregateStatus(surface.members);
  }
}

function operationCoordinatorActions(
  policy: WorkflowRuntimePolicy,
  targets: readonly WorkflowActionTargetDescriptor[],
): WorkflowActionDescriptor[] {
  // Operation coordinators are display rows that own/cancel OCR prep before
  // fan-out. Retrying one as a normal workflow row would enqueue the target
  // workflow with a synthetic OCR-prep input, so expose only cancel/delete.
  const allowed = policy.rowActions.filter((action) =>
    action.kind === "cancel" || action.kind === "delete"
  );
  return withRowTargets(allowed, targets);
}

export function buildProjectionFromQueueSurface(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
): WorkflowRunProjection {
  const surfaceType: WorkflowSurfaceType = surface.kind;
  const members = surface.members.map((member) =>
    buildWorkflowRunProjection(member, context, { surfaceType: "single" }),
  );
  const anchor = surfaceAnchorEntry(surface);
  const fallbackWorkflow = anchor?.workflow ?? "workflow";
  const policy = context.policy ?? getWorkflowRuntimePolicy(fallbackWorkflow, context.runtimePolicies);
  const status = computeGroupStatus(surface);
  const targetEntries = surface.members.length > 0
    ? surface.members
    : surface.kind === "preview"
      ? [surface.parent]
      : surface.kind === "operation"
        ? [surface.parent]
      : surface.kind === "batch" && surface.parent
        ? [surface.parent]
        : [];
  const rowTargetEntries = surface.kind === "preview"
    ? [surface.parent]
    : surface.kind === "operation" && surface.members.length === 0
      ? [surface.parent]
      : [];
  const groupActions = withTargets(policy.groupActions, actionTargets(targetEntries));
  const actions = surface.kind === "preview"
    ? [
        ...withRowTargets(policy.rowActions, actionTargets(rowTargetEntries)),
        ...groupActions,
      ]
    : surface.kind === "operation" && surface.members.length === 0
      ? operationCoordinatorActions(policy, actionTargets(rowTargetEntries))
    : groupActions;
  // The group card's footer subtitle is the anchor's — resolved with
  // `preferTraceIdSubtitle` so a person batch/preview anchor shows the TRACE ID
  // (the member-name preview already carries the EID on its title-line right),
  // never a repeated EID or a blank slot. `anchor` falls back to `members[0]`
  // when no parent row exists (an `alwaysBatchDelegatedMembers` one-member
  // batch: oath-signature / person-lookup fan-out), so the slot is filled even
  // when `surface.parent` is undefined.
  const anchorProjection = anchor
    ? buildWorkflowRunProjection(anchor, context, {
        surfaceType,
        preferTraceIdSubtitle: true,
      })
    : undefined;
  // The group's anchor row for itemId/step purposes — batch (when a parent row
  // exists) and operation surfaces both carry a real parent row; preview is
  // handled separately below.
  const groupParent = surface.kind === "operation"
    ? surface.parent
    : surface.kind === "batch"
      ? surface.parent
      : undefined;

  return {
    runId: surface.parentRunId,
    workflowId: fallbackWorkflow,
    itemId: surface.kind === "preview" ? surface.parent.id : groupParent?.id ?? surface.parentRunId,
    title: batchGroupTitle(surface, context, policy),
    subtitle: anchorProjection?.subtitle,
    status,
    step: surface.kind === "preview" ? surface.parent.step : groupParent?.step,
    surfaceType,
    rowTypeLabel: rowTypeLabelFor(surfaceType),
    actions,
    batchMembers: members,
  };
}
