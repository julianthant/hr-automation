# 03 — Tracker/Event Layer + Dashboard Contract (span rebuild)

Status: **amended per `04-reconciliation.md` (D1, D10–D14) — for operator review.** Conforms to
`00-charter.md` (full blast radius: tracker rebuilt around spans; dashboard consumes descriptor +
span contract).

## Ownership (D1)

| | Concept | Where |
|---|---|---|
| **This doc OWNS** | Span/event wire schema (§1, amended per D10), the notes stream, storage layout (§2.1), the SQLite projection role (per D14), SSE wire shapes (§2.2), the lift adapter + flip plan (§5), the completion (fan-out/approval) union (§4) | §§1–5 |
| **Imports from doc 01** | Task contract + `defineTask`, task id grammar (`<system>/<verb-object>` slash ids, per D2), the closed `SystemId` union — real `src/systems/` dir names (`new-kronos`, `old-kronos`) plus the D4 service systems (`extraction`, `ocr`, `roster` — charter §11), error taxonomy | referenced, never redefined |
| **Imports from doc 02** | Workflow descriptor shape + builder, RunEnvelope (`dryRun` home per D6), run-state machine incl. gates/parks (D5), checkpoint store schema, the readable span-path id grammar (`pl-104233-9f3e/searching#2`) | referenced, never redefined |
| **Exports doc 02 adopts** | Verdict mappings (§3.2 — these REPLACE `statusExtensions` in doc 02's descriptor), gate declarations, step display rules (`hidden`/`foldInto`), the detail-field declaration `SpanPatched` validates against | §3 |

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
  | GateOpened | GateResolved | SpanEnded;

interface Base extends SpanRef {
  t: string;            // event type discriminant
  ts: string;           // ISO-8601
  workflow: string;     // descriptor id — partition key
  pid: number;
}

/** Run is born at ENQUEUE, not at claim. Carries the validated workflow-constant input. */
export interface RunQueued extends Base {
  t: "run.queued";
  kind: "run";
  itemId: string;                  // stable business key (the completion program's deriveItemId, §4)
  parentRunId?: string;            // SCOPE axis — delegated iff present (unchanged semantics)
  shape: "single" | "preview" | "operation" | "operation-member";  // SHAPE axis, stamped ONCE
  subjectKind: "person" | "file" | "catalog";                      // KIND axis, derived from
                                                                   // descriptor.inputSubject, ONCE
  input: unknown;                  // the zod-validated input (retry/edit-resume authority) —
                                   // OMITTED for inputs carrying identifiers that must not ride
                                   // JSONL (i9 SSNs; the SQLite task row is the input authority,
                                   // mirroring today's deliberate i9-check-results deviation)
  subject?: { kind: string; value: string; name?: string };        // operator subject
  dryRun?: true;                   // mirrored from the RunEnvelope (D6) for display
  displayOnly?: true;              // task-less display row (§4.3, §5) — no claim will ever follow
  retryOf?: string;                // prior runId when this is a cross-run retry
}

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
  patch: Record<string, unknown>;
}

/** A run parked on an operator/system decision (D5: gates are run-state, owned by doc 02;
 *  these events are their wire form). Replaces `running/awaiting-approval` + sentinel steps. */
export interface GateOpened extends Base { t: "gate.opened"; gate: string; }   // gate ids declared in descriptor
export interface GateResolved extends Base { t: "gate.resolved"; gate: string; resolution: string; }

