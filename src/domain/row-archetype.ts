/**
 * Row-level archetype. Stamped on every tracker row as `data.archetype`.
 * Canonical discriminator for queue surface, log panel footer chip, and
 * display-name resolution. Read via `resolveRowArchetype(entry)`; write via
 * `deriveRowArchetype(workflowArchetype, parentRunId?)` at pre-emit sites,
 * or let `withTrackedWorkflow` stamp it via the `archetype` opt.
 */
export type RowArchetype =
  /** One item, one row. Flat in the queue. Workflows: work-study, oath-signature (direct CLI run), active-check. */
  | "single"
  /** Anchor row over N peers. Emitted by OCR prep, oath-upload root. */
  | "batch-parent"
  /** Peer item under a batch-parent. Emitted by emergency-contact records, oath-signature batch members. */
  | "batch-member"
  /** Terminal-at-enqueue row recording "I delegated to N children in another workflow." */
  | "dispatch"
  /** Child run spawned from a parent in a different workflow; holds operator attention. */
  | "delegate-child"
  /** Collapsed delegate-child rendered as a sub-row inside its parent's card; never holds operator attention. */
  | "passive-child";

/**
 * Workflow-level archetype. Declared on every `defineWorkflow({...})` call.
 * The kernel uses this plus `parentRunId` to pick the appropriate
 * `RowArchetype` for each emitted row. Architecture guard
 * `tests/unit/architecture/archetype-coverage.test.ts` enforces declaration.
 */
export type WorkflowArchetype =
  /** Emits `single` rows only. Examples: work-study, active-check. */
  | "single"
  /** Emits a batch-parent over N batch-member rows. Examples: emergency-contact, oath-signature. */
  | "batch"
  /** Emits `single` + `dispatch` + N delegate-children. Examples: ocr (parent), separations (when delegating). */
  | "delegating"
  /** Emits batch-parent that delegates each member to another workflow. Examples: oath-upload. */
  | "delegating-batch"
  /** Child-only workflow that holds no operator attention; always rendered as `passive-child`. Examples: eid-lookup (as passive child). */
  | "utility";

const LABELS: Record<RowArchetype, string> = {
  "single": "Single",
  "batch-parent": "Batch parent",
  "batch-member": "Batch member",
  "dispatch": "Dispatch",
  "delegate-child": "Delegated",
  "passive-child": "Passive",
};

export function archetypeRowTypeLabel(archetype: RowArchetype): string {
  return LABELS[archetype];
}

interface ResolveEntry {
  parentRunId?: string;
  data?: Record<string, unknown> | null;
}

/**
 * Read `data.archetype` when present and valid; otherwise default to
 * `delegate-child` when `parentRunId` is set, or `single` — matching
 * `deriveRowArchetype("single", parentRunId)` in the absence of workflow info.
 */
export function resolveRowArchetype(entry: ResolveEntry): RowArchetype {
  const stamped = entry.data?.archetype;
  if (typeof stamped === "string" && isRowArchetype(stamped)) return stamped;

  if (entry.data?.mode === "prepare") return "batch-parent";
  if (entry.data?.taskRole === "utility") return "passive-child";
  if (entry.data?.requestRole === "delegation-dispatch") return "dispatch";

  return entry.parentRunId ? "delegate-child" : "single";
}

function isRowArchetype(v: string): v is RowArchetype {
  return v === "single" || v === "batch-parent" || v === "batch-member"
    || v === "dispatch" || v === "delegate-child" || v === "passive-child";
}

/**
 * Derive the RowArchetype for a single tracker row given the workflow's
 * declared WorkflowArchetype and whether the row has a parent run.
 * Used by pre-emit write sites that don't go through withTrackedWorkflow.
 *
 * Mapping:
 *   parentRunId present + utility  → "passive-child"  (EID lookup, active-check children)
 *   parentRunId present + other    → "delegate-child" (OCR under oath-upload, oath-sig fan-out)
 *   no parentRunId + delegating-batch → "batch-parent" (oath-upload root row)
 *   no parentRunId + batch         → "batch-parent"   (anchor row — members carry parentRunId)
 *   no parentRunId + everything else → "single"
 */
export function deriveRowArchetype(
  workflowArchetype: WorkflowArchetype,
  parentRunId?: string,
): RowArchetype {
  if (parentRunId) {
    return workflowArchetype === "utility" ? "passive-child" : "delegate-child";
  }
  if (workflowArchetype === "delegating-batch" || workflowArchetype === "batch") {
    return "batch-parent";
  }
  return "single";
}
