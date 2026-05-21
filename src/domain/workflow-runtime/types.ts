export type WorkflowSurfaceType =
  | "normal"
  | "approval-delegation"
  | "batch-delegation"
  | "passive-delegation"
  | "delegation-member";

export type WorkflowActionKind =
  | "cancel"
  | "retry"
  | "delete"
  | "bump"
  | "stop-daemon";

export type WorkflowActionScope =
  | "row"
  | "group"
  | "visible-view"
  | "tree"
  | "daemon";

export type WorkflowActionSource =
  | "queue-panel"
  | "batch-view"
  | "log-panel"
  | "daemon";

export interface WorkflowActionPolicy {
  kind: WorkflowActionKind;
  scope: WorkflowActionScope;
  source: WorkflowActionSource;
  label: string;
  enabled: boolean;
  operational?: boolean;
  reason?: string;
}

export interface WorkflowActionTargetDescriptor {
  workflowId: string;
  id: string;
  runId?: string;
  date?: string;
  status?: string;
}

export interface WorkflowActionDescriptor extends WorkflowActionPolicy {
  targets: WorkflowActionTargetDescriptor[];
}

export interface WorkflowRunProjection {
  runId: string;
  workflowId: string;
  itemId: string;
  parentRunId?: string;
  title: string;
  subtitle?: string;
  status: string;
  step?: string;
  surfaceType: WorkflowSurfaceType;
  rowTypeLabel: string;
  actions: WorkflowActionDescriptor[];
  batchMembers: WorkflowRunProjection[];
}

/**
 * How this workflow's delegation tree behaves at the dashboard level.
 *
 * Phase 4 turns the previously-implicit OCR/Oath/Emergency rules into
 * declarations workflow files own, so dashboard projections/actions read
 * from one place instead of pattern-matching on workflow ids.
 */
export interface WorkflowDelegationPolicy {
  /**
   * OCR utility fan-out (EID Lookup, Active Check spawned by an OCR prep
   * row) must stay as `delegation-member` rows even when 2+ children share
   * one parentRunId — they should never be promoted to a batch-delegation
   * group. Default: "delegation-member".
   */
  utilityChildSurface?: "delegation-member" | "batch-delegation";
  /**
   * Workflows that count as utility children for `utilityChildSurface`.
   * OCR uses this to keep EID Lookup / Active Check fan-out flat while
   * still allowing approved target workflow rows to render as normal
   * delegation members or groups.
   */
  utilityChildWorkflows?: string[];
  /**
   * One failed approval-dependency child blocks the parent task until the
   * child is retried/cancelled. Mirrors the `block_parent` setting that
   * Oath Upload's approval dependencies create in `task_dependencies`.
   */
  failedChildBlocksParent?: boolean;
  /**
   * Same row id persists through the entire workflow even as the run
   * delegates to sub-workflows (Oath Upload root row stays one row across
   * OCR + signature + ServiceNow stages).
   */
  rootRowPersistsThroughChildren?: boolean;
}

/**
 * Approval / preview affordances for an approval-delegation surface.
 * Used by the log panel's row-type chip and by tests that need to assert
 * the rendered label without re-deriving it from `previewAvailable`.
 */
export interface WorkflowPreviewPolicy {
  /** Suffix appended to the row-type label when preview is available. Defaults to "Preview". */
  rowTypeLabelSuffix?: string;
  /** True when this workflow's approval-delegation surface always has a preview tab. */
  alwaysAvailable?: boolean;
}

/**
 * Final per-record member rows after approval. Oath Signature and
 * Emergency Contact members title by person name; OCR utility children
 * inherit the default member rendering.
 */
export interface WorkflowMemberRowPolicy {
  /**
   * Prefer the person/employee name fallback over `__name`/`__id` for
   * delegation-member titles. Phase 4 uses this for oath-signature and
   * emergency-contact final rows so post-approval rows read as a person's
   * name rather than a technical retry id.
   */
  titleSource?: "person" | "default";
  /** Default subtitle override for member rows; absent → normal row footer. */
  subtitle?: string;
}

/**
 * File prep row controlled by an upstream OCR run. Used to declare that
 * Oath Signature's file-level prep row should title by PDF filename and
 * subtitle as `Oath · <last4 run id>` instead of leaking technical ids.
 */
export interface WorkflowPrepRowPolicy {
  /** `"pdf-original-name"` → title from data.pdfOriginalName; default → existing fallback. */
  titleSource?: "pdf-original-name" | "default";
  /** Subtitle template, e.g. `"Oath · <last4 run id>"`. `<last4 run id>` is interpolated at projection time. */
  subtitleTemplate?: string;
}

export interface WorkflowRuntimePolicy {
  rowActions: WorkflowActionPolicy[];
  groupActions: WorkflowActionPolicy[];
  batchViewToolbarActions: WorkflowActionPolicy[];
  daemonActions: WorkflowActionPolicy[];
  /** Delegation/cancel-scope behavior for this workflow. */
  delegation?: WorkflowDelegationPolicy;
  /** Approval-preview surface affordances. */
  preview?: WorkflowPreviewPolicy;
  /** Final member-row title/subtitle rules. */
  memberRow?: WorkflowMemberRowPolicy;
  /** OCR prep file row title/subtitle rules. */
  prepRow?: WorkflowPrepRowPolicy;
}