export interface SpanEnded extends Base {
  t: "span.ended";
  outcome: RunOutcome;             // task spans use "done" | "failed" | "cancelled" | "skipped"
  error?: string;                  // legible, names the offending value (fail-loud rule)
  verdict?: string;                // typed domain result ("not-found", "inactive") — see §3.2
}
```

**Notes** (high-volume annotations — log lines, screenshots, per-action records, data points) are a
parallel stream, not span events. Same `SpanRef` addressing, so a note attributes to its exact task
attempt:

```ts
export interface Note extends SpanRef {
  ts: string; workflow: string; pid: number;
  level: "step" | "success" | "error" | "waiting" | "warn" | "debug";
  message: string;
  fields?: Record<string, string>;           // category/system/attempt/durationMs/…
  /** Per-action attribution (D10): store-task id (doc 01 slash grammar) + selector-registry key. */
  action?: { task: string /* "ucpath/search-person-org" */; type: string; target?: string };
  attachment?: { kind: "screenshot" | "data-point"; payload: Record<string, unknown> };
}
```

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
├── ledger/  <system>-<date>.jsonl     immutable write receipts (D21; shape owned by doc 09 §6) —
│                                      hash-chained (seq + prevHash), append-only, per-SYSTEM+day,
│                                      NEVER pruned (the audit floor)
├── rows/ logs/ sessions/ …            LEGACY dirs — untouched, still written by old src,
│                                      read via the lift adapter (§5) until deleted
└── state.db                           SQLite — split role per D14 (§2.3): claim/checkpoint/fence
                                       tables are system-of-record; projection tables are rebuildable
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
- **Write discipline (ported verbatim):** append-at-now partitioning; cross-midnight solved at the
  read layer with the OPEN-span forward-merge (same algorithm as `cross-midnight.ts`); synchronous
  SIGINT terminal writes; `O_APPEND` single-line writes, no async mutex.

### 2.2 Projections are computed server-side — the wire carries surfaces, not rows

Today the client re-implements queue-surface classification, status keying, and pipeline math. In
temp_src the SSE stream carries **finished projections**; the client renders and never re-derives.
Static descriptor metadata does NOT travel on this stream — the SPA imports `DESCRIPTORS` directly
(doc 02 §1.2); the SSE hello carries only a `descriptorHash` so a stale partial rebuild fails loud.

```ts
// temp_src/server/topics.ts — SSE topic payloads (all change-gated snapshots, as today)
interface EventsHubPayload {
  descriptorHash: string;                  // doc 02's skew tripwire — NOT the descriptors themselves
  queue: { workflow: string; date: string; surfaces: QueueSurfaceWire[] };  // per subscribed panel
  queuePatch?: { workflow: string; date: string; runId: string; patch: Partial<QueueSurfaceWire> }[];
  //  ^ after the initial snapshot, a changed surface re-sends ONLY itself (id + delta) — a
  //    100-member operation tick re-serializes one member row, never the resolved member tree (D10)
  wfCounts: Record<string, number>;        // rail badges — backend-authoritative, unchanged rule
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
  gates: { gate: string; open: boolean; resolution?: string }[];
  actions: ActionDescriptorWire[];                   // ported from runtime-policy projection;
                                                     // display-only rows get delete only (§4.3)
  memberRunIds?: string[];                           // operation only — ids, NEVER nested trees (D10);
  memberRollup?: Record<string, number>;             // status-key → count, for the mini-badge
  //  members are ordinary flat surfaces in the same queue payload (joined client-side by
  //  parentRunId); each is change-gated individually via queuePatch
  detailSurfaces: ("logs"|"screenshots"|"review"|"edit-data"|"view-data")[];  // capability-driven tabs
  links?: { review?: { workflow: string; runId: string } };  // "Open OCR review" jump
}
```

Per-run detail (timeline, notes, screenshots) stays request/response + a per-run SSE topic, as
today — but the payload is the span tree + notes, already merged and ordered; `LogStream` stops
owning merge/dedup heuristics (`mergeDisplayItems` collapse survives as a server-side fold).

### 2.3 SQLite (role per D14)

`state.db` has **two classes of table with different authority**:

- **System-of-record (NOT rebuildable, NOT deletable):** the task/claim store (tasks, leases,
  dependencies, commands — doc 02 §3.7's checkpoint payloads, §4.4's `ocr_approvals` manifests, and
  **doc 09's `write_intents` crash-fence table**). The `write_intents` addition **amends D14** — the
  system-of-record set is now "claims + checkpoint payloads **+ the write-intent fence**," because a
  lost in-flight fence would re-open the exactly-once crash window (doc 09 §3/§4). Live queue truth.
  Losing any of these loses claims, checkpoints, or in-flight write fences — they have no JSONL
  double.
- **Projection tables (rebuildable):** span-shaped read models (`spans`, `gates`, `notes`,
  `runs_view`) fed by one projector consuming both native spans and lifted legacy events (§5).
  These — and only these — can be deleted and rebuilt from JSONL, with today's operational rules:
  JSONL writes first, projection applies after, projection failures schedule guarded rebuilds and
  never block workflows; source identity is `resolve(path)`; deletion tombstones and offline
  compaction port as-is.

Any sentence in this doc that says "rebuildable" means the projection tables only.

---

## 3. Descriptor fields this layer consumes (shape owned by doc 02)

**Doc 02 owns the `WorkflowDescriptor` shape and builder** (D1). This section does not define a
descriptor interface; it names the fields this layer *reads*, and the fields it *contributes* for
doc 02 to adopt. The tracker enforces its half at the emit boundary: **emitting a task span whose
`name` is not a descriptor step key, a gate not in the descriptor's gate list, a verdict not in its
verdict map, or a patch key not in its detail-field list, throws at emit time.**

### 3.1 Read from doc 02's descriptor
`id`, `code` (2-char trace prefix), `label`, `icon`, `category`, `archetype` (shape / resolver),
`inputSubject`, `tasks[].key/label` (step pipeline + labels), `surfaces` (input/upload run
affordances), presentation-override layering (D16: descriptor label → operator override, nothing
else).

### 3.2 Contributed by this doc, adopted into doc 02's descriptor
These are plain-data fields; doc 02's descriptor carries them, this doc defines their semantics:

```ts
steps display rules:  { key, label, hidden?, foldInto? }      // computeOcrPipelineView's fold/hide
                                                              // tables become data
