import { readQueueTitle } from "../queue-title.js";
import {
  resolveRowArchetype,
} from "../row-archetype.js";
import type { TrackerEntry } from "../../tracker/jsonl.js";
import type { TrackerQueueGroupSurface } from "../../tracker/queue-surfaces.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "./default-policy.js";
import type {
  WorkflowActionDescriptor,
  WorkflowRunProjection,
  WorkflowRuntimePolicy,
  WorkflowSurfaceType,
} from "./types.js";

export interface WorkflowProjectionContext {
  workflowLabels?: ReadonlyMap<string, string> | Record<string, string>;
  policy?: WorkflowRuntimePolicy;
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

function targetRunIds(entries: readonly TrackerEntry[]): string[] {
  return entries.map(runIdFor);
}

function withTargets(
  actions: readonly WorkflowActionDescriptor[],
  runIds: readonly string[],
): WorkflowActionDescriptor[] {
  return actions.map((action) => ({
    ...action,
    targetRunIds: [...runIds],
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

function fallbackEntryTitle(entry: TrackerEntry): string {
  const data = entry.data ?? {};
  if (data.mode === "prepare" && data.pdfOriginalName) return data.pdfOriginalName;
  if (entry.parentRunId) {
    const personName = resolveEmployeeLabel(data);
    if (personName) return personName;
  }
  const queueTitle = readQueueTitle(data);
  if (queueTitle) return queueTitle;
  return resolveEmployeeLabel(data) || data.__name || data.__subject || entry.id;
}

function fallbackEntrySubtitle(entry: TrackerEntry): string | undefined {
  const data = entry.data ?? {};
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

function rowTypeLabelFor(surfaceType: WorkflowSurfaceType, _entry?: TrackerEntry): string {
  switch (surfaceType) {
    case "normal":
      return "Normal row";
    case "approval-delegation":
      return "Single delegation";
    case "batch-delegation":
      return "Batch delegation";
    case "passive-delegation":
      return "Passive delegation";
    case "delegation-member":
      return "Delegation member";
  }
}

function batchGroupTitle(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
): string {
  const overridden = firstNonBlank(context.resolveGroupTitle?.(surface), surface.titleOverride);
  if (overridden) return overridden;

  if (surface.kind === "approval-delegation") {
    return context.resolveEntryTitle?.(surface.parent) ?? fallbackEntryTitle(surface.parent);
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
  const policy = context.policy ?? DEFAULT_WORKFLOW_RUNTIME_POLICY;
  const surfaceType = overrides.surfaceType ?? rowSurfaceType(entry);
  const runId = runIdFor(entry);
  return {
    runId,
    workflowId: entry.workflow,
    itemId: entry.id,
    parentRunId: entry.parentRunId,
    title: overrides.title ?? context.resolveEntryTitle?.(entry) ?? fallbackEntryTitle(entry),
    subtitle: overrides.subtitle ?? context.resolveEntrySubtitle?.(entry) ?? fallbackEntrySubtitle(entry),
    status: context.resolveEntryStatus?.(entry) ?? entry.status,
    step: entry.step,
    surfaceType,
    rowTypeLabel: overrides.rowTypeLabel ?? rowTypeLabelFor(surfaceType, entry),
    actions: overrides.actions ?? withTargets(policy.rowActions, [runId]),
    batchMembers: overrides.batchMembers ?? [],
  };
}

export function buildProjectionFromQueueSurface(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
): WorkflowRunProjection {
  const policy = context.policy ?? DEFAULT_WORKFLOW_RUNTIME_POLICY;
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

  return {
    runId: surface.parentRunId,
    workflowId: fallbackWorkflow,
    itemId: surface.parentRunId,
    title: batchGroupTitle(surface, context),
    subtitle: undefined,
    status,
    step: surface.kind === "approval-delegation" ? surface.parent.step : undefined,
    surfaceType,
    rowTypeLabel: rowTypeLabelFor(surfaceType, anchor),
    actions: withTargets(policy.groupActions, targetRunIds(targetEntries)),
    batchMembers: members,
  };
}
