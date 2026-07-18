import { readQueueTitle } from "../queue-title.js";
import { resolveQueueRowPresentation } from "../queue-row-presentation.js";
import type { QueueRowPresentation } from "../queue-row-presentation.js";
import { resolveQueueRowKind } from "../queue-row-kind.js";
import type { WorkflowPresentationConfig } from "../workflow-presentation/types.js";
import {
  archetypeRowTypeLabel,
  hasDelegationRole,
  resolveRowArchetype,
} from "../row-archetype.js";
import { runIdFragment, tracePrefix } from "../queue-trace-id.js";
import type { TrackerEntry } from "../../tracker/jsonl.js";
import { rollupOperationStatus } from "../operation-status.js";
import { classifyTrackerRow } from "../../tracker/queue-surfaces.js";
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
  /**
   * Effective per-workflow presentation config — the merged code-default +
   * operator override (`presentation.delegation.*` naming for member/prep rows).
   * Supplied by Phase 4.5; until then nothing wires it, so every member/prep
   * delegation-naming branch below is inert and the projection collapses to its
   * pre-this-feature title/subtitle expression. Mirrors the other
   * `resolveEntry*` resolvers (keyed by workflow id, returns `undefined` when no
   * config applies).
   */
  resolvePresentation?: (workflowId: string) => WorkflowPresentationConfig | undefined;
}