gates:    { id: string; label: string; statusKey?: string }[] // e.g. { id:"approval", statusKey:"needsReview" }
verdicts: Record<string, { label; tone: "info"|"success"|"warning"|"destructive"; tag?: boolean }>
//  ^ REPLACES statusExtensions (review #5 / D1): person-lookup's `notFound` becomes
//    { "not-found": { label:"Not found", tone:"warning" } } over span.ended.verdict; the
//    identity-approval badge (§5.4) becomes a gate statusKey. The statusExtensions function
//    registry does not exist in temp_src.
details:  { key: string; label: string; conditional?: boolean }[]
//  ^ the SpanPatched validation set (review #11): every patch key must be declared here.
//    Successor of today's detailFields incl. the "declared but never populated" warn.
capabilities: { review?: "ocr"; editData?; viewData?; delegation?: {...} }
completion?: CompletionProgram                                // §4 — OCR-backed workflows only
migratedAt?: string                                           // §5.2 — source-authority cutover
```

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
import type { WorkflowRef } from "./ref.js";   // typed handle: WorkflowRef<TInput> carries the
                                               // target's zod-inferred input type (docs 01/02)

export type CompletionProgram =
  | StagedFanOut          // oath, emergency-contact, onbase-ec: approval gate → ordered stages
  | CompleteThenEnqueue;  // i9: read-only run completes, THEN members enqueue under the coordinator
// oath-upload deliberately has NO CompletionProgram — see §4.5 (sibling subscriber).
// verify deliberately has NO CompletionProgram — see §4.6 (in-run enrichment, not completion).

export interface StagedFanOut {
  mode: "staged-fanout";
  gate: "approval";                          // the gate this program resolves
  /** ORDERED. Stage N+1's derive receives stage N's ACTUALLY-ENQUEUED itemIds — as-built:
   *  oath's per-document ticket gets `perRecordItemIds` = the ids the record stage really
   *  enqueued after `eligible` filtering (approve.ts:306, oath.ts:455), never the selected set. */
  stages: [PerRecordStage<any>, ...FanOutStage[]];
}

export type FanOutStage = PerRecordStage<unknown> | PerDocumentStage<unknown>;

export interface PerRecordStage<TIn> {
  per: "record";
  to: WorkflowRef<TIn>;                      // compile error if derive() output ≠ target input type
  derive: (record: PreviewRecord, ctx: ApproveContext) => TIn;  // ctx = sessionId/runId/parentRunId/
                                                               // pdf identity (as-built recordContext)
  /** As-built canFanOut: oath = signed + 5-digit EID (`hasOathSignerInput`); EC = EID-complete.
   *  Shared, named, exported predicates only (§4.2). Skipped records are NOT enqueued and their
   *  itemIds do NOT reach later stages. */
  eligible?: NamedPredicate;
  /** As-built deriveItemId(record, ocrRunId, index) — stable ids minted into the durable manifest
   *  BEFORE dispatch. The enqueue-side resolver keys on the LOGICAL (runtime-options-stripped)
   *  input and FAILS LOUD on a miss (buildFanOutItemIdResolver; the E2E-015 shared-id fallback is
   *  banned). */
  deriveItemId: (record: PreviewRecord, runId: string, index: number) => string;
}

export interface PerDocumentStage<TIn> {
  per: "document";
  to: WorkflowRef<TIn>;
  derive: (doc: ApprovedDocument) => TIn;    // doc.perRecordItemIds = prior stage's enqueued ids
  deriveItemId: (doc: ApprovedDocument) => string;
}

export interface CompleteThenEnqueue {
  mode: "complete-then-enqueue";             // i9: no approval gate exists — nothing to approve
  then: {
    per: "person";
    to: WorkflowRef<unknown>;                // i9-check member task (real daemon work)
    /** Runs at the PREPARE seam (as-built: /api/ocr/prepare after the delegated run completes,
     *  gated on the coordinator existing — prepare.ts:476-505), NOT at an approve route. */
    derive: (plan: MemberPlanEntry) => unknown;
    /** Pages that can never be searched become TASK-LESS display-only failed member rows
     *  (`run.queued { displayOnly: true }` + immediate `span.ended("failed")`; no run.claimed,
     *  no worker span, delete-only actions) — as-built i9-check-results.ts displayFailures. */
    displayFailures: true;
  };
}
```

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
- **Handler-owned, NOT declarable** (stated per D11 rather than forced into the union): the
  zero-signer refusal (approved-but-empty ⇒ throw, never file an empty ticket), the discard →
  `cancelled("discarded")` mapping (ISS-007), and the submit-idempotency window
  (`submitAttempted` marker + prior-ticket probe). These are run-state/task logic under docs
  01/02's contracts.

