# 03 — Tracker/Event Layer + Dashboard Contract (span rebuild)

Status: **revised 2026-07-22 after the whole-plan/legacy-code review.** The span rebuild now also
owns a closed control-command protocol, durable notifications, strict boundary schemas, and an
explicit backup/restore contract for the non-rebuildable SQLite state. **Amended 2026-07-25:** §9
carries the operator-ratified delegation and presentation decisions (row-model series D6–D20).

## Ownership (D1)

| | Concept | Where |
|---|---|---|
| **This doc OWNS** | Span/event wire schema (§1, amended per D10), notes, storage layout, SQLite authority and recovery, enqueue/action/queue command semantics, durable notifications, local artifact outboxes/projectors, SSE wire shapes, the lift adapter + flip plan, the completion union, the ratified delegation/presentation decisions | §§1–5, §9 |
| **Imports from doc 01** | Task contract + `defineTask`, task id grammar (`<system>/<verb-object>` slash ids, per D2), the closed `SystemId` union — real `src/systems/` dir names (`new-kronos`, `old-kronos`) plus the D4 service systems (`extraction`, `normalization`, `ocr`, `roster` — charter §11), error taxonomy | referenced, never redefined |
| **Imports from doc 02** | Workflow descriptor shape + builder, RunEnvelope (`dryRun` home per D6), run-state machine incl. gates/parks (D5), checkpoint store schema, the readable span-path id grammar (`pl-104233-9f3e/searching#2`) | referenced, never redefined |
| **Exports doc 02 adopts** | Verdict/detail semantics, completion program semantics, and wire projections; doc 02's descriptor now carries every consumed field | §3–4 |
| **Imports from doc 12** | `FailureRecord`, evidence receipts/bundles, semantic action targets, scenario ids, knowledge/fix references | referenced, never redefined |

---

## 0. What exists today (and what specifically hurts)

| Today | Mechanism | Pain |
|---|---|---|
| Queue rows | `TrackerEntry` snapshots, latest-wins dedupe, `data: Record<string,string>` bag | Every emit must re-stamp `archetype`/`__traceId`/`parentRunId`/`mode`/… or the latest row *eats* them (≥6 CLAUDE.md lessons are re-stamp bugs: ISS-006, E2E-016, the 2026-06-02 parentRunId lesson, the sweep-step lesson…) |
| Steps/timeline | `step` string on rows + `computeStepDurations` reconstruction + `step_change` session events | Three sources of "where is the run"; durations are *reconstructed*, not recorded; cancelled runs need a sentinel step (`failed`+`step="cancelled"`) that every classifier must special-case |
| Session cards | `sessions/<date>.jsonl` events keyed by mutable `workflowInstance` names + pid heuristics | The 2026-06-25 triple-root-cause dedup saga: instance names are reusable, so attribution needs pid + time-window hacks |
| Status | 5 base statuses + sentinel steps + per-workflow `statusExtensions` + OCR-only predicates (`isPrepareRow` keys on `workflow === "ocr"`) | Status semantics smeared across row fields, sentinels, extensions, and hardcoded branches |
| Approve fan-out | 3 divergent spec shapes (`approveTo`/`approveDocumentTo`/`completeDelegatedRun`) + string-keyed intent gate (`data.operationWorkflow`) + cross-spec borrowing (`onbase-emergency-contact.ts:82`) | Nothing forces coherence; a spec can declare contradictory shapes and only a doc comment objects |
| Dashboard | SSE `entries` (row-ish) + heavy client-side re-projection (queue-surface classifier duplicated client-side, `statusKeyForEntry`, `computeOcrPipelineView`, `workflow === "ocr"` at App.tsx:386/852/976, LogPanel.tsx:249, ocr/types.ts:142–211) | The client re-derives what the server already knows, and re-derivation drifts |

