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
  /** Anchor row over N peers. Legacy fallback: `data.mode === "prepare"`. Emitted by OCR prep, oath-upload root. */
  | "batch-parent"
  /** Peer item under a batch-parent. Emitted by emergency-contact records, oath-signature batch members. */
  | "batch-member"
  /** Terminal-at-enqueue row recording "I delegated to N children in another workflow." Legacy fallback: `data.requestRole === "delegation-dispatch"`. */
  | "dispatch"
  /** Child run spawned from a parent in a different workflow; holds operator attention. Legacy fallback: `data.taskRole === "child" && originWorkflow`. */
  | "delegate-child"
  /** Collapsed delegate-child rendered as a sub-row inside its parent's card; never holds operator attention. Legacy fallback: `data.taskRole === "utility" && originWorkflow`. */
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

interface LegacyEntry {
  workflow?: string;
  id?: string;
  parentRunId?: string;
  data?: Record<string, unknown> | null;
}

/**
 * Read `data.archetype` when present; otherwise infer from legacy fields so
 * pre-archetype JSONL rows still classify correctly. Once all readers are
 * migrated and on-disk rows have aged out, the legacy branches can be removed.
 *
 * Fallback ordering (only used when `data.archetype` is missing):
 *  1. `data.requestRole === "delegation-dispatch"` → `dispatch`
 *  2. `data.mode === "prepare"` OR `entry.workflow === "ocr"` → `batch-parent`
 *  3. `data.taskRole === "utility" && originWorkflow` → `passive-child`
 *  4. `data.taskRole === "child" && originWorkflow` → `delegate-child`
 *  5. `entry.parentRunId` present → `batch-member`
 *  6. Otherwise → `single`
 */
export function resolveRowArchetype(entry: LegacyEntry): RowArchetype {
  const stamped = entry.data?.archetype;
  if (typeof stamped === "string" && isRowArchetype(stamped)) return stamped;

  const data = entry.data ?? {};
  const taskRole = typeof data.taskRole === "string" ? data.taskRole : undefined;
  const requestRole = typeof data.requestRole === "string" ? data.requestRole : undefined;
  const originWorkflow = typeof data.originWorkflow === "string" ? data.originWorkflow : undefined;
  const mode = typeof data.mode === "string" ? data.mode : undefined;

  if (requestRole === "delegation-dispatch") return "dispatch";
  if (mode === "prepare" || entry.workflow === "ocr") return "batch-parent";
  if (taskRole === "utility" && originWorkflow) return "passive-child";
  if (taskRole === "child" && originWorkflow) return "delegate-child";
  if (entry.parentRunId) return "batch-member";
  return "single";
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
 *   no parentRunId + batch         → "batch-member"   (emergency-contact / oath-signature items)
 *   no parentRunId + everything else → "single"
 */
export function deriveRowArchetype(
  workflowArchetype: WorkflowArchetype,
  parentRunId?: string,
): RowArchetype {
  if (parentRunId) {
    return workflowArchetype === "utility" ? "passive-child" : "delegate-child";
  }
  if (workflowArchetype === "delegating-batch") return "batch-parent";
  if (workflowArchetype === "batch") return "batch-member";
  return "single";
}