### 4.6 verify — in-run enrichment, not completion

verify has **no completion contract**: no approve targets, no `completeDelegatedRun`. Its
fan-outs (`verify.ts:523-660`) happen **during the run**, inside `enrichRecords`: two concurrent
BLOCKING gated fan-outs (person-lookup + i9-lookup, `Promise.allSettled` so an abort lets each
branch cascade-cancel its own children) that patch records and re-emit progress as EACH child
terminates. In the new model that is doc 02 territory — delegation tasks + in-run gates emitting
ordinary task spans and `span.patched` record updates — and this doc deliberately does not model
it as completion. The previous draft's `CompleteOnEnrichment` conflated verify with i9; they share
only "read-only". i9 is §4.1's `CompleteThenEnqueue` (post-completion member enqueue at the
prepare seam); verify is mid-run enrichment with nothing after completion.

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
export function liftLegacyRun(entries: TrackerEntry[], logs: LogEntry[]): LiftResult;
// LiftResult = { spans: SpanEvent[]; notes: Note[] } | { quarantined: QuarantinedRow }
```

**Lift inputs come from the visible-entries layer, never raw files (review #9):** the lifter reads
through `readVisibleEntries*` / the tombstone-filtered SQLite views (`deletions/visible.ts`), so an
operator-deleted run stays deleted — raw-file reads would resurrect it. Session-event lifting
applies the same tombstone filter.

**Lift policy is quarantine, NEVER throw (D12) — including post-cutover rows and invalid
archetypes.** A row the lifter cannot classify — an invalid `data.archetype` (which
`resolveRowArchetype` throws on today, `row-archetype.ts:96-99`; the lifter catches at the row
boundary), an unknown status/step combination, a post-cutover legacy row (§5.2) — produces a
`quarantined` diagnostic: a loud queue card carrying the raw JSON + reason, a warn note, and a
count on the SSE hub (`quarantine` topic, §2.2). One bad row — or one straggling old daemon still
writing legacy rows after cutover — degrades to a visible quarantine card; it can never take down
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
| operation coordinator rows (display-only, stamped at prepare) & i9 `data.displayOnly==="true"` members | `run.queued { displayOnly: true }` (+ `span.ended` for the failed members) — **NO fabricated `run.claimed`, NO worker span** (review #9); actions project delete-only |
| session events | worker/browser spans keyed by (instance, pid) — the pid heuristics live here and ONLY here |
| data diffs on re-emits | `span.patched` (identity keys excluded — a legacy re-stamp folds into details, never identity) |
| anything else — invalid archetype, unknown status/step, post-cutover legacy row | **quarantine (§5.1), never throw, never a silent default** |

**Pinned by a real-tracker-day replay fixture (D12):** a test corpus of copied real `.tracker`
days (plus the seeded operation/preview/cross-midnight fixtures) replays through the lift asserting
**zero quarantines** and asserting the invariants above (every attempt's spans open/close exactly
once; no claimed/worker spans on display-only rows; tombstoned runs absent). A new legacy row shape
discovered in production shows up as a quarantine card AND a fixture failure when that day is added.

### 5.3 Source authority — a workflow is legacy XOR migrated

`descriptor.migratedAt` (absent = legacy). Rows for a migrated workflow written *after*
`migratedAt` mean old code is still running somewhere — the lift **quarantines them loudly**
(visible card + notification; per D12 this is quarantine, not the previously-specified throw — a
straggling old daemon must not kill the read path, §5.1). The native reader ignores legacy files
entirely. History stays readable: pre-migration dates for a migrated workflow still render via
lift. Cross-boundary delegation works because runId / parentRunId / traceId formats are ported
unchanged — a lifted legacy OCR parent and a native person-lookup child join in the same
projection by `parentRunId`, exactly like two native runs.

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
   the rest of the ~103-endpoint long tail: exports, screenshot/blob serving, OCR review
   mutation routes…) — is **proxied/re-mounted onto the old route handlers** inside the new
   server, each with its own later migration milestone. The old dashboard stays runnable as
   `dashboard:legacy` for **one week of real operation** (D13 resolves old open question 5),
   then dies.
4. **Phase 2+ (per-workflow migration):** each migrated workflow sets `migratedAt`; its emissions
   switch to native spans; the lift covers everyone else. The dashboard cannot tell the
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
| 6 | Double-source counting during migration (a workflow emits both legacy rows and spans) | `migratedAt` authority rule (§5.3): post-cutover legacy rows **quarantine loudly** (card + notification + fixture assertion) — visible, attributable, and non-fatal to the read path. Test seeds exactly that and asserts the quarantine surfaces |
| 7 | Open spans leak on crash and show "running" forever | Projection derives `interrupted` for an open run span whose worker pid is dead AND a newer run for the same itemId started (mirrors `readRunsForId` exactly — pending/running only, non-newest only); worker liveness rides SQLite heartbeats as today. No fabricated durations |
| 8 | The completion union grows a fourth ad-hoc arm as an object literal side-channel | Programs constructible only via `defineFormSpec` (sealed brand, §4.2); spec-to-spec imports banned by guard; `extendFormSpec` is the sole composition path and re-validates. The two declared non-arms (oath-upload, verify — §4.5/§4.6) are pinned by tests asserting they have NO CompletionProgram |
| 9 | The lift adapter becomes load-bearing forever (nobody deletes it) | Ratchet: test fails when `descriptors.every(d => d.migratedAt)` && `compat/lift-legacy.ts` exists. Also fails the reverse (a legacy workflow with no lift coverage) |
| 10 | Notes stream abused as a data channel (parsing log text for state — today's forbidden pattern) | Notes are render-only in projections; any projection reading `note.message` content (vs. structured `fields`/`action`) fails a grep guard. Data that drives state must be a span event |
| 11 | Quarantine becomes a silent bit-bucket (rows rot there unnoticed) | Quarantine is a VISIBLE queue card + SSE `quarantine` count + notification; the real-day replay fixture asserts **zero** quarantines on known-good days, so any new legacy shape fails CI when its day joins the corpus |
| 12 | Resolved member trees creep back onto the wire (the 5-8k-field re-serialization) | `QueueSurfaceWire` has `memberRunIds: string[]` only — no recursive member field exists to populate; a type-level test pins that the wire type is non-recursive; the SSE tick test asserts a 100-member operation patch serializes one surface |
| 13 | Attempt discipline erodes (a re-pend reuses attempt 1 and re-opens closed spans) | The replay fixture asserts open/close-once per `(runId, attempt, spanPath)` across days containing real reassign/bump traffic; `run.requeued.nextAttempt` is emit-validated as monotonic |
| 14 | The `ledger/` dir gets pruned, or `write_intents` treated as a rebuildable projection (D21) | `ledger/` is exempt from `clean-tracker` (a retention-floor ratchet — owned by doc 09 §8 — fails if any prune path reaches it); `write_intents` is enumerated in §2.3's system-of-record set (amends D14), so the "rebuildable ⇒ projection tables only" rule (§2.3) keeps it undeletable. Base retention (`notes/` 7d, `spans/` 30d) is a fixed §2.1 decision, so the never-pruned floor sits above a settled number, not a guess |

---

## 7. Worked example — operation coordinator flow, end to end in spans

Operator uploads `Oath_Packet.pdf` targeting oath-signature (dry-run off, 2 signers on the paper).
Span ids shown in doc 02's path grammar; `attempt` omitted where 1.

```jsonc
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
//    "action":{"task":"ocr/extract-page","type":"ocr"},"fields":{"page":"1","tier":"1"}}
{"t":"span.ended","spanPath":"os-141002-11ab/ocr#1","outcome":"done"}
{"t":"span.started","kind":"task","name":"person-lookup","spanPath":"os-141002-11ab/person-lookup#1"}
{"t":"span.patched","spanPath":"os-141002-11ab","patch":{"records":[/* preview records v2 */]}}
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
{"t":"gate.resolved","spanPath":"os-141002-11ab","gate":"approval","resolution":"approved"}
{"t":"span.ended","spanPath":"os-141002-11ab","outcome":"done"}

