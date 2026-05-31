/**
 * Queue row **kind** — the subject-semantics axis. Orthogonal to
 * `RowArchetype` (shape: single/preview/batch) and `parentRunId` (scope:
 * root/delegated). Stamped on every tracker row as `data.queueRowKind`.
 *
 * Kind drives ONLY the queue **title + subtitle** resolution
 * (see `resolveQueueRowPresentation`). It does not affect layout, grouping,
 * footer buttons, or status chips — those are owned by archetype, scope, and
 * the per-workflow `statusExtensions` respectively.
 *
 *   person  — one human subject. Title: resolved name (pending: typed input).
 *             Subtitle: EID.
 *   file    — one uploaded document. Title: PDF filename. Subtitle: trace id.
 *   catalog — one named registry entry (roster/report). Title: spec label.
 *             Subtitle: trace id.
 *
 * Declared on `defineWorkflow` as `queueRowKind` — either a literal kind or a
 * resolver `(input) => QueueRowKind` for workflows whose kind depends on the
 * input variant (e.g. oath-signature: `pdf` → file, `signer` → person),
 * mirroring the `archetype` resolver pattern in `row-archetype.ts`.
 */
export type QueueRowKind = "person" | "file" | "catalog";

const VALID_QUEUE_ROW_KINDS = new Set<string>(["person", "file", "catalog"]);

export function isQueueRowKind(v: unknown): v is QueueRowKind {
  return typeof v === "string" && VALID_QUEUE_ROW_KINDS.has(v);
}

export type QueueRowKindResolver<TInput> = (input: TInput) => QueueRowKind;
export type QueueRowKindOrResolver<TInput> = QueueRowKind | QueueRowKindResolver<TInput>;

/**
 * Resolve a workflow's declared `queueRowKind` against a concrete input.
 * Fails loud when a resolver returns a non-`QueueRowKind` value — same policy
 * as `resolveArchetypeFromValue`.
 */
export function resolveQueueRowKindFromValue<TInput>(
  kind: QueueRowKindOrResolver<TInput>,
  input: TInput,
  workflowName: string,
): QueueRowKind {
  const result = typeof kind === "function" ? (kind as QueueRowKindResolver<TInput>)(input) : kind;
  if (!isQueueRowKind(result)) {
    throw new Error(
      `resolveQueueRowKind: workflow '${workflowName}' produced ${JSON.stringify(result)}, ` +
        `which is not a valid QueueRowKind (expected one of: person, file, catalog).`,
    );
  }
  return result;
}

interface KindEntry {
  data?: Record<string, unknown> | null;
}

/**
 * Read the stamped `data.queueRowKind` off a tracker entry.
 *
 *   - **Missing/blank** (legacy or unmigrated row) → `undefined`, so the
 *     presentation resolver can fall back to the pre-kind title/subtitle
 *     logic during migration.
 *   - **Present but invalid** → throw. Production rows are stamped through a
 *     single pre-emit path, so a bad value is a write-side bug worth
 *     surfacing (same policy as `resolveRowArchetype`).
 */
export function resolveQueueRowKind(entry: KindEntry): QueueRowKind | undefined {
  const stamped = entry.data?.queueRowKind;
  if (stamped === undefined || stamped === null || stamped === "") return undefined;
  if (isQueueRowKind(stamped)) return stamped;
  throw new Error(
    `resolveQueueRowKind: data.queueRowKind is set but not a valid QueueRowKind — bug. ` +
      `Got ${JSON.stringify(stamped)}.`,
  );
}
