# The three-axis row model

Every tracker/queue row is classified on **three orthogonal axes**. Mixing them up is the most common modeling mistake — keep them separate.

Source: `src/domain/queue-row-kind.ts`, `src/domain/queue-row-presentation.ts`, `src/domain/row-archetype.ts`, root `CLAUDE.md`.

## Axis 1 — Shape (`archetype`)

The row's structure. Declared via `archetype` (literal or resolver).

- `single` — one subject, one row. (`single` means one *person/subject*, not one daemon run.)
- `preview` — an approval/review card (OCR review pane).
- `batch` — an anchor over N members. Members render as `batch-member` rows.

Defaults: `batch` if `batch:` config is present, else `single`. A multi-person input run or an approve/upload flow that fans out to people is a `batch` surface with `batch-member` rows.

## Axis 2 — Scope (`parentRunId`)

Root vs delegated. **Not a separate archetype family** and **not declared** — the kernel stamps `parentRunId = parent.ctx.runId` when one workflow delegates to another. A delegated `single` row is still `single`; scope never changes shape. Child presentation rules and wait gates live on the **parent** (`runtimePolicy` + orchestrator), never on the child row type.

## Axis 3 — Kind (`queueRowKind`, derived from `inputSubject`)

What the row is *about*, driving **only** its title + subtitle (resolved by `resolveQueueRowPresentation`). Never footer buttons, layout, grouping, or status chips.

Workflows declare `inputSubject`; the kernel **derives** `queueRowKind`:

| `inputSubject` | → `queueRowKind` |
|----------------|------------------|
| `name`, `eid`, `email`, `kualiId` | `person` |
| `pdf` | `file` |
| `selector` | `catalog` |

Title by kind:
- **person** → resolved name (pending: typed name/EID). A person **batch anchor has no title** — the count badge + member-name preview identify it.
- **file** → PDF filename.
- **catalog** → registry/spec label.

Subtitle rule (flat single): **EID if present, else the trace id.** The pending→resolved phase is derived at projection time from data presence — not stamped.

**Divergence for member/preview surfaces:** when the EID/name is already shown ELSEWHERE on the card — a **batch / preview group anchor** (the member-name preview shows each person's EID on its title-line right) — the footer subtitle must NOT repeat the EID; it falls **through to the trace id**. This is the `preferTraceIdSubtitle` option on `resolveQueueRowPresentation` (set by the group-anchor branch of `buildProjectionFromQueueSurface`). A **flat single** keeps the EID (its footer is the only place the EID appears). A `file` / `catalog` anchor already yields the trace id, so the flag is a no-op there. A one-member `alwaysBatchDelegatedMembers` batch (oath-signature / person-lookup fan-out) has no parent row, so the anchor falls back to `members[0]` — the subtitle is still the trace id, never blank.

## Trace id (trace / span model)

`data.__traceId` (`src/domain/queue-trace-id.ts`): `<code>-<HHMMSS>-<runId4>`, e.g. `ou-143012-a3f1`. `code` is the **root operation's** 2-char code; `HHMMSS` is local run-start time (date omitted — tracker files are date-partitioned); `runId4` is the first 4 alphanumerics of the run id (log-greppable). Built by `buildTraceId(...)`, **frozen once** at the first pre-emit (read back via `findFrozenTraceId`), and rides every row.

**One operation = one shared prefix; one row = one own tail.** The `<code>-<HHMMSS>` **prefix** is the operation's *trace* — it propagates from the root to every descendant (via `rootTracePrefix` on `__runtimeOptions`; see `references/delegation-and-fanout.md` §6). Each row composes that inherited prefix with its **own** `runId4` *span* tail (`buildTraceId({ …, rootPrefix })` → `<rootPrefix>-<ownRunId4>`). So every row of one fan-out reads `ou-090553-<its own tail>` — visibly one operation, each still individually greppable to its own logs. A physical root (no inherited prefix) composes its own full id. No session-local ordinals in titles — disambiguation is the shared trace + the footer's time + `#run`.

## `runtimePolicy` knobs that touch rows

Spread `DEFAULT_WORKFLOW_RUNTIME_POLICY` and override only what differs:

- `delegation` — `failedChildBlocksParent`, `rootRowPersistsThroughChildren`, `alwaysBatchDelegatedMembers` (force even a lone fanned-out member to render as a one-member batch, e.g. oath-signature signers), `alwaysBatchInputRun` (force even a single-item direct input run to a one-member batch, e.g. a lone manual oath-signature EID).
- `preview` — approval affordances: `rowTypeLabelSuffix` ("Preview"), `alwaysAvailable`.
- `memberRow` — final batch-member title rule: `titleSource: "person" | "default"`.
- `prepRow` — file prep-row (OCR) title/subtitle source, e.g. `titleSource: "pdf-original-name"`.

> Batching is a **surface** decision via these `delegation` flags, never via `archetype` (which stays the invariant per-row shape) — see `references/pitfalls.md` for the failure mode when the two are confused.

## `statusExtensions` (the status axis)

Orthogonal to kind. Lets a workflow promote a row to a workflow-specific derived display status (person-lookup `notFound`, OCR `needsReview`) and/or render a supplemental status chip (person-lookup A/IA tag) without teaching the generic dashboard component to branch on `entry.workflow`. See `src/domain/queue-row-status.ts`.