// spans/oath-signature-2026-07-17.jsonl        (member fan-out — children of the COORDINATOR)
{"t":"run.queued","workflow":"oath-signature","runId":"R-m1","spanPath":"os-141002-c001",
 "traceId":"os-141002-c001","parentRunId":"R-op","itemId":"ocr-oath-R-ocr-r0",
 "shape":"operation-member","subjectKind":"person","input":{"employeeId":"12345678","name":"Lopez, Maria"}}
{"t":"run.queued","workflow":"oath-signature","runId":"R-m2", /* … r1 … */}
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

## 8. Open questions for the operator / orchestrator

1. **Notes retention & volume — RESOLVED (D21), no longer open.** Base retention is **decided**
   (§2.1): `notes/` prune at **7 days** (today's `clean:tracker` default — the high-volume stream
   that now also carries per-action records, D10), `spans/` at **30 days** (the audit skeleton). The
   `ledger/` dir is **never pruned** and sits above both floors (doc 09 §6 depends on this settled
   number). Only the *volume* question — whether 7-day notes strain disk in practice — remains a
   monitor-and-revisit, not an open design decision.
2. **Worker-span ownership of multi-workflow daemons** — the i9-check single-UCPath-browser daemon
   and future shared daemons: one worker span per workflow (current design) or per process with
   workflow links? Current design assumes daemon:workflow is 1:1, as today.
3. **Descriptor `verdicts` expressiveness** — person-lookup's A/IA secondary tag needs one derived
   field beyond a verdict enum; is a small `tag: {fromDetail: "activeStatus", map: {...}}` data rule
   acceptable, or do we allow bundle-safe pure functions in the descriptor module (doc 02 call)?
4. **Quarantine operations** — does a quarantined legacy row need an operator action beyond
   "inspect raw JSON + delete" (e.g. "re-lift after fix"), or is read-only + delete enough for a
   transition-period diagnostic surface?

*(Resolved since the first draft: SQLite's role — D14, §2.3; the flip fallback window — one week,
D13, §5.4. End of design doc. Review order suggestion: §1.1 span identity → §4 completion union →
§5.2 lift mapping table → §5.4 scoped flip → §6 guards.)*
