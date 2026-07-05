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
 * NOT declared directly on `defineWorkflow` — it is *derived* from the
 * workflow's `inputSubject` (see `InputSubject` / `queueRowKindFromInputSubject`
 * below) inside the kernel normalizer, then stamped onto every row. Workflows
 * declare their input subject (`name`/`eid`/`email`/`kualiId`/`pdf`/`selector`),
 * a literal or a resolver for input-variant workflows (e.g. oath-signature:
 * `pdf` → file, `eid` → person).
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
  const result = typeof kind === "function" ? (kind)(input) : kind;
  if (!isQueueRowKind(result)) {
    throw new Error(
      `resolveQueueRowKind: workflow '${workflowName}' produced ${JSON.stringify(result)}, ` +
        `which is not a valid QueueRowKind (expected one of: person, file, catalog).`,
    );
  }
  return result;
}

/**
 * Input **subject** — what a workflow receives as input, declared on every
 * `defineWorkflow` as `inputSubject`. This is the single source axis the
 * presentation `queueRowKind` is *derived* from (see `subjectToQueueRowKind`);
 * workflows no longer declare `queueRowKind` directly.
 *
 *   name     — a person identified by name (separations' employee,
 *              emergency-contact records, person-lookup name search).
 *   eid      — a person identified by employee id (work-study, old-kronos,
 *              oath-signature signer, person-lookup EID search).
 *   email    — a person identified by email (onboarding, crm-doc-download).
 *   kualiId  — a person identified by a Kuali document id (separations input).
 *   pdf      — an uploaded document (ocr, oath-upload, oath-signature pdf).
 *   selector — a catalog/registry selection with no person/file identifier
 *              (sharepoint-download — you pick which spec to download).
 *
 * Many subjects funnel onto the three presentation kinds: every
 * person-identifying subject → `person`, `pdf` → `file`, `selector` →
 * `catalog`. The funnel keeps the presentation taxonomy small while letting
 * each workflow name its input precisely.
 */
export type InputSubject = "name" | "eid" | "email" | "kualiId" | "pdf" | "selector";

const SUBJECT_TO_KIND: Record<InputSubject, QueueRowKind> = {
  name: "person",
  eid: "person",
  email: "person",
  kualiId: "person",
  pdf: "file",
  selector: "catalog",
};

export function isInputSubject(v: unknown): v is InputSubject {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(SUBJECT_TO_KIND, v);
}

/** Map an input subject to its presentation queue-row kind. Fails loud on a bad value. */
export function subjectToQueueRowKind(subject: InputSubject): QueueRowKind {
  if (!isInputSubject(subject)) {
    throw new Error(
      `subjectToQueueRowKind: ${JSON.stringify(subject)} is not a valid InputSubject ` +
        `(expected one of: ${Object.keys(SUBJECT_TO_KIND).join(", ")}).`,
    );
  }
  return SUBJECT_TO_KIND[subject];
}

export type InputSubjectResolver<TInput> = (input: TInput) => InputSubject;
export type InputSubjectOrResolver<TInput> = InputSubject | InputSubjectResolver<TInput>;

/**
 * Convert a workflow's declared `inputSubject` (literal or resolver) into the
 * derived `QueueRowKindOrResolver` the stamping pipeline consumes. A resolver
 * subject becomes a resolver kind; a literal subject is mapped eagerly. Bad
 * values fail loud via `subjectToQueueRowKind` — same policy as
 * `resolveQueueRowKindFromValue`.
 */
export function queueRowKindFromInputSubject<TInput>(
  subject: InputSubjectOrResolver<TInput>,
): QueueRowKindOrResolver<TInput> {
  if (typeof subject === "function") {
    const resolver = subject;
    return (input: TInput) => subjectToQueueRowKind(resolver(input));
  }
  return subjectToQueueRowKind(subject);
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