What is **good** and must be kept (charter: port, don't rewrite):
- The **three orthogonal axes** (shape / scope / kind) and the queue-surface collapse algorithm
  (`queue-surfaces.ts`) — battle-tested, including synthetic operation shells and
  `alwaysOperationDelegatedMembers`.
- **Backend-authoritative counts** (`wfCounts`) — the rail never trusts client math.
- Kind-dispatched **title/subtitle** (`queue-row-presentation.ts`) and the **trace id**
  (`<code>-<HHMMSS>-<runId4>`, frozen once).
- JSONL-per-day on disk — the operator greps files. (SQLite's role is split per D14: the
  claim/checkpoint tables are system-of-record; only the *projection* tables are rebuildable — §2.3.)
- Cross-midnight read-layer merge; append-at-now writes.
- The **`ocr_approvals` claim/lease/manifest durability machinery** (2026-07 hardening) — §4.4.

---

## 1. The span event model

### 1.1 Primitives

Everything observable is one append-only stream of **span events**. Three span kinds live in
`spans/` (worker / run / task) plus gate events; **per-action attribution rides the notes stream**
(D10) — an action is a note addressed to its owning task span, not a span of its own. This keeps
the span stream small enough to be the queue/timeline truth while preserving per-action drill-down.

```
worker ──┬─ browser / auth / idle …        (daemon process lifetime; replaces sessions/*)
         │
run ─────┬─ task                           (one descriptor step — doc 02's task chain)
         ├─ task …
         └─ gate events                    (parked-on-operator/system states, D5)
                └─ actions → notes stream  (click/fill/goto/ocr-page/… — addressed by spanPath)
```

```ts
// temp_src/events/types.ts — the wire/at-rest contract. ZERO imports (leaf module).

export type SpanKind = "worker" | "run" | "task";

export type RunOutcome =
  | "done" | "failed" | "cancelled" | "discarded" | "skipped" | "interrupted" | "superseded";
// cancelled / discarded / interrupted / superseded are FIRST-CLASS outcomes.
// The `failed + step:"cancelled"` sentinel family does not exist in temp_src —
// it is decoded exactly once, in the lift adapter (§5).

/**
 * Span identity = (runId, attempt, spanPath)  — D10.
 * spanPath uses doc 02's readable path grammar (imported, not redefined):
 *   run span:   pl-104233-9f3e
 *   task span:  pl-104233-9f3e/searching#2        (#N = in-run kernel retry attempt)
 *   worker span: worker/oath-signature/W-88112
 * "Opened and closed exactly once" holds PER (runId, attempt, spanPath): a reassigned or
 * re-pended execution of the same runId is a NEW attempt, so today's same-runId re-pend
 * (`returnTaskToQueued` → row-lifecycle "reassign", VL-004) is representable without violating
 * the invariant. In-run kernel retries are attempt-suffixed task spans; cross-run retries are a
 * NEW run with `retryOf`; the legacy `-N` display suffix stays display-only formatting.
 */
export interface SpanRef {
  runId: string;           // full UUID — SQLite/store join key
  attempt: number;         // 1-based execution attempt of this run
  spanPath: string;
  parentSpanPath?: string; // task→run, browser→worker
  traceId: string;         // frozen `<code>-<HHMMSS>-<runId4>`; root-prefix propagation unchanged
}

export type SpanEvent =
  | RunQueued | RunClaimed | RunRequeued | SpanStarted | SpanPatched
  | SubjectObserved | GateOpened | GateResolved | SpanEnded;

interface Base extends SpanRef {
  t: string;            // event type discriminant
  ts: string;           // ISO-8601
  workflow: string;     // descriptor id — partition key
  pid: number;
}

/** Run is born at ENQUEUE, not at claim. Carries the validated workflow-constant input or a
 * sensitive-input authority reference—exactly one, proven by `RunQueuedSchema`. */
interface RunQueuedBase extends Base {
  t: "run.queued";
  kind: "run";
  itemId: string;                  // stable business key (the completion program's deriveItemId, §4)
  parentRunId?: string;            // SCOPE axis — delegated iff present (unchanged semantics)
  shape: "single" | "preview" | "operation" | "operation-member";  // SHAPE axis, stamped ONCE
  subjectKind: "person" | "file" | "catalog";                      // KIND axis, derived from
                                                                   // descriptor.inputSubject, ONCE
  subject?: QueueSubjectWire;      // closed person/file/catalog union; display-safe fields only
  dryRun: boolean;                 // mirrored from the RunEnvelope (D6) for display
  displayOnly: boolean;            // task-less display row (§4.3, §5) — no claim will ever follow
  priority: "interactive" | "bulk"; // trusted server stamp; children inherit their root
  retryOf?: string;                // prior runId when this is a cross-run retry
  engine: "legacy" | "native";
  cutoverGeneration: number;
  descriptorVersion: number;
  contractFingerprint: Fingerprint;
  resolvedInstance: Partial<Record<BrowserSystemId, SystemInstance>>;
  configFingerprint: Fingerprint;
  configSnapshotId: ConfigSnapshotId;
}
export type RunQueued = RunQueuedBase & (
  | { input: JsonValue; sensitiveInputRef?: never }
  | { input?: never; sensitiveInputRef: SensitiveInputRef }
);

export interface RunClaimed extends Base { t: "run.claimed"; workerId: string; }
export interface RunRequeued extends Base {
  t: "run.requeued";
  cause: "reassign" | "bump" | "recovery";
  nextAttempt: number;             // the attempt the next claim will run as
}

/** Opens a worker/task span. Tasks reference the descriptor step key — labels live there. */
export interface SpanStarted extends Base {
  t: "span.started";
  kind: SpanKind;                  // "worker" | "task"
  name: string;                    // task: descriptor step key; worker: instance label
  system?: string;                 // SystemId (doc 01's closed union) for browser/worker spans
}

/**
 * Durable KV updates on the owning RUN (detail fields, resolved names, record snapshots).
 * Patch keys MUST be declared in the descriptor's `details` list (§3.3) — an undeclared key
 * throws at emit. Identity attrs can never ride a patch (§6 guard 4).
 */
export interface SpanPatched extends Base {
  t: "span.patched";
  updates: readonly [DetailUpdateWire, ...DetailUpdateWire[]];
}

/** Fresh subject observation. The raw identifier is retained only in the encrypted/local
 * authority record when required; this stream carries a redacted value + comparison outcome. */
export interface SubjectObserved extends Base {
  t: "subject.observed";
  taskId: TaskId;
  expected: SubjectEvidenceWire;
  observed: SubjectEvidenceWire;
  observationId: ObservationId;
  result: "match" | "mismatch" | "unknown";
}

/** A run parked on an operator/system decision (D5: gates are run-state, owned by doc 02;
 *  these events are their wire form). Replaces `running/awaiting-approval` + sentinel steps. */
export interface GateOpened extends Base { t: "gate.opened"; gate: string; }   // gate ids declared in descriptor
export interface GateResolved extends Base {
  t: "gate.resolved"; gate: string;
  /** Descriptor-validated display/audit key, never the gate's decision payload. */
  resolutionKey: GateResolutionKey;
  /** The schema-parsed gate result lives in authority/checkpoint storage (D67). */
  resultRef: GateResultRef;
  resultHash: Sha256;
}

export interface SpanEnded extends Base {
  t: "span.ended";
  outcome: RunOutcome;             // task spans use "done" | "failed" | "cancelled" | "skipped"
  failureId?: FailureId;           // full structured failure lives in doc 12's failure store
  errorSummary?: string;           // display-safe, legible summary; never the only failure evidence
  verdict?: VerdictKey;            // validated against the descriptor's closed tuple (§3.2)
  evidenceReceiptId?: EvidenceReceiptId;
}
```

The TypeScript declarations above are readable views, **not validation**. `SpanEventSchema`,
`NoteSchema`, every `*WireSchema`, and the SSE payload schemas are strict discriminated zod unions;
their inferred types are the implementation types. JSONL read, SQLite read/write, legacy lift,
HTTP input/output, SSE emission, and fixture load all parse at the boundary. Unknown keys, invalid
ISO instants, unbranded ids, non-canonical JSON, `NaN`, and invalid state combinations fail or enter
the explicit legacy quarantine—never get cast into the model.

**Notes** (high-volume annotations — log lines, screenshots, per-action records, data points) are a
parallel stream, not span events. Same `SpanRef` addressing, so a note attributes to its exact task
attempt:

```ts
export interface Note extends SpanRef {
  ts: string; workflow: string; pid: number;
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  fields?: readonly NoteFieldWire[];          // closed key/value union; no decision-bearing map
  /** Per-action attribution: task + semantic UI id + page-state transition, never a raw selector. */
  action?: UiActionEvidenceWire;
  attachment?: ScreenshotAttachmentWire | DataPointAttachmentWire | DiagnosticAttachmentWire;
}
```

Notes are evidence, not control state. A new structured field requires a union/schema extension.
High-cardinality exploratory metadata belongs in a schema-versioned diagnostic attachment. No
projector, command handler, retry policy, or workflow bind may branch on note prose or an untyped
attachment payload.

**Volume, honestly (review #8):** today the per-page OCR pipeline emits **zero** tracker rows —
its state rides ~8–12 deduped, 250ms-debounced row snapshots per run (`orchestrator.ts:671-692`).
A naive per-action *span* stream would multiply that by orders of magnitude. Under D10 the split
is: `spans/` carries run + task + gate events — roughly **10–40 events per run** (bounded by the
descriptor's step count × attempts, not by page/click counts) — and everything per-action
(per-page OCR calls, clicks, fills, screenshots) lands in `notes/` at roughly today's **log-line
volume** (hundreds per OCR run). Queue and timeline projections read spans only; notes load lazily
per selected run. Timeline *folds* read spans only; per-action drill-down reads notes by spanPath.

### 1.2 What each of today's surfaces becomes (all are projections)

| Surface | Today | Projection of |
|---|---|---|
| Queue row | latest TrackerEntry snapshot | run span: `run.queued` attrs (immutable identity) ⊕ folded `span.patched` ⊕ open gates ⊕ `span.ended` |
| Status badge | status + sentinel step + statusExtensions | run span state machine: queued→pending, claimed+open→running, open gate→gate status (e.g. `approval` open ⇒ needsReview), ended→outcome verbatim |
| Step pipeline | registered steps + `step` string + reconstructed durations | descriptor.steps ⊕ task spans (a task span IS the duration; a cancelled run's reached step = last open task span — no sentinel recovery) |
| Timeline / log panel | rows + logs + filtered session events (pid heuristics) | run span tree's notes ⊕ the owning worker span's lifecycle events selected **by `workerId`** (recorded at `run.claimed`) — the instance-name/pid/time-window attribution class of bugs is structurally dead |
| Session card | rebuildSessionState over instance-keyed events | worker span + its browser child spans (health notes ride the browser span); subtitle = the in-flight run's traceId (run.claimed links both ways) |
| wfCounts | countSidebarRowsFromTrackerHistory | same collapse algorithm over projected run surfaces — still computed server-side, still authoritative |
| Row-lifecycle debug | replay + cause *guessing* (`reassign` derivation) | free: `run.requeued.cause` + `attempt` are recorded, not derived |

### 1.3 Decision: archetypes survive as vocabulary, die as per-row stamps

The four row shapes (`single | preview | operation | operation-member`) and the three axes are
**kept** — they are the proven queue vocabulary. What changes:

- **Declared on the descriptor** (doc 02's `archetype`, literal or input-resolver), materialized
  **once** on `run.queued.shape`. Member shape is set by the fan-out dispatcher on the child's
  `run.queued` (today's `rowShape` option).
- **Never re-stamped.** Span identity attrs are written once and immutable; patches can't clobber
  them because projections fold `patch` over identity, not the reverse. The entire re-stamp bug
  class (ISS-006 etc.) is unrepresentable.
- No legacy normalization (`batch`→`operation`) in temp_src — that stays in the lift adapter (§5).

Derived statuses stop being per-workflow code where a universal mechanism exists:
- `needsReview` ⇒ any run with an open `approval` gate (universal projection rule; OCR just declares
  the gate).
- `notFound` / `inactive` / secondary tags ⇒ descriptor-declared **verdict mappings** (§3.2) over
  `span.ended.verdict` — plain data, bundle-safe, no `statusExtensions` function registry.

---

## 2. Storage and transport

### 2.1 On disk — JSONL-per-day stays, two streams

```
.tracker/
├── spans/   <workflow>-<date>.jsonl   span events (low volume — the queue/timeline truth)
├── notes/   <workflow>-<date>.jsonl   notes (high volume — logs, actions, screenshots, data points)
├── evidence/<runId>/                  run receipts + redacted diagnostic bundle manifests (doc 12)
├── artifacts/sha256/<prefix>/<hash>    content-addressed task outputs; atomic, immutable bytes
├── ledger/  <system>-<date>.jsonl     immutable write receipts (D21; shape owned by doc 09 §6) —
│                                      hash-chained (seq + prevHash), append-only, per-SYSTEM+day,
│                                      NEVER pruned (the audit floor)
├── rows/ logs/ sessions/ …            LEGACY dirs — untouched, still written by old src,
│                                      read via the lift adapter (§5) until deleted
├── backups/state/                     checksummed online backups + restore manifests (§2.5)
└── state.db                           SQLite — claims/checkpoints/intents/outboxes/ledger heads,
                                       commands/dependencies/notifications are system-of-record;
                                       read projections alone are rebuildable
```

Rationale against alternatives:
- **Why not SQLite-only?** The operator greps files. **Debug grep now spans two dirs:**
  `grep ou-1430 .tracker/spans/*.jsonl` answers *what happened* (state transitions, outcomes,
  gates); `grep ou-1430 .tracker/notes/*.jsonl` answers *what it did* (log lines, per-action
  records, screenshots). One trace id returns the whole operation tree across workflows in both.
  This second grep is a real cost of the D10 split and is documented as such — the `spans/` grep
  alone no longer contains log-line text the way `rows/`+`logs/` greps did.
- **Why split spans/notes?** Queue projection reads spans only (§1.1 volume note); notes load
  lazily per selected run. Mirrors today's proven rows/logs split.
- **Why a separate `ledger/` (D21 — owner = this doc)?** Doc 09's write-safety layer files one
  immutable receipt per real HR mutation. It is partitioned per-**system**+day so
  `grep 10694136 .tracker/ledger/ucpath-*.jsonl` answers "what did we file for this person, across
  time," hash-chained (`seq` + `prevHash`) for tamper-evidence, and **never pruned**. Doc 09 owns
  the entry *shape* (`LedgerEntry`, §6 there); this doc owns that the dir lives in the layout and is
  exempt from `clean-tracker`.
- **Base retention — DECIDED (D21):** `notes/` prune at **7 days** (the high-volume stream, matching
  today's `clean:tracker` default) and `spans/` at **30 days** (the audit skeleton, kept longer).
  `ledger/` is exempt from both — its never-pruned floor now sits **above a settled number, not a
  guess** (this is what doc 09 §6 references). `rows/`/`logs/`/`sessions/` keep their legacy policy
  until deletion.
- **Why per-workflow files?** Small greppable files; partition key matches the SSE topic scope.
  Worker spans write to their workflow's file (a daemon serves one workflow).
- **Span/note write discipline (ported):** append-at-now partitioning; cross-midnight solved at the
  read layer with the OPEN-span forward-merge (same algorithm as `cross-midnight.ts`); synchronous
  SIGINT terminal writes; `O_APPEND` single-line writes. **Ledger is different:** executors write
  durable outbox rows and one serialized projector assigns sequence/hash and appends (doc 09).
- **Local artifacts are not hidden task writes (D45).** A read task may create only immutable,
  content-addressed bytes under `artifacts/` through doc 01's writer; the returned `{id,sha256,bytes,
  mediaType}` is canonical JSON and checkpoints reference it without exposing a filesystem path.
  Mutable operator artifacts (for
  example i9's retention workbook) are different: the node checkpoint and a stable-keyed
  `artifact_outbox` row commit atomically in SQLite, then a single sink projector performs
  temp+fsync+atomic-replace and records the projected content hash. Duplicate outboxes/key retries
  are no-ops. A blocking projection failure parks the run; it never reports done while silently
  dropping the workbook update.
- **Evidence is indexed, not scattered.** `evidence/<runId>/receipt.json` points to immutable
  screenshots/artifacts/failures by content hash and records missing capture explicitly. Diagnostic
  bundles redact by schema before writing; they never copy `.env`, cookies, browser storage, raw
  SSNs, or unrestricted input blobs (doc 12 §3).

### 2.2 Projections are computed server-side — the wire carries surfaces, not rows

Today the client re-implements queue-surface classification, status keying, and pipeline math. In
temp_src the SSE stream carries **finished projections**; the client renders and never re-derives.
Descriptor metadata is served as doc 02's validated client projection; the SPA never imports
workflow modules. The SSE hello carries its fingerprint so a stale bundle fails loud.

```ts
// temp_src/server/topics.ts — SSE topic payloads (all change-gated snapshots, as today)
interface EventsHubPayload {
  descriptorHash: string;                  // doc 02's skew tripwire — NOT the descriptors themselves
  queue: { workflow: string; date: string; surfaces: QueueSurfaceWire[] };  // per subscribed panel
  queuePatch?: { workflow: string; date: string; surface: QueueSurfaceWire }[];
  //  ^ after the initial snapshot, a changed surface re-sends ONLY that complete strict surface — a
  //    100-member operation tick re-serializes one member row, never the resolved member tree (D10)
  wfCounts: readonly { workflow: WorkflowId; count: NonNegativeInt }[];
                                             // closed tuples, backend-authoritative rail badges
  sessions: WorkerCardWire[];              // worker-span projections
  notifications: NotificationWire[];       // incl. gate.opened rising edges (kills App.tsx:386)
  quarantine: { workflow: string; count: number }[];   // §5.1 — lifted-row quarantine is VISIBLE
}

interface QueueSurfaceWire {
  surface: "single" | "preview" | "operation";      // group collapse already applied server-side
  runId: string; itemId: string; workflow: string;
  traceId: string;                                   // review #11 — was missing
  parentRunId?: string;
  attempt: number;
  dryRun?: boolean;                                  // review #11 — RunEnvelope mirror (D6)
  enqueuedAt: string; startedAt?: string; endedAt?: string;   // review #11 — timestamps; queue-wait
                                                              // and elapsed derive from these
  title: string; subtitle?: string;                  // kind dispatch applied server-side
  status: StatusWire;                                // { key, label, tone, secondaryTag? } — final
  pipeline: { step: string; label: string; state: "pending"|"running"|"done"|"failed"|"cancelled"|"skipped"; durationMs?: number; attempt?: number }[];
  gates: { gate: string; open: boolean; resolutionKey?: GateResolutionKey }[];
  actions: ActionDescriptorWire[];                   // ported from the standard command projection;
                                                     // display-only rows get Hide only (§4.3)
  memberRunIds?: string[];                           // operation only — ids, NEVER nested trees (D10);
  memberRollup?: readonly { status: StatusKey; count: NonNegativeInt }[];
                                                     // closed status/count tuples for the mini-badge
  //  members are ordinary flat surfaces in the same queue payload (joined client-side by
  //  parentRunId); each is change-gated individually via queuePatch
  detailSurfaces: ("logs"|"screenshots"|"review"|"edit-data"|"view-data")[];  // capability-driven tabs
  links?: { review?: { workflow: string; runId: string } };  // "Open OCR review" jump
  evidence: { receiptId?: EvidenceReceiptId; failureId?: FailureId;
              confidence: "verified" | "partial" | "unknown" };
}
```

For a run parked on an unfinished write intent, the server replaces ordinary retry/done actions
with the closed kernel actions `resolve-write-present` and `resolve-write-absent` (doc 09 §4.1),
including intent generation+version tokens and the proof/evidence form spec. The descriptor cannot
re-enable generic Done/Retry for that state. These actions derive from durable intent state, not a
workflow-id registry; stale tokens fail with a conflict and trigger a fresh projection.

Per-run detail (timeline, notes, screenshots) stays request/response + a per-run SSE topic, as
today — but the payload is the span tree + notes, already merged and ordered; `LogStream` stops
owning merge/dedup heuristics (`mergeDisplayItems` collapse survives as a server-side fold).

### 2.3 SQLite (role per D14)

`state.db` has **two classes of table with different authority**:

- **System-of-record (NOT rebuildable and never deleted by projection/runtime row maintenance):**
  the task/claim store (tasks, leases,
  dependencies, delegation manifests, commands, notifications, capture sessions/photo order/
  finalization outboxes — doc 02 §5.7's checkpoint payloads,
  §4.4's `ocr_approvals` manifests, and
  doc 09's permanent-key `write_intents`, `write_attempts`, durable outbox, and `ledger_heads`, plus
  stable-keyed local `artifact_outbox`/sink-head rows). The system-of-record set is
  "claims + checkpoint payloads + write authority/outboxes/ledger tails + local artifact projection
  authority + in-progress capture/handoff authority."
  Losing any of these loses claims, checkpoints, in-flight write fences, or accepted capture work — they have no JSONL
  double.
- **Projection tables (rebuildable):** span-shaped read models (`spans`, `gates`, `notes`,
  `runs_view`) fed by one projector consuming both native spans and lifted legacy events (§5).
  These — and only these — can be deleted and rebuilt from JSONL, with today's operational rules:
  JSONL writes first, projection applies after, projection failures schedule guarded rebuilds and
  never block workflows; source identity is `resolve(path)`; deletion tombstones and offline
  compaction port as-is.

The system-of-record class includes a singleton `authority_meta(schema_version,
authority_generation,updated_at)`. The infra adapter exposes separate authority and projection
transaction APIs; repositories cannot execute arbitrary SQL or receive the raw connection. Every
top-level committed transaction that mutates at least one authority table increments
`authority_generation` exactly once inside that same transaction; projection-only rebuilds do not.
Nested authority operations share the outer transaction/generation increment. The table-class
registry generates coverage tests that mutate each authority repository and prove the generation
advances, then mutate each projection repository and prove it does not. A newly added authority
table without a registered mutator test fails. This makes D72 backup RPO comparison an actual
monotonic authority fact rather than a timestamp guess.

Any sentence in this doc that says "rebuildable" means the projection tables only. The sole
authority-removal exception is the explicit stopped-system, exact-id, backup-gated Purge procedure
in §2.4; ordinary cleanup, Hide, projection rebuild, and runtime code cannot reach authority rows.

### 2.4 One command protocol with strict target families

The dashboard, CLI, recovery code, workflow editor, notification inbox, gate resolvers, and capture
UI all issue the same idempotent command **envelope**, then one strict target-family arm (D67). They
do not update queue rows, JSONL, or authority records directly. Workflow descriptors select from
closed policies; workflows never own cancel/delete/retry/bump/update implementations.

```ts
export type EnqueuePolicy = "reject-active" | "supersede-active" | "allow-parallel";
export type CommandActionId =
  | "retry" | "cancel" | "bump" | "hide" | "unhide"
  | "edit-checkpoint" | "resolve-write-present" | "resolve-write-absent";
export type NavigationActionId = "open-review" | "open-evidence";
export type WorkflowActionId = CommandActionId | NavigationActionId;

export interface WorkflowActionPolicy {
  enabled: readonly WorkflowActionId[];
  /** Optional descriptor conditions are closed rules over projected state, not callbacks. */
  conditions?: readonly ActionConditionRule[];
}

interface CommandEnvelope {
  commandId: CommandId;                 // client-generated idempotency key
  requestedAt: IsoInstant;
  reason?: OperatorReason;
}
export type RunCommandRequest = CommandEnvelope & (
  | {
      target: { runId: RunId; expectedVersion: PositiveInt };
      type: "retry" | "cancel" | "bump" | "hide" | "unhide";
      payload?: never;
    }
  | { target: { runId: RunId; expectedVersion: PositiveInt };
      type: "edit-checkpoint"; payload: EditCheckpointCommand }
  | {
      target: { runId: RunId; expectedVersion: PositiveInt };
      type: "resolve-write-present" | "resolve-write-absent";
      payload: ResolveWriteCommand;
    });
export type GateCommandRequest = CommandEnvelope & {
  type: "resolve-gate";
  target: { runId: RunId; gateId: GateId; expectedVersion: PositiveInt };
  /** Generic only on the wire; the handler resolves the descriptor and parses the exact gate schema
   * before atomically storing the result checkpoint + resolved event outbox. */
  payload: { result: CanonicalJsonValue };
};
export type NotificationCommandRequest = CommandEnvelope & (
  | { type: "notification-read" | "notification-acknowledge" | "notification-resolve";
      target: { notificationId: NotificationId; expectedVersion: PositiveInt }; payload?: never }
  | { type: "notification-snooze";
      target: { notificationId: NotificationId; expectedVersion: PositiveInt };
      payload: { until: IsoInstant } }
);
export type CommandRequest =
  | RunCommandRequest | GateCommandRequest | NotificationCommandRequest | CaptureCommandRequest;
// CaptureCommandRequest is owned by doc 06 and uses this envelope's idempotency/CAS semantics.

/** Multi-select never means "loop and hope". Targets and versions are frozen at confirmation. */
export interface BulkCommandRequest {
  bulkCommandId: CommandId;
  type: "retry" | "cancel" | "bump" | "hide" | "unhide";
  targets: readonly [
    { runId: RunId; expectedVersion: PositiveInt },
    ...{ runId: RunId; expectedVersion: PositiveInt }[],
  ];
  mode: "all-or-none" | "best-effort";
  requestedAt: IsoInstant;
  reason?: OperatorReason;
}
export type CommandResult =
  | { state: "applied" | "already-applied"; commandId: CommandId; affectedRunIds: RunId[] }
  | { state: "conflict"; commandId: CommandId; currentVersion: PositiveInt; message: string }
  | { state: "rejected"; commandId: CommandId; code: CommandRejectionCode; message: string };

export type ActionDescriptorWire =
  | {
      kind: "command";
      id: CommandActionId;
      label: string;
      tone: "neutral" | "warning" | "destructive";
      target: { runId: RunId; expectedVersion: PositiveInt };
      form?: ActionFormWire;
    }
  | {
      kind: "navigation";
      id: NavigationActionId;
      label: string;
      tone: "neutral";
      target: { runId: RunId };
    };
```

Command semantics are binding:

| Operation | Standard behavior |
|---|---|
| Enqueue | Validate raw input once, derive stable item id, then apply descriptor policy in one transaction. `reject-active` returns the existing active run; `supersede-active` terminalizes the exact active generation and creates the new run atomically; `allow-parallel` still requires a distinct stable item/variant key. An authority read error aborts—never “continue and enqueue anyway.” |
| Retry | Creates a new run linked by `retryOf`, reuses immutable parsed input/config, validates checkpoints/freshness, and preserves the logical item. A parked unknown write uses resolution actions, never generic retry. |
| Cancel | Resolves the full dependency tree from authoritative SQLite, applies every edge's doc 02 cancel policy, and commits state transitions together. If the tree is unavailable/inconsistent, no target is cancelled. Visible queue roots are never an authority fallback. |
| Bump | Changes priority/claim order with CAS; it does not fabricate a requeue or mutate business input. Running work returns a typed rejection unless the scheduler explicitly supports cooperative yield. |
| Hide / Unhide | A reversible presentation tombstone only. It changes no run outcome, task, dependency, checkpoint, intent, or evidence. The UI label is **Hide**, never Delete. |
| Purge | Not a row action. `cli purge-run <exact-run-id> --backup <path>` is an offline maintenance command requiring a fresh verified backup and refusing any active/dependency/write-authority reference. It writes a purge receipt. |
| Edit checkpoint | Uses doc 06's field-level patch/provenance model, creates a new run/attempt as specified there, and never mutates original input or a completed proof. |

Every command is inserted durably before application and handled transactionally with the target's
monotonic `version`. Re-delivery returns `already-applied`; stale projections return `conflict` and
force refresh. The command audit records requester (`local-operator` for now), source surface,
reason, before/after versions, affected dependency ids, and outcome. API routes are thin schema
parsers over this service—there are no workflow-specific mutation endpoints except domain gates
whose handlers themselves issue commands.

Bulk commands first resolve the union of all authoritative dependency targets. `all-or-none` locks,
validates every expected version/policy, and applies one transaction or none. `best-effort` writes a
child command/result per requested target and returns the complete applied/conflict/rejected vector;
the UI may never collapse a partial result into “Done.” Bulk cancel defaults to `all-or-none`; bulk
hide defaults to `best-effort`. There is no client loop whose last response overwrites earlier errors.

### 2.5 Non-rebuildable SQLite recovery contract

Calling `state.db` authoritative without a recovery path would make a single corrupt file capable
of erasing claim, delegation, checkpoint, and write-fence truth. The base therefore includes:

1. SQLite runs with WAL, foreign keys on, a busy timeout, and `synchronous=FULL` for authority
   transactions. Schema migrations run only under an exclusive migration lease.
2. Boot runs `PRAGMA quick_check`, schema-version validation, foreign-key checks, and invariant
   queries (one active claim per run, manifest children match dependencies, every attempting write
   has an attempt, every outbox references authority, every finalizing capture has exactly one live
   bundle/handoff outbox, and every finalized capture references one intake handoff). Any failure starts the dashboard read-only
   and blocks enqueue/claim/commit/control commands with one durable/console-visible health error.
3. One infra-owned `AuthorityDatabase` retains the private native `DatabaseSync`; task/command/
   projection consumers receive only narrow repositories and never the raw handle. Its async,
   single-flight `backupToTemp` calls `node:sqlite.backup`—the rebuild does not inherit the current
   compatibility wrapper's erased backup capability and does not file-copy a live WAL database.
   After backup completes, verification opens the **backup itself** read-only, runs full integrity/
   foreign-key/invariant checks, and reads schema version/page count/`authority_generation` from
   that copy. Only those self-observed values enter the manifest with SHA-256/created-at; the service
   then fsyncs and atomically renames. A pre/post read of the live DB cannot label a different
   snapshot. `VACUUM INTO` and raw file-copy are not online-backup fallbacks (D72).
   Retain 14 verified daily backups, the latest 8 coalesced critical/interval backups, and the last
   5 pre-migration backups; expose age/health in
   Settings. A configurable path may point at another local volume.
4. A dirty authority store gets a coalesced verified online backup at least every 15 minutes and
   immediately after schema migration, external-write durable commit, capture final handoff, and
   graceful drain. Critical triggers may join one already-running backup, but cannot be silently
   dropped: if the completed copy's self-read generation predates a trigger's required generation,
   one coalesced follow-up backup is scheduled. Backup health reports both last verified time and
   the verified copy's authority generation/RPO gap.
5. `cli storage doctor` is read-only and reports checks, backup freshness, pending commands,
   unresolved writes, leases, outboxes, and restore candidates. `cli storage restore --from
   <exact-backup>` first preserves the suspect DB, restores into a temp path, repeats all checks,
   and atomically swaps only while workers/server are stopped.
6. Restore reconciliation replays JSONL into **projection tables only**. It never invents lost
   authority from spans. Runs/events newer than the restored authority generation are surfaced as
   `authority-unknown`; any possible external write is parked for doc 09's live probe/operator
   resolution before execution continues.

Phase 1 cannot exit until an automated restore drill copies a real-shaped fixture DB, corrupts the
copy, detects it, restores the newest verified backup, rebuilds projections, and proves pending
commands/delegations/write intents and capture handoffs remain consistent. Backups are useful
recovery state, so they
are excluded from ordinary tracker cleanup and covered by disk-space warnings.

### 2.6 Durable single-operator notifications

Desktop notifications are delivery conveniences, not the record. A `notifications` authority
table stores a strict event with `notificationId`, dedupe key, severity, run/workflow/failure refs,
created time, message template+arguments, state (`unread|read|acknowledged|snoozed|resolved`), and
delivery attempts. Triggers are closed and base-owned: run failure, subject mismatch, open operator
gate, unknown write outcome, quarantined legacy row, storage degradation, stalled lease/outbox, and
failed backup. Repeated identical triggers update count/lastSeen instead of spamming.

The dashboard inbox and per-run timeline always render durable state. OS notification delivery is
best-effort with retry/backoff and a recorded failure; a failed toast never loses the inbox item.
Acknowledging is distinct from resolving; snooze has an expiry; a resolved underlying condition
auto-resolves only notification types whose schema says so. Notification text uses redacted
arguments and links to the evidence/failure/run—not raw secrets or captured form contents.

```ts
export interface NotificationWire {
  notificationId: NotificationId;
  dedupeKey: NotificationDedupeKey;
  trigger: NotificationTrigger;
  severity: "info" | "warning" | "error" | "critical";
  state: "unread" | "read" | "acknowledged" | "snoozed" | "resolved";
  title: string;
  message: string;
  count: PositiveInt;
  createdAt: IsoInstant;
  lastSeenAt: IsoInstant;
  snoozedUntil?: IsoInstant;
  link?: { kind: "run" | "failure" | "storage"; id: string };
}
```

---

## 3. Descriptor fields this layer consumes (shape owned by doc 02)

**Doc 02 owns the `WorkflowDescriptor` shape and builder** (D1). This section does not define a
descriptor interface; it names the fields this layer *reads*, and the fields it *contributes* for
doc 02 to adopt. The tracker enforces its half at the emit boundary: **emitting a task span whose
`name` is not a descriptor step key, a gate not in the descriptor's gate list, a verdict not in its
verdict map, or a patch key not in its detail-field list, throws at emit time.**

### 3.1 Read from doc 02's descriptor
`id`, `code` (2-char trace prefix), `label`, `icon`, `category`, `surface.shape` /
`surface.resolveShape`,
`inputSubject`, graph-node keys/labels, `surfaces`, `details`, `actions`, `presets`, `identity`,
`presentation`, `coordinator`, `completionConsumes`, `artifactProjections`, `enqueue`, `scenarios`,
version/fingerprint, and
override layering. There is no second `archetype` declaration.

### 3.2 Contributed by this doc, adopted into doc 02's descriptor
These are plain-data fields; doc 02's descriptor carries them, this doc defines their semantics:

```ts
steps display rules: readonly StepDisplayRule[]               // computeOcrPipelineView's fold/hide
gates: readonly GateProjectionDefinition[]                    // descriptor-derived from gate nodes
verdicts: readonly VerdictDefinition[]
//  ^ REPLACES statusExtensions (review #5 / D1): person-lookup's `notFound` becomes
//    { key:"not-found", label:"Not found", tone:"warning" } over span.ended.verdict; the
//    identity-approval badge (§5.4) becomes a gate statusKey. The statusExtensions function
//    registry does not exist in temp_src.
details: readonly DetailProjectionSpec<Nodes>[]
//  ^ the SpanPatched validation set (review #11): every patch key must be declared here.
//    Successor of today's detailFields incl. the "declared but never populated" warn.
capabilities: WorkflowCapabilities
completion?: CompletionProgram                                // §4 — OCR-backed workflows only
enqueue / actions / scenarios / presets / identity / presentation / coordinator /
completionConsumes / artifactProjections
// artifact projection specs name an exact producing node+field, sink id, stable key fields,
// blocking policy, and canonical record schema; the client receives status only, never sink paths
```

The bundle-safe artifact spec is a closed infrastructure contract, not an arbitrary callback:

```ts
export type ArtifactSinkId = "xlsx-retention"; // extend with a sink implementation + guard fixture
export interface DurableArtifactProjectionSpec<RecordSchema extends z.ZodType> {
  id: string;
  source: { nodeId: string; fieldPath: string };
  record: CanonicalJsonSchema<RecordSchema>;
  keyFields: readonly [string, ...string[]];
  sink: ArtifactSinkId;
  blocking: true;
}
```

The builder factory receives the exact node accumulator and constrains `nodeId`, `fieldPath`, and
`keyFields` to real paths in that node's output/record schema; the broad wire form above is runtime
only. `blocking:false`, a free-form sink id, positional keys, and function-valued projectors are not
legal. Sink implementations live in one exhaustive `Record<ArtifactSinkId,Projector>` owned by
infrastructure—deliberately a sink-kind registry, never keyed by workflow.

Every hand-maintained parallel list in today's dashboard (icons, INSTANCE_LABELS, step-label
switches, stub map) becomes a projection of the descriptor set with a coverage guard — that
mechanism and its guard are doc 02's (§1.3/§1.4 there).

---

## 4. Unified completion contract (replaces approveTo / approveDocumentTo / completeDelegatedRun)

**Re-derived from `tracker/dashboard/ocr/approve.ts` + `prepare.ts` as-built (D11), not the OCR
happy path.** The as-built route is a *staged program with durable state*, and the contract must
express five things the previous draft missed: intent-derived child shape, `deriveItemId`, ordered
stages (per-document consumes per-record's *actually-enqueued* itemIds), oath-upload's
sibling-subscriber shape with NO coordinator, and i9's prepare-route enqueue + task-less
display-only failed rows.

### 4.1 The typed staged completion program

```ts
// temp_src/descriptor/completion.ts
import { z } from "zod/v4";
import type { AnyWorkflowRef } from "./ref.js";
// WorkflowRef<InputSchema,ResultSchema> carries both concrete schemas (docs 01/02).

export type CompletionProgram =
  | StagedFanOut<readonly [PerRecordStage<AnyWorkflowRef>, ...AnyFanOutStage[]]>
  | CompleteThenEnqueue<AnyWorkflowRef>;
// oath-upload deliberately has NO CompletionProgram — see §4.5 (sibling subscriber).
// verify deliberately has NO CompletionProgram — see §4.6 (in-run enrichment, not completion).

export interface StagedFanOut<Stages extends readonly [PerRecordStage<AnyWorkflowRef>, ...AnyFanOutStage[]]> {
  mode: "staged-fanout";
  gate: "approval";                          // the gate this program resolves
  /** ORDERED. Stage N+1's derive receives stage N's ACTUALLY-ENQUEUED itemIds — as-built:
   *  oath's per-document ticket gets `perRecordItemIds` = the ids the record stage really
   *  enqueued after `eligible` filtering (approve.ts:306, oath.ts:455), never the selected set. */
  stages: Stages;
}

export type AnyFanOutStage =
  | PerRecordStage<AnyWorkflowRef>
  | PerDocumentStage<AnyWorkflowRef>;

export interface PerRecordStage<Target extends AnyWorkflowRef> {
  per: "record";
  to: Target;
  derive: (record: PreviewRecord, ctx: ApproveContext) => z.input<Target["input"]>;
  /** As-built canFanOut: oath = signed + 5-digit EID (`hasOathSignerInput`); EC = EID-complete.
   *  Shared, named, exported predicates only (§4.2). Skipped records are NOT enqueued and their
   *  itemIds do NOT reach later stages. */
  eligible?: NamedPredicate;
  /** PreviewRecord carries a StableRecordId derived when extraction admits the record from
   * source-artifact digest + stable page/form identity. Item identity may use that id and validated
   * subject/business fields, never array index or run id. IDs are minted into the durable manifest
   * BEFORE dispatch. The enqueue-side resolver keys on the LOGICAL (runtime-options-stripped)
   * input and FAILS LOUD on a miss (buildFanOutItemIdResolver); the E2E-015 shared-id/index fallback
   * is banned. */
  deriveItemId: (record: PreviewRecord, ctx: ApproveContext) => ItemId;
}

export interface PerDocumentStage<Target extends AnyWorkflowRef> {
  per: "document";
  to: Target;
  derive: (doc: ApprovedDocument) => z.input<Target["input"]>; // gets prior enqueued ids
  deriveItemId: (doc: ApprovedDocument) => string;
}

export interface CompleteThenEnqueue<TTarget extends AnyWorkflowRef> {
  mode: "complete-then-enqueue";             // i9: no approval gate exists — nothing to approve
  then: {
    per: "person";
    to: TTarget;                             // concrete input schema retained end to end
    /** Runs at the PREPARE seam (as-built: /api/ocr/prepare after the delegated run completes,
     *  gated on the coordinator existing — prepare.ts:476-505), NOT at an approve route. */
    derive: (plan: MemberPlanEntry) => z.input<TTarget["input"]>;
    /** Pages that can never be searched become TASK-LESS display-only failed member rows
     *  (`run.queued { displayOnly: true }` + immediate `span.ended("failed")`; no run.claimed,
     *  no worker span, Hide-only actions) — as-built i9-check-results.ts displayFailures. */
    displayFailures: true;
  };
}
```

`defineCompletionProgram(...)` infers and returns the concrete heterogeneous stage tuple; workflow
descriptors are inferred values and are never annotated as broad `CompletionProgram`. A type-level
fixture renames a target input field and requires every `derive` site—including i9—to fail `tsc`.
Broad target erasure, untyped `derive` results, or exported erased stage arrays are forbidden.

### 4.2 Cross-spec borrowing becomes impossible

Today: `onbase-emergency-contact.ts:82` reaches into `emergencyContactOcrFormSpec.approveTo!.canFanOut`.
Two mechanisms close this:

1. **Predicates are first-class named exports in a shared home**, not properties fished out of
   another spec's config:

```ts
// temp_src/forms/shared/eligibility.ts
export const hasResolvedEid: NamedPredicate = definePredicate("has-resolved-eid",
  (r) => /^\d{5,}$/.test(normalizeUcpathEmployeeId(readEid(r))));
// onbase-ec and ec BOTH import hasResolvedEid. Neither imports the other's config.
```

2. **Specs are sealed at definition.** `defineFormSpec(...)` returns a branded opaque type whose
   completion config is not structurally reachable (`unique symbol` brand + no exported property
   types). `otherSpec.completion.stages[0].eligible` is a type error — the only composition
   surface is the shared-predicate module and explicit `extendFormSpec(base, overrides)` which
   re-validates the result. The architecture guard (§6) additionally bans importing one spec
   module from another spec module (registry + shared modules only).

### 4.3 Intent-derived child shape and stage consumption — declarative, coordinator-owned

As-built, TWO things are derived at approve time from the *launching intent*
(`data.operationWorkflow`, a string stamped on the OCR row at prepare):

- **Child shape** (approve.ts:236-239, recovery :882-884): fan-out children are stamped
  `operation-member` iff the intent is an operation coordinator (`oath-signature` /
  `emergency-contact` / `onbase` / `i9-check` — `ocr/shared.ts:25-34`). **oath-upload is
  deliberately NOT a coordinator** — its children keep the natural archetype, and the ticket is a
  real `single` task, not a display row.
- **Stage suppression** (approve.ts:224-227): the per-document stage is suppressed when the intent
  is `oath-signature` (signs only, no ticket) or `oath-upload` (the born-at-upload task files its
  own ticket).

In temp_src both move onto the **launching coordinator's descriptor**, resolved via
`parentRunId → run.queued.workflow` — no string-keyed `data` field:

```ts
// oath-signature descriptor:  completionConsumes: { memberShape: "operation-member", suppress: ["document"] }
// emergency-contact / onbase: completionConsumes: { memberShape: "operation-member" }
// oath-upload descriptor:     completionConsumes: { memberShape: "natural", suppress: ["document"] }
// i9-check descriptor:        completionConsumes: { memberShape: "operation-member" }   (used by §4.1's then)
```

A **display-only coordinator** (operation shape, no daemon task) declares
`coordinator: "display"` — its `run.queued` carries `displayOnly: true`, no `run.claimed` ever
follows, and completion is the members-terminal rollup (`rollupOperationStatus`, ported as a
projection rule). The as-built subtlety that dependency edges are simply *not created* when the
parent has no task (approve.ts:1389-1429) becomes structural: display coordinators are not in the
task store, and the dependency step of the program skips them by type, not by a missing-row probe.

Standalone approve stays rejected loud (approval ≡ delegation, ported rule — approve.ts:162-171).

### 4.4 Durability: the approval manifest is part of the contract's execution, ported as-is

The `ocr_approvals` machinery (2026-07 hardening) is transport-level idempotency and orthogonal to
the contract *shape* — it ports as-is, with its manifest now referencing span identity: stable
child `runIds` minted into the manifest before dispatch; claim/lease with heartbeat renewal;
conflict/stale/failed claim outcomes; a recovery path (`resumeRecoverableOcrApprovals`) that
re-dispatches **from SQLite alone** (never re-reads JSONL state that may be missing post-crash);
child-input schema validation *before* the claim is accepted (a bad derive is a durable failed
approval, not a stuck review); terminal presentation (`gate.resolved("approval","approved")` +
`span.ended("done")` with `fannedOutItemIds`) written only after the SQLite commit, so
presentation failure can never turn enqueued children into a failed approval. Dispatch failure →
`gate.resolved("approval","failed")` + `span.ended("failed")` (today's `approve-failed`), emitted
with inherited identity (ISS-006 rule, now structural — identity lives on `run.queued`).

### 4.5 oath-upload — owner-consumes via a sibling born-at-upload task (no coordinator)

**What cannot be expressed as a CompletionProgram is stated here explicitly rather than
mis-modeled (D11).** oath-upload has **no OCR form spec at all** (`forms/registry.ts:8-14` lists
oath/ec/onbase-ec/verify/i9 — oath-upload is a fan-out *target*, not a form). Its as-built shape
(`oath-upload/handler.ts:114-181`, prepare.ts:356-419):

- The real `single` ticket task is **born at upload** at the prepare seam, BEFORE OCR; the OCR run
  is delegated *under it* (`parentRunId` = the ticket run). If the born task cannot be created,
  prepare fails loud and aborts the OCR run (`ocr-prep-failed`) — OCR must never run with no
  consumer.
- The oath spec's per-record signer stage **still runs** at approve (the ticket's coordinator
  descriptor suppresses only the `document` stage, §4.3).
- The ticket task consumes the approval as a **sibling subscriber**: its `wait-approval` step
  (a gate in the new model, per D5) calls `subscribeToApproval({ workflow:"ocr", sessionId })` and
  learns the signer set from the approval payload's `fannedOutItemIds` — cross-process, JSONL/
  SQLite-backed, not an in-memory wake.
- Declared on the oath-upload descriptor as a gate wired to an approval subscription:
  `gates: [{ id:"await-approval", subscribes: { workflow:"ocr", key:"sessionId" } }, { id:"await-signatures", … }]`.
- The zero-signer refusal is an output-dependent branch to a typed failure node; discard is a gate
  resolution mapped to cancelled; signature waiting is a typed children-terminal gate; ticket fill
  and submit form a transaction node. The submit idempotency window is doc 09's write intent. None
  of these hides in a handler side channel.

### 4.6 verify — in-run enrichment, not completion

verify has **no completion contract**: no approve targets, no `completeDelegatedRun`. Its
fan-outs (`verify.ts:523-660`) happen during the run: doc 02 models two typed child-run branches in
a first-class parallel `all-settled` node, followed by a typed join/enrichment step. Child inputs,
results, cancellation, and joins are descriptor-visible and checkpointed. This doc still does not
model them as completion. i9 is §4.1's post-completion enqueue; verify is mid-run enrichment.

---

## 5. COEXISTENCE — the lift adapter and the flip plan

### 5.1 The seam: one direction, one place

**Decision: a read-side lift adapter in the new server — legacy events are lifted into span form;
there is exactly one projection pipeline.** Rejected alternatives (unchanged): dual projection
paths (two codebases in visual parity for months), dual-write from old src (destabilizes it),
down-emit shim (unneeded once the scoped flip lands first).

```ts
// temp_src/tracker/compat/lift-legacy.ts — PURE, deleted at end of migration.
// Reads legacy state via the OLD validators (imported from src/tracker — the one sanctioned
// old→new import, quarantined to this module) and lifts each legacy run into spans.
export function liftLegacyRun(
  schemaVersion: LegacyEmitSchemaVersion,
  entries: TrackerEntry[], logs: LogEntry[], sessions: SessionEvent[],
): LiftResult;
// LiftResult = { spans: SpanEvent[]; notes: Note[] } | { quarantined: QuarantinedRow }
```

Legacy emit shapes are **versioned, not frozen**. Central legacy emitters stamp one reviewed
`LegacyEmitSchemaVersion` covering row/log/session channels; records predating the field are explicit
`v0`. The lifter dispatches through a closed version→adapter map. A guard snapshots the legacy wire
schemas: changing a source schema without bumping the version, adding its adapter, and adding
old+new golden fixtures fails CI. Production `src` can therefore receive necessary fixes during the
multi-quarter migration without silently changing the meaning of already-stored rows.

**Lift inputs come from the visible-entries layer, never raw files (review #9):** the lifter reads
through `readVisibleEntries*` / the tombstone-filtered SQLite views (`deletions/visible.ts`), so an
operator-deleted run stays deleted — raw-file reads would resurrect it. Session-event lifting
applies the same tombstone filter.

**Lift policy is quarantine, NEVER throw (D12) — for invalid rows.** A row the lifter cannot
classify — an invalid `data.archetype` (which
`resolveRowArchetype` throws on today, `row-archetype.ts:96-99`; the lifter catches at the row
boundary) or an unknown status/step combination — produces a
`quarantined` diagnostic: a loud queue card carrying a schema-redacted excerpt + reason, a warn
note, and a
count on the SSE hub (`quarantine` topic, §2.2). One bad row degrades to a visible quarantine card; it can never take down
the projection read path for every workflow, which a throw would.

### 5.2 The mapping — enumerated from the kernel terminal contract (D12)

Re-derived from `tracked-workflow.ts` / `jsonl-core.ts` / the route emitters — not the OCR happy
path. Legacy statuses are `pending | running | done | failed | skipped`; everything else is step
sentinels and read-time reclassification. The lift decodes each exactly once:

| Legacy state (source) | Lifted form |
|---|---|
| `pending` row (pre-emit) | `run.queued` — shape via `resolveRowArchetype` incl. `batch`→`operation` normalization (legacy normalization lives HERE ONLY); identity attrs from the pending row's data |
| first `running` row / step transitions | `run.claimed` + `span.started(task)` per step change; `attempt` starts at 1 |
| same-runId re-pend after progress (`returnTaskToQueued` — row-lifecycle "reassign", VL-004) | `run.requeued(cause:"reassign", nextAttempt: n+1)`; the next running row opens attempt n+1 task spans — span identity `(runId, attempt, spanPath)` keeps "once per attempt" true (review #10) |
| re-pend under a NEW runId | new run with `retryOf` = prior runId |
| `running` with pseudo-step `` `<step>:failed:<err>` `` (`tracked-workflow.ts:365-370`) | NOT a step named that string: parsed at the first `:failed:` → `span.ended(task <step>, "failed", error)`; the run stays open until its terminal row |
| plain `done`, no step (`:420` — the MOST COMMON terminal) | `span.ended(run, "done")` |
| `done` + `step="approved"` (+ `fannedOutItemIds`) | `gate.resolved("approval","approved")` + `span.ended(run,"done")` |
| `done` + `data.eidApproval="pending"` (identity-approval pause, `domain/identity-approval.ts:12-40`) | **NOT a completed run**: `gate.opened("identity-approval")`, run stays open/parked — the legacy `done` here is a browser-release artifact, and lifting it as done loses an operator gate (review #10). `"dismissed"` → `gate.resolved("identity-approval","dismissed")` + `span.ended(run,"done", verdict:"dismissed")`; an approve re-queue is a new run (`retryOf`) that resolves the gate `"approved"` |
| `failed` + real step (`:493`) | `span.ended(run,"failed", error)`; reached step = the step (already closed failed by the pseudo-step row above) |
| `failed` + `step="cancelled"` / `"discarded"` (cancel sentinels, ISS-007) | `span.ended(run,"cancelled")` / `span.ended(run,"discarded")` — sentinel decoded at the seam |
| `failed` + `step="superseded"` (re-upload, `ocr/prepare.ts:309-332`) | `span.ended(run,"superseded")` — first-class outcome |
| `failed` + `step="approve-failed"` (approve dispatch failure) | `gate.resolved("approval","failed")` + `span.ended(run,"failed", error)` |
| `failed` + `step="ocr-prep-failed"` (oath-upload born-task failure, `prepare.ts:392-417`) | `span.ended(run,"failed", error)` |
| `skipped` row (`:377-380` — a per-STEP marker, not a run terminal) | `span.ended(task <step>, "skipped")`; the run continues |
| older non-terminal run + a newer run for the same itemId (read-time reclassification, `jsonl-core.ts:447-503`) | `span.ended(run,"interrupted")` — mirrored EXACTLY: only `pending`/`running` reclassify, only non-newest runs; reached step preserved (`step ?? "interrupted"`), no fabricated duration |
| SIGINT synchronous terminal (`failed`, lastStep, archetype re-stamp) | `span.ended(run,"failed"|"interrupted")` per the message; identity still from the pending row |
| `running` + `step="awaiting-approval"` **with** `parentRunId` (delegated OCR, `prep-rows.ts:29-41`) | `gate.opened("approval")`, statusKey `needsReview` |
| `running` + `step="awaiting-approval"` **without** `parentRunId` (standalone OCR — review #10) | `gate.opened("approval")` STILL opens (the run IS parked on the operator); only the projected status key differs (`in-review`, mirroring today's delegated-only `needsReview` scoping) — the gate is keyed on row state, not on delegation |
| `running` + `step="wait-approval"` / `"wait-signatures"` (oath-upload waits) | `gate.opened("await-approval")` / `gate.opened("await-signatures")` (§4.5 gates) |
| operation coordinator rows (display-only, stamped at prepare) & i9 `data.displayOnly==="true"` members | `run.queued { displayOnly: true }` (+ `span.ended` for the failed members) — **NO fabricated `run.claimed`, NO worker span** (review #9); actions project Hide only |
| session events | worker/browser spans keyed by (instance, pid) — the pid heuristics live here and ONLY here |
| data diffs on re-emits | `span.patched` (identity keys excluded — a legacy re-stamp folds into details, never identity) |
| anything else — invalid archetype or unknown status/step | **quarantine (§5.1), never throw, never a silent default** |

**Pinned by versioned real-tracker fixtures (D12):** a test corpus of copied real `.tracker`
days for every supported legacy schema version (plus seeded operation/preview/cross-midnight fixtures) replays through the lift asserting
**zero quarantines** and asserting the invariants above (every attempt's spans open/close exactly
once; no claimed/worker spans on display-only rows; tombstoned runs absent). An unstamped/unregistered
shape is quarantined visibly; the source-schema/version guard is what prevents shipping one knowingly.

### 5.3 Source authority — immutable per run

Every enqueue stamps `(engine:"legacy"|"native", cutoverGeneration)` in the authoritative run
record; the lift assigns the registered legacy generation to already-running tasks. All later
events inherit authority by `runId`, never by timestamp. Starting generation N+1 routes new runs
to native while the enumerated generation-N legacy run set drains normally. A duplicate event for
one run from the wrong engine quarantines; a legitimate late legacy terminal does not.

Cutover is transactional: increment generation, atomically switch enqueue routing, record the
legacy drain set, and reject new legacy enqueues. Rollback creates another generation; it never
rewrites an existing run. Cross-generation delegation still joins by runId/parentRunId/traceId.

### 5.4 The flip is SCOPED (D13), then per-workflow migration

Review #7 sized the wholesale flip honestly: ~103 endpoints across 23 route files, ~122
components, 5 SSE topics, 5 hard derived-state clusters — an unacceptable pre-Phase-2
mega-milestone that also strains "old system keeps working". So the flip covers the **four parity
surfaces only**:

1. **Phase 1:** build `temp_src/events` + projections + SQLite projector + new SSE server + lift
   adapter + the replay fixture (§5.2). All workflows are legacy; the new server renders
   everything via lift.
2. **Parity gate — queue rows + log panel/timeline + session cards + wfCounts, nothing more:**
   golden-payload tests serve the same fixture tracker dirs (including the real-day corpus)
   from both servers; those four surfaces are diffed field-by-field. The e2e stub lane
   (`HRAUTO_E2E_STUBS`) runs against the new dashboard.
3. **Flip:** `npm run dashboard` boots the new server + new SPA **for the four surfaces**.
   Everything else — **Capture, the Workflow Modifier, Settings, the AI-assist endpoints** (and
   the rest of the ~103-endpoint long tail: exports, screenshot/blob serving…) — is
   **proxied/re-mounted onto the old route handlers** inside the new server, each with its own
   later migration milestone. **Exception — OCR's review/approve mutation routes are NOT in the
   proxied long tail:** they are part of the OCR workflow's own scoped-flip surface set and
   migrate *with* the OCR workflow at master-plan order 3–4 (§5.3 / Phase 2+ per-workflow
   migration), exercising the native completion union + approval gates — not left proxied to the
   old `/api/ocr/approve-batch`. The old SPA stays runnable for one week **against a compatibility
   API projected from the unified native/lifted read model**. It does not read legacy files directly,
   so native runs remain visible during rollback. No native event is down-written to legacy storage.
4. **Phase 2+ (per-workflow migration):** each cutover increments the workflow generation; new
   runs switch to native spans while the registered legacy drain set continues through the lift. The dashboard cannot tell the
   difference — that is the definition of the seam holding.
5. **Deletion:** when the last workflow migrates, delete `lift-legacy.ts`, the legacy validators
   it imported, and the `rows|logs|sessions` readers; when the last proxied surface migrates,
   delete the old route handlers. A ratchet guard fails if `compat/` survives with zero legacy
   workflows registered.

**Honest milestone estimate:** the scoped flip is still the largest single pre-Phase-2 item —
the four surfaces are exactly the five-cluster derived-state core (queue collapse, status keying,
pipeline math, session attribution, counts) — but it is bounded by the lift mapping table (§5.2)
plus four wire shapes, not by 122 components; the proxied long tail migrates per-surface behind
its own milestones with no parity deadline coupling.

---

## 6. Adversarial self-review — how this rots, and the guard for each

| # | Rot vector | Mechanical guard |
|---|---|---|
| 1 | Per-component status/icon/label maps reappear (a new `STATUS_CONFIG` branching on workflow) | Architecture test: `temp_src/dashboard` components may not contain `workflow ===` comparisons or workflow-id string literals (allowlist: the registry plumbing file only) |
| 2 | Client-side re-projection creeps back (someone recomputes status from spans in React) | Raw `SpanEvent`/`Note` types are not exported from the client lib; the SPA's server-types module exposes only `*Wire` types. Import-boundary guard fails on `temp_src/events/types` imported under `dashboard/` |
| 3 | Silent projection fallbacks (`?? "running"`, catch→default) violating fail-loud | The existing `fail-loud-catch-default` + `nullish-literal-data-fallback` ratchets extended to `temp_src/` from day one (charter: same quality umbrella). Projection code has zero allowlist entries |
| 4 | Re-stamp culture returns via `span.patched` clobbering identity | Projector folds patches into a `details` namespace only; identity attrs (`shape`, `subjectKind`, `parentRunId`, `traceId`, `itemId`) are read exclusively from `run.queued`. A patch carrying an identity key OR an undeclared detail key **throws at emit**. Unit-pinned |
| 5 | Undeclared vocabulary (ad-hoc gate names, step keys, verdicts, patch keys) | Emit-time validation against the descriptor (task name ∈ steps, gate ∈ gates, verdict ∈ verdicts, patch key ∈ details) — throws. Coverage test walks every descriptor and asserts the sets are non-empty where capabilities require them |
| 6 | Double-source counting during migration | per-run engine/generation authority; wrong-engine events for one run quarantine, while authorized legacy drain events remain valid |
| 7 | Open spans leak on crash and show "running" forever | Projection derives `interrupted` for an open run span whose worker pid is dead AND a newer run for the same itemId started (mirrors `readRunsForId` exactly — pending/running only, non-newest only); worker liveness rides SQLite heartbeats as today. No fabricated durations |
| 8 | The completion union grows a fourth ad-hoc arm as an object literal side-channel | Programs constructible only via `defineFormSpec` (sealed brand, §4.2); spec-to-spec imports banned by guard; `extendFormSpec` is the sole composition path and re-validates. The two declared non-arms (oath-upload, verify — §4.5/§4.6) are pinned by tests asserting they have NO CompletionProgram |
| 9 | The lift adapter becomes load-bearing forever | ratchet fails when no workflow has legacy-authorized generations but compat remains; reverse check requires lift coverage for every legacy generation |
| 10 | Notes stream abused as a data channel (parsing log text for state — today's forbidden pattern) | Notes are render-only in projections; any projection reading `note.message` content (vs. structured `fields`/`action`) fails a grep guard. Data that drives state must be a span event |
| 11 | Quarantine becomes a silent bit-bucket (rows rot there unnoticed) | Quarantine is a VISIBLE queue card + SSE `quarantine` count + notification; the real-day replay fixture asserts **zero** quarantines on known-good days, so any new legacy shape fails CI when its day joins the corpus |
| 12 | Resolved member trees creep back onto the wire (the 5-8k-field re-serialization) | `QueueSurfaceWire` has `memberRunIds: string[]` only — no recursive member field exists to populate; a type-level test pins that the wire type is non-recursive; the SSE tick test asserts a 100-member operation patch serializes one surface |
| 13 | Attempt discipline erodes (a re-pend reuses attempt 1 and re-opens closed spans) | The replay fixture asserts open/close-once per `(runId, attempt, spanPath)` across days containing real reassign/bump traffic; `run.requeued.nextAttempt` is emit-validated as monotonic |
| 14 | The `ledger/` dir gets pruned, or `write_intents` treated as a rebuildable projection (D21) | `ledger/` is exempt from `clean-tracker` (a retention-floor ratchet — owned by doc 09 §8 — fails if any prune path reaches it); `write_intents` is enumerated in §2.3's system-of-record set (amends D14), so the "rebuildable ⇒ projection tables only" rule (§2.3) keeps it undeletable. Base retention (`notes/` 7d, `spans/` 30d) is a fixed §2.1 decision, so the never-pruned floor sits above a settled number, not a guess |
| 15 | Cancel/deletion targets fall back to whatever roots the caller can currently see | command integration tests make SQLite authority unavailable/inconsistent and assert zero transitions; source scan bans caller-supplied root fallback in target resolution |
| 16 | Two active runs appear because active-run lookup failed and enqueue continued | transactional enqueue-policy tests inject lookup/constraint failures; every result is reject/no-op/one new generation, never two active generations |
| 17 | A dashboard retry races a newer state and mutates the wrong attempt | every action carries `expectedVersion`; concurrency tests prove one applies and the loser gets a typed conflict |
| 18 | `state.db` corrupts and the app silently starts an empty authority store | boot corruption fixture must enter read-only degraded mode; restore-drill test proves a checksummed backup restores commands, dependencies, checkpoints, and write intents before claims resume |
| 19 | OS notification fails, so a critical unknown write is invisible | notification trigger and durable inbox commit in the authority transaction; delivery failure is recorded/retried and the unread inbox assertion remains true |

---

## 7. Worked example — operation coordinator flow, end to end in spans

Operator uploads `Oath_Packet.pdf` targeting oath-signature (dry-run off, 2 signers on the paper).
Span ids shown in doc 02's path grammar; `attempt` omitted where 1.

```jsonc
// Abridged for readability. Checked fixtures are generated through RunQueuedSchema and include
// every required Base/engine/config field; these snippets are not accepted as standalone events.
// spans/oath-signature-2026-07-17.jsonl        (coordinator — operation shape, file kind)
{"t":"run.queued","workflow":"oath-signature","runId":"R-op","spanPath":"os-141002-9f3e",
 "traceId":"os-141002-9f3e","itemId":"op-9f3e","shape":"operation","subjectKind":"file",
 "displayOnly":true,"input":{"pdfFileId":"F1","pdfOriginalName":"Oath_Packet.pdf"},"pid":88}
// display coordinator: NO run.claimed ever — it completes by member rollup (projection rule)

// spans/ocr-2026-07-17.jsonl                   (delegated OCR run under the coordinator)
{"t":"run.queued","workflow":"ocr","runId":"R-ocr","spanPath":"os-141002-11ab",
 "traceId":"os-141002-11ab","parentRunId":"R-op","itemId":"ocr-9f3e","shape":"preview",
 "subjectKind":"file","input":{"formType":"oath","pdfFileId":"F1"}}
{"t":"run.claimed","runId":"R-ocr","spanPath":"os-141002-11ab","workerId":"W-dash"}
{"t":"span.started","kind":"task","name":"render-pages","spanPath":"os-141002-11ab/render-pages#1"}
{"t":"span.ended","spanPath":"os-141002-11ab/render-pages#1","outcome":"done"}
{"t":"span.started","kind":"task","name":"ocr","spanPath":"os-141002-11ab/ocr#1"}
// per-page provider calls are NOTES (D10), not spans — notes/ocr-2026-07-17.jsonl:
//   {"spanPath":"os-141002-11ab/ocr#1","level":"step","message":"page 1 … 1 record",
//    "action":{"task":"ocr/extract-page","type":"ocr"},
//    "fields":[{"key":"page","value":"1"},{"key":"tier","value":"1"}]}
{"t":"span.ended","spanPath":"os-141002-11ab/ocr#1","outcome":"done"}
{"t":"span.started","kind":"task","name":"person-lookup","spanPath":"os-141002-11ab/person-lookup#1"}
{"t":"span.patched","spanPath":"os-141002-11ab","updates":[{"key":"records","value":[/* preview records v2 */]}]}
{"t":"span.ended","spanPath":"os-141002-11ab/person-lookup#1","outcome":"done"}
{"t":"gate.opened","spanPath":"os-141002-11ab","gate":"approval"}   // parked — NOT a fake "running" step
```

**Queue render now** (all server-projected): OCR panel shows one `preview` surface — title
`Oath_Packet.pdf` (file-kind dispatch), status `needsReview` (open approval gate → descriptor
`gates[approval].statusKey`), pipeline chips render-pages ✓ / ocr ✓ / person-lookup ✓ with real
span durations, Review tab present. oath-signature panel shows the `operation` surface for `R-op`
with `gates:[{gate:"approval",open:true}]` mirrored from its delegated child (projection join over
`parentRunId` — no denormalized `data.ocrStatus` copy to keep fresh) and the `links.review` jump.
The rail badge counts one surface per panel — same collapse algorithm, computed once, server-side.

Operator approves 2 records. The approve engine runs oath's `StagedFanOut` (record stage →
document stage); the launching coordinator is plain oath-signature, whose `completionConsumes`
suppresses `document` (§4.3), so only the record stage dispatches — with stable itemIds/runIds
from the durable manifest (§4.4):

```jsonc
{"t":"gate.resolved","spanPath":"os-141002-11ab","gate":"approval",
 "resolutionKey":"approved","resultRef":"gate-result:R-ocr:approval","resultHash":"sha256:…"}
{"t":"span.ended","spanPath":"os-141002-11ab","outcome":"done"}

// spans/oath-signature-2026-07-17.jsonl        (member fan-out — children of the COORDINATOR)
{"t":"run.queued","workflow":"oath-signature","runId":"R-m1","spanPath":"os-141002-c001",
 "traceId":"os-141002-c001","parentRunId":"R-op","itemId":"ocr-oath-rec-7b12a9",
 "shape":"operation-member","subjectKind":"person","input":{"employeeId":"12345678","name":"Lopez, Maria"}}
{"t":"run.queued","workflow":"oath-signature","runId":"R-m2", /* … rec-c84d31 … */}
{"t":"run.claimed","runId":"R-m1","spanPath":"os-141002-c001","workerId":"W-oath-1"}
{"t":"span.started","kind":"task","name":"navigation","spanPath":"os-141002-c001/navigation#1"} 
{"t":"span.ended","spanPath":"os-141002-c001","outcome":"done"}
{"t":"span.ended","spanPath":"os-141002-c9b2","outcome":"cancelled"}   // operator cancelled — a real outcome
```

**Queue render after:** the operation surface's members render inline (flat member surfaces
joined by `parentRunId`; the operation row itself carries only `memberRunIds` + `memberRollup` —
1 done · 1 cancelled, cancelled a first-class bucket, no `step==="cancelled"` decoding anywhere).
The coordinator completes to `done` when all members are terminal (`rollupOperationStatus` ported
into the projection). The coordinator's timeline shows its own notes ⊕ each member's
`run.claimed`/`span.ended` boundary events (selected by `parentRunId` — structurally, not via the
memberRunIds SQL widening workaround). Grep debug: `grep os-141002 .tracker/spans/*.jsonl` returns
the operation's state history across all three files; `grep os-141002 .tracker/notes/*.jsonl`
returns its log/action detail (§2.1 — two greps, by design).

---

## 8. Settled design questions and one volume monitor

1. **Notes retention & volume — RESOLVED (D21), no longer open.** Base retention is **decided**
   (§2.1): `notes/` prune at **7 days** (today's `clean:tracker` default — the high-volume stream
   that now also carries per-action records, D10), `spans/` at **30 days** (the audit skeleton). The
   `ledger/` dir is **never pruned** and sits above both floors (doc 09 §6 depends on this settled
   number). Only the *volume* question — whether 7-day notes strain disk in practice — remains a
   monitor-and-revisit, not an open design decision.
2. ~~Worker-span ownership of multi-workflow executors~~ — **resolved 2026-07-21:** one worker span
   per executor process, with per-system browser/session child spans and linked workflow run spans.
   Never fabricate one process span per workflow; the executor is intentionally multi-workflow.
3. ~~Descriptor `verdicts` expressiveness~~ — **resolved 2026-07-21:** use a closed serializable
   `tag: { fromDetail, map }` rule interpreted exhaustively on the server/client projection. No
   pure-function escape is sent to the browser and no workflow-id switch is introduced.
4. ~~Quarantine operations~~ — **resolved 2026-07-22:** visible redacted raw/reason, Hide, and Re-lift.
   Re-lift reruns the now-registered version adapter and replaces only projection state; there is no
   “mark valid/done” shortcut. Adapter deployment also schedules all quarantines of that version.

*(Resolved since the first draft: SQLite's role — D14, §2.3; the flip fallback window — one week,
D13, §5.4. End of the design body; §9 carries the ratified presentation decisions. Review order
suggestion: §1.1 span identity → §4 completion union → §5.2 lift mapping table → §5.4 scoped flip →
§6 guards → §9 ratified decisions.)*

---

## 9. Ratified delegation and presentation decisions (D6–D20)

Status: **ratified by the operator 2026-07-25.** These continue the **row-model decision series**
ratified 2026-07-24 (`reviews/second-look-2026-07-22.md` §6.6 — D1: three row types Run/Group/Member
with review-as-status and eight statuses; D2: a PDF upload is always a Group; D3: unrunnable items
are typed Rejected Member Rows, delete-only; D4: a delegated OCR run keeps its own Run Row in the
OCR panel plus a link from the parent; D5: groups default collapsed, auto-expand on a member
`Waiting on you` or `Failed`). **This series is not the reconciliation memo's D-numbers**
(`04-reconciliation.md` D1–D72) — cite these as *row-model D6…D20*.

D6–D17 close the twelve delegation questions in `reviews/delegation-layouts-2026-07-25.md` §7;
D18–D20 close three build-gating decisions in `reviews/demo-feature-plan-2026-07-25.md` §6. The
vocabulary is that ledger's: **`containment`** = `member | linked | rejected` (§3), Group Row anatomy
+ presentation ladder + rollup precedence (§4), delegation shapes S0–S7 (§5).

### D6 — oath-upload's signers are `linked`, not `member`; shape S4 is deleted

Oath Upload stays **one Run Row** for the PDF being uploaded. The signer rows live in the **Oath
Signature panel** as their own rows; the upload row carries a chip (`6 signers · 3 done ↗`) that
jumps there. Containment is **`linked`** — signers are never counted as members, never render nested
under the upload row, and are never removed from their own panel.

Rationale: a signer run is independently meaningful and independently viewable; the upload row's job
is the ticket, not the roster.

**Supersedes `reviews/delegation-layouts-2026-07-25.md` §7 Q1, which recommended the opposite**
(signers as `member`, delisted from the Oath Signature panel), **and deletes that ledger's §5 S4
layout ("Packet that ends in one filing")** — oath-upload is a Run Row that waits on linked children
and then performs its one final act. It has no Group Row anatomy, no member ladder, no member
rollup. This restores the as-built production model recorded in the root `CLAUDE.md` and in §4.5
here: the ticket is a real `single` daemon task born at upload that walks `OCR prep → awaiting
approval → wait signatures → submit` as one row. §4.5's sibling-subscriber gates and §4.3's
`completionConsumes: { memberShape: "natural", suppress: ["document"] }` are unchanged — the
presentation now matches the contract instead of contradicting it.

### D7 — a packet still at OCR review shows its extracted count

The count badge reads `6 people extracted` while the delegated OCR run is open, and flips to
`6 people` at fan-out. Rationale: "how big is this" is answerable before the members exist, and a
blank group before approval reads as broken.

### D8 — bulk approve from the Group Row; any edit forces the review surface

`Approve N of M` is available from the Group Row without opening the OCR review row. **Editing an
extracted value is not** — any edit routes through `Open review` so the scanned page is on screen
when the value changes. Rationale: approving is a decision about a list; changing a value is a claim
about paper, and the paper must be visible when it is made.

### D9 — rejected members never count toward done

A packet carrying rejections is `Done with warnings` until every rejection is deleted or explicitly
acknowledged. Rejected members stay excluded from the rollup and counted separately
(`50 people · 3 rejected`). Rationale: an unrun person is not a finished person. This pins the
ledger §4 rollup rule to its ratified form — `Verified done` requires zero unacknowledged
rejections.

### D10 — depth-2 delegated lookups are visible only from the OCR review row

Person-lookup / i9-lookup children of a delegated OCR run surface on that OCR row (and in their own
panel, per row-model D4) — **never on the packet group**. From the packet, "why is this person
blank" is answered on the **record card**, not by walking a delegation tree. Rationale: maximum real
depth is 2; surfacing it twice buys nothing and doubles the count surface.

### D11 — the presentation ladder, with the status matrix at 41+

| Members | Expanded body |
|---|---|
| 1–3 | Full Member Rows inline |
| 4–12 | Compact list, first 4 + `Show all N` |
| 13–40 | Compact list in a scroll well + `Open all N` |
| **41+** | **Status matrix** + attention strip + `Start review` drill-in |

Member count is continuous — this is presentation, never a row type, and the drill-in is a rung of
the ladder, not a route. **Supersedes the rebuild demo's current threshold of 20**, which changes to
41.

### D12 — the collapsed row shows the gate's age

`Waiting on you · 10m`. Rationale: an aging gate is the most actionable fact in the queue.

### D13 — a failed `linked` child makes the parent `Failed`, with `Re-upload`

When a linked OCR child fails, the parent goes **`Failed`**, mirrors the child's error verbatim
(never "Unknown error"), and offers a **`Re-upload`** action. **`Waiting on you` is reserved for a
pending decision and is never used for a breakage.** Rationale: the two states demand different
operator actions, and a breakage disguised as a decision is a gate that will never resolve.

### D14 — a group of one still renders as a Group Row

Consistent with row-model D2. Rationale: a group of one that looks like a Run Row makes the next
fan-out look like a new object.

### D15 — `person-match` keeps its Workflow Panel entry

It stays visible in the rail despite having zero callers today (i9-check searches inline).
**Supersedes `reviews/delegation-layouts-2026-07-25.md` §7 Q10, which recommended hiding it.**

### D16 — cancelling a group is tree-scoped, final, with no dialog and no undo

The only scope is the **tree** — group + all members + linked children. There is **no confirmation
dialog and no undo window**; cancel commits immediately. Recovery is re-running from the row's
history.

**Tradeoff, stated plainly: this deliberately accepts misclick risk to avoid a dialog on every
intentional cancel.** Cancel is used deliberately and often; a confirm on each one costs more than
the occasional re-run.

**Supersedes the "with a confirm naming the casualties" half of `reviews/delegation-layouts-2026-07-25.md`
§7 Q11**; the tree-scope half is ratified as recommended. Mechanically this is §2.4's `Cancel`
semantics unchanged — full dependency tree resolved from SQLite authority, every edge's doc 02
cancel policy applied, all-or-none, visible queue roots never an authority fallback. What D16
decides is scope and the absence of ceremony, not a new command.

### D17 — per-member confirmation numbers are inline on the packet receipt

Listed inline in the Receipt rollup table, not one link per member. Rationale: the Q8 acceptance
test is "the operator completes their double-check without opening UCPath", and a link per member
re-introduces N clicks.

### D18 — Status Bar pills: `All`, a composite `Needs you`, then the individual statuses

One row: an **`All`** pill, then a composite **`Needs you`** pill (= `Waiting on you` +
`Write parked` — the two statuses that mean a human is blocking), then each individual status.
**No status is hidden.** Rationale: the bar answers "is anything on me?" first and "what is
everything doing?" second. Counts are the same server-side projection that feeds `wfCounts` and the
queue rows (§2.2); the composite pill is a sum of projected buckets, never a second count path.

### D19 — run-detail tabs derive from panel kind; Screenshots is not a tab; Data and Edit Data are one surface

Ratifies the tab model **as built in the rebuild demo**:

- **(a) Tabs derive from the panel kind**, not a fixed set — Run 3 · Review 4 · Group 4 · Member 3.
- **(b) Screenshots is not a tab.** An **evidence bar** of images sits above the tabs, with no count
  label; a failure capture carries a red frame.
- **(c) Data and Edit Data are ONE merged surface** — every value the run touched. Reads are editable
  in place; **writes are shown but not editable**; the footer offers `Load a prior run` and
  `Start a run from this data`.

**Supersedes the "Log Panel tabs are therefore FIVE: Logs / Data / Review / Receipt / Screenshots"
wording in `reviews/second-look-2026-07-22.md` §6.6.** Unchanged from that decision sheet: the step
timeline is **not** a tab (persistent strip + hover detail), and tab defaults stay state-driven
(`Waiting on you` / `Write parked` → Review, terminal → Receipt, running → Logs).

Consequence for §2.2's wire: `QueueSurfaceWire.detailSurfaces` stays server-declared and
capability-driven — the panel kind selects from what the server declares — but `"screenshots"` no
longer projects a tab (it projects the evidence bar), and `"edit-data"` / `"view-data"` collapse into
one `data` surface whose write fields render read-only.

### D20 — `Write parked` means an unknown write outcome, and nothing else

`Write parked` is only for a write whose outcome is genuinely **UNKNOWN**, and it has exactly two
typed resolutions: **confirmed-present** and **confirmed-absent** (§2.2's `resolve-write-present` /
`resolve-write-absent` over doc 09's durable intent state). **A pre-submit hold is NOT parked — it
is a gate, and its status is `Waiting on you`.**

Consequence: the rebuild demo's `sep-rosa` fixture, which labels a pre-submit hold as `Write parked`
with a "Resume & submit" action, is wrong and must be re-authored as a gate. Rationale: parked is the
one status that means "we may have already filed something"; diluting it with holds we know the
state of destroys the only signal that warrants a live probe.
