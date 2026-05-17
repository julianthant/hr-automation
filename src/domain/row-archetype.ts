export type RowArchetype =
  | "single"           // one item one row, detail grid + timeline
  | "batch-parent"     // anchor over N peers (OCR prep, daemon batch)
  | "batch-member"     // peer item under a batch-parent
  | "dispatch"         // records "I delegated to N children"; terminal at enqueue
  | "delegate-child"   // run spawned by parent in a different workflow
  | "passive-child";   // collapsed utility child; no operator action

export type WorkflowArchetype =
  | "single"
  | "batch"
  | "delegating"
  | "delegating-batch"
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
