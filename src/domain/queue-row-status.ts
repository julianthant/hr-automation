/**
 * Queue row **status extensions** — the per-workflow status axis. Orthogonal to
 * `RowArchetype` (shape), `queueRowKind` (title/subtitle), and `parentRunId`
 * (scope). Where a workflow needs status semantics beyond the five universal
 * tracker statuses (`pending` | `running` | `done` | `failed` | `skipped`) plus
 * the universal `cancelled` override (`failed` + `step: "cancelled"`), it
 * declares them here instead of teaching a generic dashboard component to
 * branch on `entry.workflow === "..."`.
 *
 * Two extension points, both optional:
 *
 *   - **derivedStatus** — promote a row to a workflow-specific *display* status
 *     that replaces the base badge. Today: person-lookup's `notFound`
 *     (UCPath had no matching row; tracker status is still `done`) and OCR's
 *     `needsReview` (delegated OCR awaiting operator approval; tracker status
 *     is `running` + `step: "awaiting-approval"`). The returned key indexes the
 *     dashboard's `STATUS_CONFIG`, so the badge/icon/label still live with the
 *     renderer — only the *rule* lives with the workflow.
 *
 *   - **secondaryTag** — a small supplemental chip rendered alongside the
 *     status badge (NOT a replacement). Today: person-lookup's A / IA tag
 *     derived from `data.activeStatus` / `data.isActive`.
 *
 * Declared on `defineWorkflow` as `statusExtensions`. The rule objects
 * themselves live in this domain layer (client-bundle-safe — they import only
 * the existing pure predicates) so the dashboard can resolve status without
 * pulling any `src/workflows/*` module into the queue-panel bundle, mirroring
 * how `resolveQueueRowPresentation` keeps kind-based title logic in the domain.
 */

/**
 * Workflow-specific derived display statuses. These are *not* stored in the
 * tracker `status` field — they are computed from `status` + `step` + `data` by
 * a workflow's `statusExtensions.derivedStatus` rule and used by the dashboard
 * to pick an alternate `STATUS_CONFIG` entry.
 */
export type QueueRowDerivedStatus =
  | "needsReview"
  | "notFound"
  // separations EID-approval review: identity-check resolved a DIFFERENT EID by
  // name and PAUSED for operator approval instead of silently overriding. The
  // run is mechanically `done` (browsers released, queue proceeds); the row
  // displays "Awaiting Approval" until the operator approves/dismisses.
  | "awaitingApproval"
  // operator reviewed an awaitingApproval row and chose NOT to re-queue (will
  // fix the Kuali form by hand). Neutral terminal — not a failure.
  | "dismissed";

/** A supplemental status chip (rendered beside, not instead of, the badge). */
export interface QueueRowStatusTag {
  text: string;
  title: string;
  className: string;
}

/** Minimal entry shape the status rules read. Matches the dashboard `TrackerEntry`. */
export interface StatusExtensionEntry {
  workflow: string;
  status: string;
  step?: string;
  parentRunId?: string;
  data?: Record<string, string>;
}

/**
 * Context the renderer hands to a `secondaryTag` rule. `isDone` mirrors
 * EntryItem's own `isDone` (terminal `done`, excluding the delegated-OCR
 * needs-review override), so the A/IA tag can key off it for legacy rows
 * exactly as before.
 */
export interface StatusTagContext {
  isDone: boolean;
}

export interface WorkflowStatusExtensions {
  /**
   * Promote the row to a workflow-specific derived display status, or `null`
   * to leave the base status untouched. Evaluated AFTER the universal
   * `cancelled` override and BEFORE the base-status fallback.
   */
  derivedStatus?: (entry: StatusExtensionEntry) => QueueRowDerivedStatus | null;
  /**
   * Produce a supplemental status chip, or `null` for none. Evaluated
   * independently of the badge so a row can carry both a base status and a
   * secondary tag.
   */
  secondaryTag?: (entry: StatusExtensionEntry, ctx: StatusTagContext) => QueueRowStatusTag | null;
}

/**
 * Cross-workflow dry-run predicate. A workflow run started in dry-run mode
 * stamps `data.dryRun` onto every row it emits (onboarding via the schema
 * `dryRun` flag → `initialData` + `ctx.updateData`; oath-signature /
 * emergency-contact / oath-upload / OCR via their own `dryRun` flags). The
 * field is stringified through the SQLite task store and re-emitted by the
 * daemon, so it can arrive as the boolean `true` or the string `"true"` —
 * both mean dry-run. Anything else (absent, `"false"`, `false`) is a live run.
 *
 * This is a ROW-LEVEL concern shared by every workflow, not a per-workflow
 * status rule — so it lives here as a plain predicate the renderer reads
 * directly, NOT as a `statusExtensions.secondaryTag` (which is workflow-
 * specific). Pure + client-bundle-safe: reads only `entry.data`.
 */
export function isDryRunEntry(entry: { data?: Record<string, string> }): boolean {
  const v = entry.data?.dryRun;
  return v === "true" || (v as unknown) === true;
}

const REGISTRY = new Map<string, WorkflowStatusExtensions>();

/**
 * Register a workflow's status extensions. Called once per workflow at module
 * load (statically, via the domain extension index — see
 * `queue-row-status-index.ts`) AND by `defineWorkflow` for the server path.
 * Idempotent.
 */
export function registerWorkflowStatusExtensions(
  workflowId: string,
  extensions: WorkflowStatusExtensions,
): void {
  REGISTRY.set(workflowId, extensions);
}

/** Look up a workflow's status extensions, if any. */
export function getWorkflowStatusExtensions(
  workflowId: string,
): WorkflowStatusExtensions | undefined {
  return REGISTRY.get(workflowId);
}

export interface ResolvedQueueRowStatus {
  /** Workflow-specific derived status key, or `null` to use the base status. */
  derivedStatus: QueueRowDerivedStatus | null;
  /** Supplemental status chip, or `null`. */
  secondaryTag: QueueRowStatusTag | null;
}

/**
 * Resolve a row's workflow-specific status extensions. Workflow-agnostic: the
 * caller (EntryItem) passes the entry + its own `isDone` and renders whatever
 * comes back, with no knowledge of which workflow owns which rule.
 *
 * Returns all-`null` for workflows that declare no extensions, so the renderer
 * keeps its default base-status behavior unchanged.
 */
export function resolveQueueRowStatus(
  entry: StatusExtensionEntry,
  ctx: StatusTagContext,
): ResolvedQueueRowStatus {
  const ext = REGISTRY.get(entry.workflow);
  return {
    derivedStatus: ext?.derivedStatus?.(entry) ?? null,
    secondaryTag: ext?.secondaryTag?.(entry, ctx) ?? null,
  };
}

/** Test-only: wipe the registry between cases. */
export function __resetWorkflowStatusExtensionsForTests(): void {
  REGISTRY.clear();
}
