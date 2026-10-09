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
  /**
   * Top-level run tracker / coordinator for an input-run parent or an OCR-backed
   * target workflow (oath-signature, emergency-contact). Holds lightweight OCR
   * status before approval and summarizes fanned-out child rows after approval.
   * May be a display-only row with no daemon task when stamped at OCR prepare.
   */
  | "operation"
  /**
   * Peer person/subject row fanned out under an {@link "operation"} coordinator.
   * Nests under the operation parent (`parentRunId`) and renders inside the
   * coordinator card. Stamped via the `operation-member` row-shape runtime option.
   */
  | "operation-member";

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
  /** Emits an operation coordinator row (input-run parent or OCR-backed coordinator). */
  | "operation";

const LABELS: Record<RowArchetype, string> = {
  "single": "Single",
  "preview": "Preview",
  "operation": "Operation",
  "operation-member": "Operation member",
};

/** Delegated/fanned-out peer rows that nest under an operation coordinator. */
export type MemberRowShape = "operation-member";

export function isMemberRowShape(v: unknown): v is MemberRowShape {
  return v === "operation-member";
}

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

/** Legacy JSONL stamps still encountered in older tracker files. */
function normalizeLegacyRowArchetype(stamped: unknown): RowArchetype | undefined {
  if (stamped === "batch") return "operation";
  if (stamped === "batch-member") return "operation-member";
  return undefined;
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
  const legacy = normalizeLegacyRowArchetype(stamped);
  if (legacy) return legacy;
  if (typeof stamped === "string" && isRowArchetype(stamped)) return stamped;
  throw new Error(
    `resolveRowArchetype: data.archetype is set but not a valid RowArchetype — bug. ` +
      `Got ${JSON.stringify(stamped)} on parentRunId=${entry.parentRunId ?? "<none>"}.`,
  );
}

export function isRowArchetype(v: string): v is RowArchetype {
  return (
    v === "single" ||
    v === "preview" ||
    v === "operation" ||
    v === "operation-member"
  );
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
  "operation",
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
        `which is not a valid WorkflowArchetype (expected one of: single, preview, operation).`,
      );
    }
    return result;
  }
  if (!isWorkflowArchetype(archetype)) {
    throw new Error(
        `resolveArchetype: workflow '${workflowName}' has invalid literal archetype ${JSON.stringify(archetype)} ` +
        `(expected one of: single, preview, operation).`,
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
 */
export function deriveRowArchetype(
  workflowArchetype: WorkflowArchetype,
  _parentRunId?: string,
  opts?: { member?: boolean; memberShape?: MemberRowShape },
): RowArchetype {
  if (opts?.memberShape) return opts.memberShape;
  if (opts?.member) return "operation-member";
  if (workflowArchetype === "preview") return "preview";
  if (workflowArchetype === "operation") return "operation";
  return "single";
}
