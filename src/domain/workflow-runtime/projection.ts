import { readQueueTitle } from "../queue-title.js";
import {
  resolveRowArchetype,
} from "../row-archetype.js";
import type { TrackerEntry } from "../../tracker/jsonl.js";
import { buildTrackerQueueSurfaces } from "../../tracker/queue-surfaces.js";
import type { TrackerQueueGroupSurface } from "../../tracker/queue-surfaces.js";
import {
  getWorkflowRuntimePolicy,
  type WorkflowRuntimePolicyLookup,
} from "./registry.js";
import type {
  WorkflowActionDescriptor,
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
  return resolveRowArchetype(entry) === "batch-parent" && (
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
  const archetype = resolveRowArchetype(entry);
  if (archetype === "dispatch") {
    return firstNonBlank(data.__queueSubtitle, data.__queueRootTitle, data.parentSubject, data.__id, entry.id)
      || undefined;
  }
  if (data.mode === "prepare" && data.pdfOriginalName) {
    return firstNonBlank(readQueueTitle(data) ?? undefined, data.parentSubject, data.__name, data.__id, entry.id)
      || undefined;
  }
  return firstNonBlank(data.__id, data.__name, entry.id) || undefined;
}

function rowSurfaceType(entry: TrackerEntry): WorkflowSurfaceType {
  return entry.parentRunId ? "delegation-member" : "normal";
}

function rowTypeLabelFor(
  surfaceType: WorkflowSurfaceType,
  policy: WorkflowRuntimePolicy,
): string {
  const withPreview = (label: string): string => {
    const suffix = policy.preview?.rowTypeLabelSuffix;
    return policy.preview?.alwaysAvailable && suffix ? `${label} · ${suffix}` : label;
  };
  switch (surfaceType) {
    case "normal":
      return "Normal row";
    case "approval-delegation":
      return withPreview("Single delegation");
    case "batch-delegation":
      return withPreview("Batch delegation");
    case "passive-delegation":
      return "Passive delegation";
    case "delegation-member":
      return "Delegation member";
  }
}

function batchGroupTitle(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
  policy: WorkflowRuntimePolicy,
): string {
  const overridden = firstNonBlank(context.resolveGroupTitle?.(surface), surface.titleOverride);
  if (overridden) return overridden;

  if (surface.kind === "approval-delegation") {
    return context.resolveEntryTitle?.(surface.parent) ?? fallbackEntryTitle(surface.parent, policy);
  }

  const first = surface.members[0];
  const label = first ? workflowLabel(first.workflow, context.workflowLabels) : "Batch";
  const rawOrdinal = surface.members
    .map((member) => member.data?.batchDisplayOrdinal)
    .find((value) => value != null && value !== "");
  const ordinal = rawOrdinal === undefined ? Number.NaN : Number.parseInt(rawOrdinal, 10);
  if (Number.isFinite(ordinal) && ordinal > 0) return `${label} ${ordinal}`;
  return `${label} · #${surface.parentRunId.slice(-4)}`;
}

export function buildWorkflowRunProjection(
  entry: TrackerEntry,
  context: WorkflowProjectionContext,
  overrides: ProjectionOverrides = {},
): WorkflowRunProjection {
  const policy = context.policy ?? getWorkflowRuntimePolicy(entry.workflow, context.runtimePolicies);
  const surfaceType = overrides.surfaceType ?? rowSurfaceType(entry);
  const runId = runIdFor(entry);
  const targets = actionTargets([entry]);
  return {
    runId,
    workflowId: entry.workflow,
    itemId: entry.id,
    parentRunId: entry.parentRunId,
    title: overrides.title ?? context.resolveEntryTitle?.(entry) ?? fallbackEntryTitle(entry, policy),
    subtitle: overrides.subtitle ?? context.resolveEntrySubtitle?.(entry) ?? fallbackEntrySubtitle(entry, policy),
    status: context.resolveEntryStatus?.(entry) ?? entry.status,
    step: entry.step,
    surfaceType,
    rowTypeLabel: overrides.rowTypeLabel ?? rowTypeLabelFor(surfaceType, policy),
    actions: overrides.actions ?? withTargets(policy.rowActions, targets),
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
    if (candidate.kind === "approval-delegation" && (candidate.parent.runId ?? candidate.parent.id) === runId) {
      return true;
    }
    return candidate.members.some((member) => (member.runId ?? member.id) === runId);
  });
  const label = surface
    ? buildProjectionFromQueueSurface(surface, { runtimePolicies }).rowTypeLabel
    : buildWorkflowRunProjection(entry, { runtimePolicies }).rowTypeLabel;
  return previewAvailable && !label.endsWith("· Preview") ? `${label} · Preview` : label;
}

export function buildProjectionFromQueueSurface(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
): WorkflowRunProjection {
  const surfaceType: WorkflowSurfaceType =
    surface.kind === "approval-delegation"
      ? "approval-delegation"
      : surface.kind === "passive-delegation"
        ? "passive-delegation"
        : "batch-delegation";
  const members = surface.members.map((member) =>
    buildWorkflowRunProjection(member, context, { surfaceType: "delegation-member" }),
  );
  const anchor = surface.kind === "approval-delegation" ? surface.parent : surface.members[0];
  const fallbackWorkflow = anchor?.workflow ?? "workflow";
  const policy = context.policy ?? getWorkflowRuntimePolicy(fallbackWorkflow, context.runtimePolicies);
  const status = surface.kind === "approval-delegation"
    ? surface.parent.status
    : surface.members.some((member) => member.status === "running")
      ? "running"
      : surface.members.some((member) => member.status === "pending" || member.status === "skipped")
        ? "pending"
        : surface.members.some((member) => member.status === "failed")
          ? "failed"
          : "done";
  const targetEntries = surface.members.length > 0
    ? surface.members
    : surface.kind === "approval-delegation"
      ? [surface.parent]
      : [];
  const rowTargetEntries = surface.kind === "approval-delegation" ? [surface.parent] : [];
  const groupActions = withTargets(policy.groupActions, actionTargets(targetEntries));
  const actions = surface.kind === "approval-delegation"
    ? [
        ...withTargets(policy.rowActions, actionTargets(rowTargetEntries)),
        ...groupActions,
      ]
    : groupActions;
  const anchorProjection = anchor
    ? buildWorkflowRunProjection(anchor, context, { surfaceType })
    : undefined;

  return {
    runId: surface.parentRunId,
    workflowId: fallbackWorkflow,
    itemId: surface.kind === "approval-delegation" ? surface.parent.id : surface.parentRunId,
    title: batchGroupTitle(surface, context, policy),
    subtitle: surface.kind === "approval-delegation" ? anchorProjection?.subtitle : undefined,
    status,
    step: surface.kind === "approval-delegation" ? surface.parent.step : undefined,
    surfaceType,
    rowTypeLabel: rowTypeLabelFor(surfaceType, policy),
    actions,
    batchMembers: members,
  };
}