interface ProjectionOverrides {
  surfaceType?: WorkflowSurfaceType;
  title?: string;
  subtitle?: string;
  rowTypeLabel?: string;
  actions?: WorkflowActionDescriptor[];
  operationMembers?: WorkflowRunProjection[];
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

/**
 * A **display-only** row: a tracker row that reports the outcome of work done
 * elsewhere and has NO daemon task of its own (`data.displayOnly === "true"`).
 * Today: the per-person I-9 check results fanned back into the separations
 * queue — the person-match children that produced them ran under the OCR run,
 * not under these rows.
 *
 * Such a row must NOT offer retry / cancel / bump. There is nothing to cancel,
 * and a retry is actively DANGEROUS: with no SQLite task to re-queue,
 * `reEnqueueEntry` falls back to reconstructing an input from the row's tracker
 * data and enqueuing it — which on separations would start a REAL termination
 * run for that person. Delete stays available (dropping a stale result row is
 * harmless and is the operator's only way to clear one).
 */
export function isDisplayOnlyRow(entry: TrackerEntry): boolean {
  return entry.data?.displayOnly === "true";
}

function isPrepRow(entry: TrackerEntry): boolean {
  const data = entry.data ?? {};
  const shape = classifyTrackerRow(entry).shape;
  return (shape === "preview" || (shape === "operation" && data.mode === "prepare")) && (
    data.mode === "prepare" || Boolean(data.pdfOriginalName)
  );
}

/**
 * Title/subtitle for a delegated **member** row from the workflow's effective
 * `presentation.delegation` naming. Active ONLY when BOTH `memberTitle` and
 * `memberSubtitle` are configured — an explicit, complete operator naming choice
 * that wins over the default kind dispatch (member rows always prefer the trace
 * id over a repeated EID, so `preferTraceIdSubtitle: true`). Returns `undefined`
 * when the config is absent or partial, so the caller's existing precedence /
 * `memberRow.titleSource` fallback runs unchanged. Inert for every workflow
 * until Phase 4.5 supplies `presentation` via `context.resolvePresentation`.
 */
export function resolveMemberPresentation(
  entry: { id: string; data?: Record<string, string> | null },
  presentation?: WorkflowPresentationConfig,
): QueueRowPresentation | undefined {
  const delegation = presentation?.delegation;
  if (delegation?.memberTitle && delegation?.memberSubtitle) {
    return resolveQueueRowPresentation(entry, {
      preferTraceIdSubtitle: true,
      naming: { title: delegation.memberTitle, subtitle: delegation.memberSubtitle },
    });
  }
  return undefined;
}

/**
 * Title for an OCR **prep** row from the workflow's effective
 * `presentation.delegation.prepTitle`. Prep rows have no member-subtitle scheme,
 * so this resolves the TITLE only (subtitle keeps today's behavior). Returns
 * `undefined` when `prepTitle` is absent, so the caller's existing precedence /
 * `prepRow.titleSource` fallback runs unchanged. Inert until Phase 4.5.
 */
export function resolvePrepPresentation(
  entry: { id: string; data?: Record<string, string> | null },
  presentation?: WorkflowPresentationConfig,
): QueueRowPresentation | undefined {
  const prepTitle = presentation?.delegation?.prepTitle;
  if (prepTitle) {
    return resolveQueueRowPresentation(entry, { naming: { title: prepTitle } });
  }
  return undefined;
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

/** Map stamped row archetype to queue surface type; member rows render as single. */
export function entrySurfaceType(entry: TrackerEntry): WorkflowSurfaceType {
  const archetype = resolveRowArchetype(entry);
  if (archetype === "operation-member") return "single";
  return archetype;
}

function rowTypeLabelFor(surfaceType: WorkflowSurfaceType): string {
  return archetypeRowTypeLabel(surfaceType);
}

function operationGroupTitle(
  surface: TrackerQueueGroupSurface,
  context: WorkflowProjectionContext,
  policy: WorkflowRuntimePolicy,
): string {
  const overridden = firstNonBlank(context.resolveGroupTitle?.(surface), surface.titleOverride);
  if (overridden) return overridden;

  const anchor = surface.kind === "preview"
    ? surface.parent
    : surface.kind === "operation"
      ? surface.parent
      : undefined;

  // Person batches carry no synthetic title — the count badge + member-name
  // preview already identify the bag of people. Session-local ordinals
  // ("Oath 1", "<label> · #1234") are retired across all batch kinds.
  // Synthetic operation shells (`input-run-*`) carry no queueRowKind — read
  // kind from the real member rows instead of leaking the shell id as title.
  const kindEntry =
    surface.kind === "operation" &&
    anchor?.id.startsWith("input-run-") &&
    surface.members[0]
      ? surface.members[0]
      : anchor ?? surface.members[0];
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
  // Effective per-workflow naming config (code default ⊕ operator override),
  // supplied by Phase 4.5 via `context.resolvePresentation`. It now drives THREE
  // naming surfaces, gated by row scope/shape so each path is mutually exclusive:
  //   - member rows (`parentRunId`)        → delegation.memberTitle/memberSubtitle
  //   - prep rows  (`isPrepRow`)           → delegation.prepTitle (title only)
  //   - top-level rows (neither, stamped)  → naming.title/subtitle (THIS task, 6.3)
  // When no resolver is supplied (or it returns undefined), every branch is inert
  // and the expressions collapse to the pre-feature precedence
  // (`overrides.* ?? context.resolveEntry* ?? presentation?.* ?? fallback*`).
  const effectivePresentation = context.resolvePresentation?.(entry.workflow);
  const memberPresentation = entry.parentRunId
    ? resolveMemberPresentation(entry, effectivePresentation)
    : undefined;
  const prepPresentation = isPrepRow(entry)
    ? resolvePrepPresentation(entry, effectivePresentation)
    : undefined;
  // Member rows carry both title + subtitle naming; prep rows carry title only.
  const delegationTitle = memberPresentation?.title ?? prepPresentation?.title;
  const delegationSubtitle = memberPresentation?.subtitle;
  // Top-level (non-delegated) naming. `presentation` truthy ⇒ the row is STAMPED
  // (resolveQueueRowPresentation returns undefined when there is no queueRowKind),
  // so legacy/unstamped rows keep the `context.resolveEntry*` ladder. Gated OFF
  // for member (`parentRunId`) and prep (`isPrepRow`) rows — they consume the
  // delegation naming above, so this term must not double-apply. With the DEFAULT
  // naming this resolves byte-identically to `presentation` (6.1 Dimension A), and
  // for a stamped row `context.resolveEntryTitle` == `presentation.title`, so the
  // displaced precedence terms produce the same value — byte-identical no-op when
  // no override is set; an operator override surfaces here on the live queue row.
  const topLevelNaming =
    presentation && !entry.parentRunId && !isPrepRow(entry) && effectivePresentation?.naming
      ? resolveQueueRowPresentation(entry, {
          naming: effectivePresentation.naming,
          preferTraceIdSubtitle: overrides.preferTraceIdSubtitle,
        })
      : undefined;
  return {
    runId,
    workflowId: entry.workflow,
    itemId: entry.id,
    parentRunId: entry.parentRunId,
    title: overrides.title ?? delegationTitle ?? topLevelNaming?.title ?? context.resolveEntryTitle?.(entry) ?? presentation?.title ?? fallbackEntryTitle(entry, policy),
    subtitle: overrides.subtitle ?? delegationSubtitle ?? topLevelNaming?.subtitle ?? context.resolveEntrySubtitle?.(entry)
      ?? (presentation ? presentation.subtitle : fallbackEntrySubtitle(entry, policy)),
    status: context.resolveEntryStatus?.(entry) ?? entry.status,
    step: entry.step,
    surfaceType,
    rowTypeLabel: overrides.rowTypeLabel ?? rowTypeLabelFor(surfaceType),
    actions:
      overrides.actions ??
      withRowTargets(
        isDisplayOnlyRow(entry)
          ? policy.rowActions.filter((action) => action.kind === "delete")
          : policy.rowActions,
        targets,
      ),
    operationMembers: overrides.operationMembers ?? [],
  };
}

/**
 * The operation coordinator's chip always reflects the coordinator's OWN
 * lifecycle status — never a worst-member rollup (E2E-106).
 *
 * The coordinator is a display-only row whose lifecycle is self-contained:
 * - preparing → running/ocr-prep
 * - awaiting-review → running/awaiting-review (needsReview chip, handled in
 *   `headerStatus` in operation-row-variants.tsx via `ocr?.status`)
 * - approved → running/approved (members fanning out)
 * - failed/discarded → failed
 * - done → done
 *
 * Per-member outcomes (done/running/failed/cancelled) are surfaced by the
 * member mini-badge (`StatusCounts`), not by the coordinator's top chip.
 * A single failed member must NOT promote the coordinator to "Failed" — that
 * would misread as "the whole operation failed" when 2/3 contacts succeeded.
 * The rule is identical across oath-signature, emergency-contact, and
 * oath-upload (E2E-106).
 *
 * Pre-member fallbacks (no members yet, pre-fan-out) derive from the
 * coordinator's own status/step and denormalized OCR gate — never from
 * `memberAggregateStatus`.
 */
function operationSurfaceStatus(surface: Extract<TrackerQueueGroupSurface, { kind: "operation" }>): string {
  if (surface.members.length > 0) {
    // Shared rollup: the coordinator's OWN terminal status wins (e.g. a
    // failed/discarded mirror); else the coordinator's lifecycle COMPLETES when
    // the fan-out completes — once every member is terminal there is no more
    // work to coordinate, so the chip flips to "done" (the coordinator is a
    // display-only row with no daemon task of its own, so it never emits its own
    // terminal row — the rollup is the only signal). Per-member failures stay in
    // the StatusCounts mini-badge and never promote the coordinator chip to
    // "failed" (E2E-106) — a partly-failed fan-out still reads "done" at the
    // coordinator level. Members still in flight → the coordinator's own status
    // (running/approved), falling back to "running" if it is empty.
    return (
      rollupOperationStatus(
        surface.parent.status,
        surface.members.map((member) => member.status),
      ) || "running"
    );
  }
  // No members yet (pre-fan-out): use the coordinator's own status first.
  if (surface.parent.status === "failed" || surface.parent.status === "done") {
    return surface.parent.status;
  }
  // Denormalized OCR gate signals (pre-fan-out only, when no members).
  if (surface.ocr?.status === "failed" || surface.ocr?.status === "discarded") {
    return "failed";
  }
  if (surface.ocr?.status === "approved" || surface.ocr?.status === "done") {
    return surface.parent.status || "running";
  }
  return surface.parent.status || "running";
}

function isSyntheticOperationParent(parent: TrackerEntry | undefined): boolean {
  return parent?.id.startsWith("input-run-") ?? false;
}

/**
 * The entry whose title / subtitle / step / itemId anchors a group surface
 * card. Preview and operation surfaces always carry a real parent row; a batch
 * surface uses its parent when present and otherwise falls back to its first
 * member (an `alwaysOperationDelegatedMembers` one-member batch has no parent row).
 */
function surfaceAnchorEntry(surface: TrackerQueueGroupSurface): TrackerEntry | undefined {
  switch (surface.kind) {
    case "preview":
      return surface.parent;
    case "operation":
      if (isSyntheticOperationParent(surface.parent)) {
        return surface.members[0];
      }
      return surface.parent ?? surface.members[0];
  }
}

/**
 * A batch card's footer id must identify the **parent run** (the batch/operation
 * that owns the members), derived from `parentRunId` so it shares the members'
 * trace PREFIX but carries the parent's OWN `runId4` tail. Members render their
 * own trace id (`resolveEntryId`), so the parent footer and the member rows read
 * as one operation yet differ in the final 4 — never identical.
 *
 * When a real parent row exists its own trace already equals `<prefix>-<parentRunId4>`,
 * so this is a no-op there. The derivation is what fixes a cross-workflow
 * delegated batch with no parent row in panel (person-lookup / oath-signature
 * fan-out under an OCR operation): its anchor falls back to `members[0]`, which
 * would otherwise leak the *member's* tail as the parent footer id.
 */
function deriveOperationAnchorSubtitle(
  surface: TrackerQueueGroupSurface,
  anchor: TrackerEntry | undefined,
  fallback: string | undefined,
): string | undefined {
  if (surface.kind !== "operation") return fallback;
  // Real coordinator row in panel: keep its stamped trace (or other fallback).
  if (
    surface.parent &&
    anchor === surface.parent &&
    !isSyntheticOperationParent(surface.parent)
  ) {
    return fallback;
  }
  // Synthetic shell (delegated fan-out, no coordinator in this workflow):
  // derive parent trace from member prefix + parentRunId tail.
  const memberTrace = anchor?.data?.__traceId;
  if (typeof memberTrace !== "string" || !memberTrace) return fallback;
  const prefix = tracePrefix(memberTrace);
  const tail = runIdFragment(surface.parentRunId);
  return prefix && tail ? `${prefix}-${tail}` : fallback;
}

/** Roll up a group surface's card status from its parent row + member rows. */
function computeGroupStatus(surface: TrackerQueueGroupSurface): string {
  switch (surface.kind) {
    case "preview":
      return surface.parent.status;
    case "operation":
      return operationSurfaceStatus(surface);
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
  // when no parent row exists (an `alwaysOperationDelegatedMembers` one-member
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
  const groupParent = surface.kind === "operation" ? surface.parent : undefined;

  return {
    runId: surface.parentRunId,
    workflowId: fallbackWorkflow,
    itemId: surface.kind === "preview" ? surface.parent.id : groupParent?.id ?? surface.parentRunId,
    title: operationGroupTitle(surface, context, policy),
    subtitle: deriveOperationAnchorSubtitle(surface, anchor, anchorProjection?.subtitle),
    status,
    step: surface.kind === "preview" ? surface.parent.step : groupParent?.step,
    surfaceType,
    rowTypeLabel: rowTypeLabelFor(surfaceType),
    actions,
    operationMembers: members,
  };
}
