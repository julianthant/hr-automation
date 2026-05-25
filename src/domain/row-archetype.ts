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
 * Read `data.archetype`. Post-Contract-1, every production tracker row is
 * written through `emitTrackerRow` which requires `StampedData` at the type
 * level — `archetype` is always present in real data.
 *
 * Behavior when the field is not a valid `RowArchetype`:
 *   - **Missing** (unstamped entry) → return the canonical mapping
 *     `deriveRowArchetype("single", parentRunId)` (i.e. `"delegate-child"`
 *     when a parent is set, else `"single"`). This is the same value
 *     `emitTrackerRow` would have stamped for an unspecified workflow.
 *   - **Present but invalid string** (e.g. `"nonsense"`) → throw. That's
 *     a write-side bug worth surfacing — production code can't reach this
 *     state through the type system, so it's almost certainly a hand-rolled
 *     entry that meant something else.
 *
 * The old legacy heuristics (`mode === "prepare"` → batch-parent,
 * `taskRole === "utility"` → passive-child, `requestRole === "delegation-dispatch"`
 * → dispatch) were deleted along with the historic JSONL they were written for.
 */
export function resolveRowArchetype(entry: ResolveEntry): RowArchetype {
  const stamped = entry.data?.archetype;
  if (stamped === undefined || stamped === null) {
    return entry.parentRunId ? "delegate-child" : "single";
  }
  if (typeof stamped === "string" && isRowArchetype(stamped)) return stamped;
  throw new Error(
    `resolveRowArchetype: data.archetype is set but not a valid RowArchetype — bug. ` +
      `Got ${JSON.stringify(stamped)} on parentRunId=${entry.parentRunId ?? "<none>"}.`,
  );
}

function isRowArchetype(v: string): v is RowArchetype {
  return v === "single" || v === "batch-parent" || v === "batch-member"
    || v === "dispatch" || v === "delegate-child" || v === "passive-child";
}

/**
 * `WorkflowConfig.archetype` accepts either a literal `WorkflowArchetype` or
 * a resolver function that decides the archetype from the validated input.
 * The resolver form lets a workflow declare different row shapes for
 * different input variants (e.g. oath-signature is `batch` when called with
 * `{ kind: "pdf" }` and `single` when called with `{ kind: "signer" }`).
 *
 * Use `resolveArchetype(config, input)` (or `resolveArchetypeFromValue`) at
 * every read site rather than reading `config.archetype` / `wf.archetype`
 * directly — the helpers fail loud if a resolver returns a value that is
 * not a valid `WorkflowArchetype`.
 */
export type ArchetypeResolver<TInput> = (input: TInput) => WorkflowArchetype;
export type WorkflowArchetypeOrResolver<TInput> =
  | WorkflowArchetype
  | ArchetypeResolver<TInput>;

const VALID_WORKFLOW_ARCHETYPES = new Set<string>([
  "single",
  "batch",
  "delegating",
  "delegating-batch",
  "utility",
]);

function isWorkflowArchetype(v: unknown): v is WorkflowArchetype {
  return typeof v === "string" && VALID_WORKFLOW_ARCHETYPES.has(v);
}

export function resolveArchetypeFromValue<TInput>(
  archetype: WorkflowArchetypeOrResolver<TInput>,
  input: TInput,
  workflowName: string,
): WorkflowArchetype {
  if (typeof archetype === "function") {
    const result = archetype(input);
    if (!isWorkflowArchetype(result)) {
      throw new Error(
        `resolveArchetype: workflow '${workflowName}' archetype resolver returned ${JSON.stringify(result)}, ` +
          `which is not a valid WorkflowArchetype (expected one of: single, batch, delegating, delegating-batch, utility).`,
      );
    }
    return result;
  }
  if (!isWorkflowArchetype(archetype)) {
    throw new Error(
      `resolveArchetype: workflow '${workflowName}' has invalid literal archetype ${JSON.stringify(archetype)} ` +
        `(expected one of: single, batch, delegating, delegating-batch, utility).`,
    );
  }
  return archetype;
}

export function resolveArchetype<TInput>(
  config: { name: string; archetype?: WorkflowArchetypeOrResolver<TInput> },
  input: TInput,
): WorkflowArchetype {
  if (config.archetype === undefined) {
    throw new Error(
      `resolveArchetype: workflow '${config.name}' has no archetype declared; ` +
        `defineWorkflow should have substituted a default before this point.`,
    );
  }
  return resolveArchetypeFromValue(config.archetype, input, config.name);
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
