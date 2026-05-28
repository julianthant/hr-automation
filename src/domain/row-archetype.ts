/**
 * Row-level archetype. Stamped on every tracker row as `data.archetype`.
 * Canonical shape discriminator for queue surface, log panel footer chip,
 * and display-name resolution. Scope is not encoded here: a row is delegated
 * when it has `parentRunId`. Read via `resolveRowArchetype(entry)`; write via
 * `deriveRowArchetype(workflowArchetype, parentRunId?)` at pre-emit sites.
 */
export type RowArchetype =
  /** One person/subject, one row. Flat in the queue. Workflows: work-study, direct oath-signature signer runs. */
  | "single"
  /** One review/approval row with a preview surface. Workflow: OCR. */
  | "preview"
  /** Anchor row over N people/subjects, or a parent that will fan out to people after approval. */
  | "batch"
  /** Peer person/subject row under a batch anchor or grouped input-run parent. */
  | "batch-member";

/**
 * Workflow-level archetype. Declared on every `defineWorkflow({...})` call.
 * The kernel uses this plus `parentRunId` to pick the appropriate
 * `RowArchetype` for each emitted row. Architecture guard
 * `tests/unit/architecture/archetype-coverage.test.ts` enforces declaration.
 */
export type WorkflowArchetype =
  /** Emits one person/subject row per input item. Examples: work-study, person-lookup, oath-signature signer input. */
  | "single"
  /** Emits one preview/approval row. Example: OCR. */
  | "preview"
  /** Emits a grouped parent row or upload/approval path that fans out to batch-member rows. */
  | "batch";

const LABELS: Record<RowArchetype, string> = {
  "single": "Single",
  "preview": "Preview",
  "batch": "Batch",
  "batch-member": "Batch member",
};

export function archetypeRowTypeLabel(archetype: RowArchetype): string {
  return LABELS[archetype];
}

interface ResolveEntry {
  parentRunId?: string;
  data?: Record<string, unknown> | null;
}

export interface DelegationRoleEntry {
  data?: Record<string, unknown> | null;
}

/**
 * Read `data.archetype`. Every production tracker row is written through
 * `emitTrackerRow` which requires `StampedData` at the type level —
 * `archetype` is always present in real data.
 *
 * Behavior when the field is not a valid `RowArchetype`:
 *   - **Missing** (unstamped entry) → return `"single"`. Parentage is
 *     expressed by `parentRunId`, not by a separate row archetype.
 *   - **Present but invalid string** (e.g. `"nonsense"`) → throw. That's
 *     a write-side bug worth surfacing — production code can't reach this
 *     state through the type system, so it's almost certainly a hand-rolled
 *     entry that meant something else.
 */
export function resolveRowArchetype(entry: ResolveEntry): RowArchetype {
  const stamped = entry.data?.archetype;
  if (stamped === undefined || stamped === null) {
    return "single";
  }
  if (typeof stamped === "string" && isRowArchetype(stamped)) return stamped;
  throw new Error(
    `resolveRowArchetype: data.archetype is set but not a valid RowArchetype — bug. ` +
      `Got ${JSON.stringify(stamped)} on parentRunId=${entry.parentRunId ?? "<none>"}.`,
  );
}

export function isRowArchetype(v: string): v is RowArchetype {
  return v === "single" || v === "preview" || v === "batch" || v === "batch-member";
}

/**
 * Forward rows that represent a terminal delegation/dispatch marker carry
 * `data.delegationRole = "dispatch"`. Keep the role test separate from
 * `resolveRowArchetype`, which deliberately returns only canonical shapes.
 */
export function hasDelegationRole(entry: DelegationRoleEntry, role: "dispatch"): boolean {
  return entry.data?.delegationRole === role;
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
  "preview",
  "batch",
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
        `which is not a valid WorkflowArchetype (expected one of: single, preview, batch).`,
      );
    }
    return result;
  }
  if (!isWorkflowArchetype(archetype)) {
    throw new Error(
        `resolveArchetype: workflow '${workflowName}' has invalid literal archetype ${JSON.stringify(archetype)} ` +
        `(expected one of: single, preview, batch).`,
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
 *   member option                  → "batch-member"
 *   workflowArchetype === "preview" → "preview"
 *   workflowArchetype === "batch"  → "batch"
 *   everything else                → "single"
 *
 * `parentRunId` does not affect the stamped archetype. It only determines
 * whether the row is scoped as root or delegated at projection time.
 */
export function deriveRowArchetype(
  workflowArchetype: WorkflowArchetype,
  _parentRunId?: string,
  opts?: { member?: boolean },
): RowArchetype {
  if (opts?.member) return "batch-member";
  if (workflowArchetype === "preview") return "preview";
  return workflowArchetype === "batch" ? "batch" : "single";
}
