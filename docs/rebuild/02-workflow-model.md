# 02 — Workflow Model: Descriptor SSOT · Constant Input · Run-State Machine · Start-Anywhere Resume

Status: amended per `04-reconciliation.md` (binding) after `reviews/02-review.md`. Conforms to
`00-charter.md` (targets 1, 2, 4, 5, 6; fail-loud non-negotiable). Code lands in `temp_src/`.

## Ownership (D1)

| This doc OWNS | Imported from siblings (referenced, never redefined) |
|---|---|
| The ONE workflow builder API — steps, gates, `decorate`/`instrument` attachment points, `auth` override (absorbs doc 01 §5's sketch, which is superseded) | Doc 01: task contract (`defineTask`), contract/impl split (D3), `<system>/<verb-object>` id grammar + `SystemId` (D2), error taxonomy, effect/dry-run mechanics, retry policy, decoration hook types (`TaskHooks`), stores, session providers, `freshness.maxAgeMs` on read contracts (D8), the worked-example contracts (doc 01 §9) |
| Descriptor shape (incl. verdict mappings, gate declarations, derived session union) | Doc 03: span/event **wire** schema incl. `gate.opened`/`gate.resolved`, notes stream, storage layout, SQLite projection, SSE wire shapes, lift adapter, completion (fan-out/approval) union |
| `RunEnvelope` (incl. `dryRun` — D6) | |
| Run-state machine incl. gate nodes and parks (D5) | |
| Checkpoint/resume model: store, freshness (D8), scope (D9), task-authoring rule | |
| Span-id path grammar + attempt semantics (what the engine brackets) | |

---

## 0. Grounding — what exists today, why it hurts

- `defineWorkflow` (`src/core/kernel/workflow.ts`) is the closest thing to a descriptor, but it
  imports Playwright transitively, so it never ships to the browser. The client re-declares
  metadata by hand: `formatStepName` string-switches (`dashboard/components/shared/types.ts:405`),
  `pipelineStepLabel`'s run-conditional override (`StepPipeline.tsx:127`),
  `workflow-icons.ts`, `INSTANCE_LABELS` (`tracker/session-events.ts:395`).
- ~10 parallel registries keyed by the same string names: `WORKFLOW_LOADERS`,
  `DASHBOARD_INPUT_RUN_WORKFLOWS` + `DASHBOARD_UPLOAD_RUN_WORKFLOWS`, `INPUT_RUN_REGISTRY`,
  `RUN_MODAL_REGISTRY`, `WORKFLOW_ICONS`, `INSTANCE_LABELS` (+ `LEGACY_INSTANCE_LABELS`),
  `E2E stub map`, `queue-row-status-index.ts`, the `:stop` npm scripts. Two have coverage guards
  (`instance-labels-coverage`, `queue-row-kind-coverage`); the rest fail at runtime.
- Timing is inferred, not recorded: `computeStepDurations` (`tracker/dashboard/run-timelines.ts`)
  reconstructs step durations from row-status transitions with anchor heuristics. `step_change`
  session events exist *only* to carry the live step.
- Long waits are faked as steps: a delegated OCR run parks at `running/awaiting-approval` via
  sentinel statuses; oath-upload hand-rolls a wait-signatures polling step; nothing releases the
  browser while a run waits days for an operator.
- Resume exists only as ad-hoc channels: retry replays `tasks.original_input_json`; Edit Data
  rides a `prefilledData` side channel that `splitPrefilled` strips before schema parse; a step
  that needs an upstream value re-reads it from stringified tracker `data`.

The new model replaces all of this with the **descriptor** (one client-safe declaration per
workflow), the **run-state machine** (gates as first-class parks), and the **checkpointed run
context** (typed data flow between tasks). Time lives in doc 03's span stream.

---

## 1. The workflow descriptor

### 1.1 Shape

One module per workflow: `temp_src/workflows/<id>/descriptor.ts`. It imports **only** zod,
`temp_src/domain/**` (which includes the task **contracts** at `temp_src/domain/contracts/<system>/`
— D3's client-safe half), and type-only imports — never a store, never Playwright. Enforced
mechanically (§1.4). "Plain data" means: serializable fields plus pure functions (zod schemas,
input parsers, bind mappings) — the same class of object that already crosses the bundle boundary
in `queue-row-status-index.ts`.

```ts
// temp_src/domain/workflow/descriptor.ts  (client-safe)
import { z } from "zod/v4";
import type { AnyTaskContract } from "../contracts/types.js";   // doc 01 / D3

/** Compile-time icon union; the dashboard's icon map is Record<IconName, LucideIcon>
 *  (exhaustive), so a new name without a component FAILS TO COMPILE. */
export const ICON_NAMES = ["Search", "Users", "UserMinus", "FileScan", /* … */] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** A node in the run sequence: a task step or a gate (D5). Built via the builder (§3). */
export type FlowNode = TaskStepNode<any, any> | GateNode;

export interface TaskStepNode<TCtx, C extends AnyTaskContract> {
  kind: "task";
  /** Workflow-local step id — the span/label/resume key. Unique per workflow. */
  id: string;
  /** Display label. Defaults to the contract's `title` (D16 — see §1.5 precedence). */
  label?: string;
  uses: C;                             // the CONTRACT object (doc 01 / D3), imported by value
  /** Bind the task's input from workflow input + upstream outputs. Returns z.input<C["input"]>;
   *  the impl's run receives z.output<C["input"]> (doc 01 / D15). Must be PURE. */
  bind: (ctx: TCtx) => z.input<C["input"]>;
  /** Optional condition; a skipped step's output is `T | undefined` downstream (type-forced). */
  when?: (input: unknown) => boolean;
  /** Resume policy — REQUIRED, no default (§5.3). */
  replay: "checkpoint" | "always-rerun";
  /** Pre-write idempotency-probe policy — REQUIRED on a mutate step, NO default (D17 / the §b
   *  migration question). Illegal on a read/derive step. Semantics owned by doc 09 §5; the
   *  *recovery* probe (§5.6 #2) is always-on regardless of this knob. */
  probePolicy?: "always" | "retries-and-recovery-only";
  // NOTE: no `write` flag (D7) — write gating derives from the contract's effect:"mutate".
  // NOTE: no `system` field — the system is the contract id's `<system>/` prefix.
}

export interface GateNode {
  kind: "gate";
  id: string;                          // e.g. "approval" — doc 03's gate.opened/resolved key
  label: string;
  statusKey?: string;                  // e.g. "needsReview" — doc 03's status projection
  resolvedBy: "operator" | "children-terminal" | "external";
}

export interface WorkflowDescriptor<TInput> {
  id: string;                          // "person-lookup"
  code: string;                        // "pl" — 2-char trace prefix, unique (guarded)
  label: string;                       // "Person Lookup"
  sessionLabel?: string;               // terminal-drawer label when ≠ label (separations → "Kuali")
  icon: IconName;
  category: WorkflowCategory;          // union, not free string
  input: z.ZodType<TInput>;            // the workflow-constant input schema (§2)
  inputSubject: InputSubject | ((input: TInput) => InputSubject);  // wire form: "by-input"
  surface: { shape: RowShape } | { resolveShape: "by-input" };     // doc 03's field name
  nodes: readonly FlowNode[];          // ordered — built via the typed chain builder (§3)
  /** PROJECTIONS (derived at build(), never hand-written):
   *  steps:   nodes.filter(kind==="task") → { id, label, hidden?, foldInto? }[]  (doc 03 consumes)
   *  gates:   nodes.filter(kind==="gate") → { id, label, statusKey? }[]          (doc 03 consumes)
   *  systems: union of task contracts' `<system>/` id prefixes, browser stores only (D2/D15 —
   *           the hand `systems:` list is DELETED; service stores `extraction`/`ocr`/`roster` contribute none) */
  surfaces: {
    /** Typed-text start (InputRunPanel). Absent ⇒ no input-run affordance. */
    inputRun?: { placeholder: string; parse(raw: string): InputRunParseResult;
                 supportsDryRun?: boolean; emptyOpensUpload?: boolean };
    /** File-upload start (RunModal). Absent ⇒ no upload-run affordance. */
    uploadRun?: { title(ctx: RunModalContext): string; sections: RunModalSections;
                  submit: UploadSubmitSpec; successToast(r: SubmitResponse, f: File): Toast };
  };
  /** Verdict mappings — doc 03's statusExtensions replacement. Plain data, bundle-safe. */
  verdicts?: Record<string, { label: string; tone: "info"|"success"|"warning"|"destructive"; tag?: boolean }>;
  /** Completion (fan-out/approval) contract — SHAPE OWNED BY DOC 03 §4; referenced here only. */
  completion?: CompletionContract;
  capabilities?: WorkflowCapabilities;  // doc 03 §3 (review/editData/delegation display rules)
  migratedAt?: string;                  // doc 03 §5 — source-authority cutover
}
```

### 1.2 The bundle crossing

```
temp_src/workflows/person-lookup/
├── descriptor.ts     # client-safe: zod + domain (incl. contracts) only ← imported by BOTH sides
└── index.ts          # server barrel: pairs descriptor with its stores' impls
```

There is no per-workflow `handler.ts`: step impls live in the **stores** (doc 01 §3; D3 —
`defineTask(contract, impl)` in `temp_src/stores/<system>/tasks/` is the only impl registry). The
descriptor references contract *objects*, so descriptor↔contract renames fail to compile at the
import site. Descriptor↔impl pairing is runtime: the engine resolves each step's contract id in
the store index at daemon boot and **fails loud on any unresolved contract** — plus the §1.4
coverage guard pins it at CI.

```ts
// temp_src/domain/workflow/index.ts       (client-safe — THE one list)
import { personLookupDescriptor } from "../../workflows/person-lookup/descriptor.js";
/* … every workflow … */
export const DESCRIPTORS = [personLookupDescriptor, /* … */] as const;
export function getDescriptor(id: string): AnyDescriptor {
  const d = DESCRIPTOR_BY_ID.get(id);
  if (!d) throw new Error(`Unknown workflow "${id}" — not in DESCRIPTORS`);  // fail loud
  return d;
}

// temp_src/core/workflow-registry.ts      (server only — the WORKFLOW_LOADERS successor)
export const SERVER_REGISTRY: Record<WorkflowId, {
  descriptor: AnyDescriptor;
  loadStores: () => Promise<void>;   // lazy import of the stores this workflow's contracts resolve in
}> = { /* … */ };
```

The dashboard **imports `DESCRIPTORS` directly** — static metadata never travels over
`/api/workflow-definitions` again (that endpoint survives only to layer the serve-time
presentation overrides — §1.5). A mismatch after a partial rebuild surfaces as a descriptor-hash
field on the SSE hello (cheap, loud).

### 1.3 Every parallel registry becomes a projection

| Today's hand-list | Becomes | Mechanism |
|---|---|---|
| `WORKFLOW_LOADERS` | `SERVER_REGISTRY` | same ids; guard asserts key-set parity with `DESCRIPTORS` |
| `DASHBOARD_INPUT_RUN_WORKFLOWS` | `DESCRIPTORS.filter(d => d.surfaces.inputRun)` | pure derivation — list deleted |
| `DASHBOARD_UPLOAD_RUN_WORKFLOWS` | `DESCRIPTORS.filter(d => d.surfaces.uploadRun)` | same |
| `INPUT_RUN_REGISTRY` | `d.surfaces.inputRun` | parser lives on the descriptor |
| `RUN_MODAL_REGISTRY` | `d.surfaces.uploadRun` | same |
| `WORKFLOW_ICONS` | `Record<IconName, LucideIcon>` (exhaustive) | compile-time; static imports keep tree-shaking |
| `INSTANCE_LABELS` | `d.sessionLabel ?? d.label` | `LEGACY_INSTANCE_LABELS` kept for on-disk history only |
| e2e stub map | derived **happy path only**: walk `d.nodes`, emit each contract's `example` output (schema-parsed) | failure / cancel / parallel-worker scenarios REMAIN hand-scripted in the stub lane — examples cannot express them (D3) |
| step-label switches (`formatStepName`, `types.ts:405`) | `getDescriptor(wf)` step label (§1.5) | `formatStepName` demoted to legacy-row fallback that `console.warn`s in dev |
| `queue-row-status-index.ts` | `d.verdicts` + `gates[].statusKey` read from `DESCRIPTORS` | the index file and the `statusExtensions` function registry are deleted; verdict mappings are plain data (doc 03 §1.3/§3) |
| `:stop` npm scripts | one `cli stop <workflow>` reading `DESCRIPTORS` | scripts deleted |

### 1.4 The ONE coverage guard

`tests/unit/architecture/descriptor-coverage.test.ts` — a single table-driven test over
`DESCRIPTORS`:

1. ids unique; codes unique + 2 chars; `icon` ∈ `ICON_NAMES`.
2. `SERVER_REGISTRY` keys === descriptor ids (both directions).
3. Every task node's `uses` contract resolves in the store impl index; every contract's `example`
   parses against its own output schema; every **read** contract declares `freshness.maxAgeMs`
   (D8 — `Infinity` only with a justification comment, snapshot-listed).
4. Node ids unique per workflow; every contract id prefix is a known `SystemId` or service store
   (`extraction`, `ocr`, `roster` — D4); the derived `systems` union is what the session planner will use.
5. Every `completion` contract's targets typecheck against their target descriptors' `input`
   schemas (mechanism owned by doc 03 §4; asserted here because descriptors live here).
6. Descriptor modules **value-import** nothing outside `zod` + `temp_src/domain/**` (walks the
   import graph — this is what *keeps* them client-safe forever; type-only imports are exempt).

Plus one ratchet in the same file: any object literal in `temp_src/` (outside
`descriptor.ts`/`workflow-registry.ts`) whose keys include ≥3 known workflow ids fails with
"looks like a new hand-maintained workflow registry — derive it from DESCRIPTORS instead".

### 1.5 Labels — exactly two layers (D16, precedence stated once, HERE)

A step's display label resolves, highest precedence first:

1. **Operator presentation override** — the serve-time `config/workflow-presentation/<id>.json`
   layer, visible and editable in Settings. The ONLY override layer.
2. **Descriptor `step.label`, defaulting to the contract's `title`** — one authored source with
   one default; omitting `label` is the normal case.

There is no third source. Doc 01's contract `title` is the default, never a competing layer; doc
03's projections carry the resolved label on the wire and never re-derive it client-side.

---

## 2. Workflow-constant input + the RunEnvelope

**The input is what the operator (or a delegating parent) supplied at start. It is validated once
by `descriptor.input`, stored verbatim (successor of `tasks.original_input_json`), and never
mutated for the life of the run.** Rerun-with-different-input = a *new* run. Everything a task
learns goes into the run context (§5), never back into input.

| Lives in **input** (constant) | Lives in **run context** (derived) | Lives in the **RunEnvelope** (kernel channel) |
|---|---|---|
| subject identity: name / emplId / docId / email / pdf blob ref | task outputs (resolved EID, CRM record, receipts) | runId, workflowId, itemId, parent `{runId, tracePrefix}` |
| operator flags: `keepNonHdh`, `includeCrmDates` | statuses, screenshots refs, warnings | **`dryRun` (D6)**, `shape`, `startAt`, `injected`, `freshnessOverride` (§5.5) |
| delegation *display* subject (`parentSubject`) | timing (spans own it — §6) | claim/lease/attempt metadata, `enqueuedAt` |

`dryRun` is **kernel-owned envelope state, never workflow input** (D6): workflow schemas cannot
declare it, the input-run surface's dry-run toggle writes the envelope, and doc 01's effect
mechanics (`ctx.dryRun` visible only to mutate tasks, simulate/unsupported, the never-consulted
tripwire) read it from there.

```ts
// temp_src/domain/run/envelope.ts   (client-safe shape; kernel is the only writer)
export interface RunEnvelope {
  runId: string;
  workflow: WorkflowId;
  itemId: string;                    // logical-item key half: (workflow, itemId) — §5.7
  traceId: string;                   // frozen at enqueue (ported verbatim)
  parent?: { runId: string; tracePrefix: string };
  shape: "single" | "preview" | "operation" | "operation-member";
  dryRun: boolean;                   // D6 — the ONLY home of this flag
  startAt?: string;                  // step id — resume entry (§5)
  injected?: Record<string, unknown>;         // per-step operator-supplied outputs (§5.6 #3)
  freshnessOverride?: { stepId: string; confirmedAt: string }[];  // D8 override — §5.5
  retryOf?: string;                  // prior runId on cross-run retry (§6)
  attempt: number;
  enqueuedAt: string;
}
```

The `RunEnvelope` replaces today's `__runtimeOptions`/`prefilledData` smuggling: kernel concerns
ride a typed envelope **beside** the input, so workflow schemas stay `strict()` and
`splitPrefilled` has no successor.

```ts
// temp_src/workflows/person-lookup/descriptor.ts (input half — note: NO dryRun field)
export const PersonLookupInput = z.union([
  z.object({ name: z.string().min(1), keepNonHdh: z.boolean().optional(),
             includeCrmDates: z.boolean().optional() }).strict(),
  z.object({ emplId: EidSchema, name: z.string().min(1).optional(),
             keepNonHdh: z.boolean().optional(), includeCrmDates: z.boolean().optional() }).strict(),
]);
```

---

## 3. The ONE builder API (absorbs doc 01 §5)

Doc 01 §5's `FlowBuilder` sketch and this doc's earlier `.task({...})` shape are unified here —
this is the single API; doc 01 defers to it. The builder accumulates a **`Steps` generic map**
(step id → contract) so outputs, decoration, and instrumentation are all typeable:

```ts
// temp_src/base/flow.ts
interface StepEntry<C extends AnyTaskContract> { contract: C; conditional: boolean }
type OutputsOf<S> = { [K in keyof S]: S[K] extends StepEntry<infer C>
  ? z.output<C["output"]> | (S[K]["conditional"] extends true ? undefined : never) : never };
interface FlowScope<WIn, S> { input: WIn; outputs: OutputsOf<S> }

interface FlowBuilder<WIn, S extends Record<string, StepEntry<AnyTaskContract>>> {
  meta(m: DescriptorMeta<WIn>): this;

  step<Id extends string, C extends AnyTaskContract>(
    id: Id, contract: C,
    opts: {
      label?: string;                                        // defaults to contract.title (§1.5)
      bind: (scope: FlowScope<WIn, S>) => z.input<C["input"]>;  // compile-time coupling (doc 01/D15)
      when?: (input: WIn) => boolean;
      replay: "checkpoint" | "always-rerun";                 // REQUIRED
      probePolicy?: "always" | "retries-and-recovery-only";  // REQUIRED on a mutate contract (D17,
                                                             //   §b migration question); compile
                                                             //   error if omitted there, illegal on
                                                             //   a read/derive step. Doc 09 §5.
    },
  ): FlowBuilder<WIn, S & { [K in Id]: StepEntry<C> }>;

  /** Insert a gate node (D5) at this point in the sequence. */
  gate(id: string, decl: Omit<GateNode, "kind" | "id">): this;

  /** Decoration on ONE step — typed against that step's contract via the Steps map. */
  decorate<Id extends keyof S & string>(
    id: Id, hooks: TaskHooks<ContractOf<S[Id]>>, label: string): this;
  /** Instrumentation on EVERY step of this workflow. */
  instrument(hooks: TaskHooks<AnyTaskContract>, label: string): this;

  /** Per-system auth override (doc 01 §6.1's mechanism, attached HERE): default is the eager
   *  parallel-staggered Duo chain over the DERIVED session union; "on-first-use" logs in lazily
   *  at the first step whose contract touches that system. Replaces deferAuth + the 15-line
   *  hand-rolled auth step in 5 workflows. Keys are constrained to the derived union. */
  auth(overrides: Partial<Record<DerivedSystemOf<S>, "eager" | "on-first-use">>): this;

  build(): WorkflowDescriptor<WIn>;
}
```

- **Compile-time:** `bind` must return exactly `z.input` of the step's contract and can only read
  `input` and prior outputs (each `.step()` narrows the next binder's `outputs`). Rename a
  contract's output field → every consuming workflow fails `tsc` (charter target 2). A `when`
  step's output is `T | undefined` downstream — consumers are compile-forced to handle the skip.
- **Runtime:** the kernel re-parses the bound value through the contract's input schema before
  `run`, and the output through the output schema after (doc 01's walls; also exactly the resume
  entry validation of §5).
- **Decoration semantics** (hook types, same-task invariant, error attribution `decoratedBy`,
  middleware ordering) are doc 01 §4's, unchanged — this doc only owns *where they attach*:
  `.decorate` for one step, `.instrument` for every step of one workflow, kernel span hooks for
  every task everywhere (doc 03). Hooks are values in the descriptor module but may only
  type-import — the §1.4 import guard keeps the module client-safe.
- Task ids follow doc 01's slash grammar throughout: `ucpath/search-person-org`, never
  `ucpath.searchPersonOrg`. `SystemId` names are the REAL `src/systems/` dirs (D2):
  `new-kronos`/`old-kronos`, not `kronos`.

### 3.1 Task-authoring rule — navigation ownership (review 02 #9)

**Every task owns its own navigation: it must be runnable from any fresh page of its system's
session** (post-login landing state or another task's leftovers). A task that assumes "the page is
already on screen N of a wizard" is mis-factored. Consequences:

- **Wizard legs are atomic single tasks.** Page-state-coupled sequences — separations' Smart HR
  fill+submit (`workflow.ts:1114`), Kuali finalization (`:1153`) — are ONE task each, however
  long, because no resumable boundary exists mid-wizard.
- **Resume grain = task boundaries, only.** There is no mid-task checkpoint and no mid-task
  `startAt`; the engine never re-enters a half-finished page interaction.
- The coverage discipline is review-level (a task's first action navigates), backed structurally:
  since a parked/resumed run reacquires sessions from scratch (§4), any task that skips navigation
  fails its first live resume — visibly, at the task's own span.

---

## 4. The run-state machine (gates are run-state, not task internals — D5)

Tasks stay run-to-completion with bounded duration (doc 01's retry/timeout policy). Long waits —
OCR approval, oath-upload's child-signature watching, external signals — are **gate nodes** in the
descriptor sequence, owned by this state machine. Doc 03's `gate.opened`/`gate.resolved` events
are their wire form; this doc defines the semantics, doc 03 the encoding.

```
queued → claimed → validating → running(node i) ──────────────→ terminal
  ▲                    │            │        outcomes (doc 03 union): done | failed |
  │                    │            │          cancelled | discarded | interrupted
  │  gate resolved     │            ├─ gate node reached → PARKED(gate)
  ├────────────────────┼────────────┘
  │                    └─ entry validation fails → failed (§5.4 — before any browser)
  └─ requeue (bump / reassign / recovery)          crash-mid-write → recovery probe → done|retry|PARK (§5.6)
```

**Park semantics.** Reaching a gate node, the engine:

1. commits a checkpoint barrier (all completed step outputs durable — §5.7 ordering invariant);
2. emits `gate.opened` (doc 03 wire) — projections render the gate's `statusKey`
   (e.g. `approval` → `needsReview`), replacing today's `running/awaiting-approval` sentinels;
3. **RELEASES every browser session the run holds** (kernel policy, D5). A parked run owns no
   page, no context, no worker — the daemon is free or may exit. Parking for days is free.

**Resolution.** Per `resolvedBy`: `operator` (an approve/confirm route), `children-terminal`
(rollup — the i9-check coordinator, operation member rollups), `external` (a kernel watcher — the
oath-upload signature watch becomes a polling watcher that resolves the gate, not a fake step).
Resolution emits `gate.resolved` and re-enqueues the run with `startAt` = the node after the gate.
The fresh claim **reacquires sessions via the store SessionProvider** — login is idempotent
(`"logged-in" | "already-authenticated"`, doc 01/D15), so reacquisition is just the normal auth
path. Duo is cleared hands-off by Duo Autopilot inside the session provider's login for every run,
production included (charter §9) — MFA is not a gate and never parks a run.

---

## 5. Start-anywhere resumability

### 5.1 The tension, stated precisely

Input is constant, but task N's *task input* is usually `f(input, outputs of tasks < N)`.
"Start at task N" is only well-defined if the engine can produce those upstream outputs **or
refuse loudly**. Nothing in between — a guessed or defaulted upstream value is exactly the
silent-fallback class the root CLAUDE.md bans.

### 5.2 Mechanisms compared (honestly)

**A. Checkpoint replay (checkpointed run context, zod-validated at entry).** Persist every task's
schema-parsed output as a checkpoint. "Start at N" loads checkpoints for tasks < N, re-validates
each against its *current* output schema, runs N's `bind` + input parse.
*Pros:* no re-execution of side effects; works after crash; hand-supplied data validates through
the same schemas; serializability enforced for free (a Page handle can't pass a zod parse).
*Cons:* a checkpoint can go stale against the live system (**mitigated structurally by D8 —
§5.5**); schema evolution invalidates old checkpoints (loud refusal, but a refusal); needs a store.

**B. Re-derivation (recompute the prefix).** *Pros:* always consistent with live truth.
*Cons:* **disqualifying** as the general mechanism — write tasks are not idempotent (re-running a
Save = a duplicate HR transaction), and it forfeits exactly what resume-after-crash needs. Where
it *is* right: volatile read-guards (live-page dupe probes).

**C. Widened entry schemas (every upstream field optional-with-self-lookup).** Rejected outright —
it moves lookup logic into every task, makes every contract field optional (mushy types), and is
structurally a silent fallback: "missing because the pipeline broke" becomes indistinguishable
from "missing by design".

### 5.3 Recommendation: **A, with per-task replay policy (A/B hybrid at the task grain)**

Every task step declares `replay` explicitly — **no default**:

- `"checkpoint"` — output is a stable extracted fact (CRM signed date, resolved EID, a write
  receipt). Replayed on resume after re-validation **and the freshness walk (§5.5)**.
- `"always-rerun"` — output is volatile (live-page dupe probes) or a cheap pure derivation.
  Stored for audit but never replayed.

**Write gating derives from the contract, never a step flag (D7).** `TaskStep.write` does not
exist. A step whose contract has `effect: "mutate"` gets, automatically: refuse-to-re-execute when
its receipt checkpoint exists, no *blind* auto-resume into it (recovery runs the idempotency probe
FIRST — §5.6 #2 / D17), the REQUIRED `probePolicy` knob (above), and status as a freshness *sink* in
§5.5. Doc 01's per-effect `defineTask`
overloads make a mis-declared effect fail to compile where possible, with the factory's runtime
check as backstop — compile-time where possible, runtime-enforced always.

### 5.4 Exact failure behavior

Entry validation runs at claim time, **before any browser launches** (a doomed resume must not
spend a Duo). On failure the run lands terminal `failed` with:

```
ResumeValidationError: person-lookup run pl-104233-9f3e, start at "active-status":
  missing context "searching" (Searching → ucpath/search-person-org) — no checkpoint for this
  item and replay policy is "checkpoint".
  invalid context "cross-verify": output.record.ucpathEmployeeId — Invalid EID "1234"
  (checkpoint schema-hash mismatch: written by an older contract).
Fix: start from "searching", or supply injected data for the named steps
  (validated against each producing contract's output schema).
```

Every clause names: the entry step, the missing/invalid **field path**, the **task that should
have produced it** (step id + label + contract id), and the remediation. One error lists *all*
problems (no fix-one-refresh-repeat loops).

### 5.5 Checkpoint freshness (D8 — closes the stale-read→live-write hole)

The failure this kills (review 02 #2): separations attempt 1 checkpoints `ucpath-job-summary`; a
next-day retry at `kronos-search` replays it and would proceed automatically into the
`ucpath-transaction` write with yesterday's data. Charter-banned silent substitution.

- Every checkpoint records **`captured_at`** (§5.7).
- Every **read** contract whose output may feed a write declares **`freshness.maxAgeMs`** — a
  **mandatory field on ALL read contracts** (doc 01's contract shape, D3/D8). `Infinity` must be
  written explicitly with a justification comment; the §1.4 guard snapshots those.
- **The bind-graph walk.** At resume entry validation, the engine evaluates each pending step's
  `bind` (pure by rule) against the actual replayed checkpoint values wrapped in recording
  proxies, and placeholder proxies for not-yet-run steps. This records which step outputs each
  bind reads — the concrete edge set for THIS run. If a bind cannot be evaluated structurally
  (it computes on a placeholder), the engine assumes it depends on **all** upstream steps —
  conservative over-refusal, never under. It then computes reachability: does any **replayed**
  checkpoint feed, directly or transitively via later steps' mappings, a step whose contract is
  `effect:"mutate"` scheduled in this run?
- If yes and `now − captured_at > maxAgeMs`, the kernel **REFUSES loudly**:

```
CheckpointFreshnessError: separations run sp-091210-4c2e, start at "kronos-search":
  checkpoint "ucpath-job-summary" (ucpath/read-job-summary) captured 2026-07-16T17:02:11Z
  (age 18h04m, freshness.maxAgeMs 4h) feeds mutate step "ucpath-transaction"
  (ucpath/submit-termination) in this run — via kronos-search → ucpath-transaction.
Fix: re-run "ucpath-job-summary" (start there, or mark it always-rerun for this resume),
  or confirm an operator freshness override (recorded, single-resume scope).
```

- **Operator override path:** the dashboard surfaces the same facts (checkpoint, age, limit,
  consuming write step) and requires explicit confirmation per stale checkpoint. The override
  rides `RunEnvelope.freshnessOverride` (§2), is scoped to that single resume attempt (never
  persisted onto the item), and is recorded in the span stream as an audited note — provenance,
  not a default. Crash-mid-write runs the recovery idempotency probe first (§5.6 #2 / D17, mechanism
  in doc 09) regardless of overrides — it parks `needs-operator` only when that probe is
  indeterminate (`ambiguous`/`unknown`/throw), never blindly.

### 5.6 The four scenarios

1. **Retry a failed task.** Failure at step k ⇒ retry = new attempt, `startAt = k`. Checkpoints
   for steps < k with `replay:"checkpoint"` are validated + freshness-walked + loaded;
   `always-rerun` steps in the prefix re-execute (engine computes the rerun set); k re-runs.
   Input is the pristine stored input. Retrying *into* a mutate-contract step whose receipt
   exists ⇒ refuse with the receipt named.
2. **Resume after crash (probe-then-park, D17 — NOT always-park).** Recovery (lease-expiry path)
   finds the last checkpointed step; `startAt` = the first step without a checkpoint. If that step's
   contract is `effect:"mutate"`, the kernel does **not** auto-resume into the submit; instead it
   runs the mutate contract's **recovery idempotency probe FIRST** (doc 09's mechanism, referenced
   not redefined) and routes on the verdict: `present` → backfill the receipt (schema-validated, doc
   09 D19) + complete `done`, **no second submit**; `absent` → clear the intent, the write is safe to
   re-run from the probe; `ambiguous`/`unknown`/throw → park `needs-operator` ("write may have
   landed; verify in <system> then retry or mark done"). Always-park is **retired**: it never
   prevented a double-file, it only deferred everything to manual — probe-then-park prevents the
   double-file AND auto-resolves the confident cases, while the fail-closed `unknown → park` still
   honors "be very sure." Non-mutate steps auto-resume (worst case: a repeated read). Ordering
   invariant: checkpoint write commits (SQLite) **before** the task-end span is emitted; a "span says
   done, no checkpoint" state is impossible by construction and treated as corruption (loud) if ever
   observed.
3. **Operator-forced start-at-N with hand-supplied data.** The Edit Data successor: pick a start
   step, supply substitute outputs for missing upstream steps. `injected` rides the RunEnvelope
   as `{ [stepId]: unknown }`; each value is parsed with the **full output schema of the
   producing contract** (per-field injection parses through `schema.shape[field]`). Wrong ⇒ the
   §5.4 error with the zod path; right ⇒ the run proceeds exactly as if the step had run.
   Injected values are recorded as checkpoints flagged `source:"operator"`, with `captured_at` =
   injection time (they enter the freshness walk like any checkpoint).

   **Live Edit Data over checkpoints (operator directive, charter §12).** This is not only a
   start-anywhere affordance: for ANY stopped or parked run, the Edit Data tab shows the run's
   current checkpoint state **live** — every accumulated task output, keyed by step, as it exists
   in SQLite right now. The operator may edit any value there before resuming; an edit is exactly
   the `injected` mechanism above (parsed against the producing contract's schema — a bad edit is
   rejected loudly at save time, never at 2am mid-run; a good edit becomes a `source:"operator"`
   checkpoint with fresh `captured_at`). Editing checkpoint data in this tab is the supported way
   to correct a run's data mid-way; hand-editing SQLite or JSONL is not.
4. **Rerun with different input.** A new logical item ⇒ new `(workflow, item_id)` ⇒ **zero
   checkpoints by construction**. `injected` is rejected on a new-input run — the two affordances
   are separate endpoints so changed input can never silently ride stale context.

### 5.7 The checkpoint store — and resume scope (D9)

SQLite, beside the existing task store (live truth stays SQLite; JSONL stays audit). Reality
check from the as-built schema (`src/tracker/state/schema.ts:191,243,267`): **`tasks.id` is
`TEXT`**, and the logical-item key is **`(workflow, item_id)`** — the earlier
`INTEGER REFERENCES tasks(id)` sketch was wrong.

```sql
CREATE TABLE run_checkpoints (
  workflow     TEXT    NOT NULL,     -- ┐ the LOGICAL item — retries share it,
  item_id      TEXT    NOT NULL,     -- ┘ rerun-with-new-input gets a fresh one
  step_id      TEXT    NOT NULL,     -- descriptor step id
  attempt      INTEGER NOT NULL,
  run_id       TEXT    NOT NULL,     -- which run attempt wrote it (audit)
  output_json  TEXT    NOT NULL,     -- schema-parsed task output
  schema_hash  TEXT    NOT NULL,     -- hash of the contract's JSON-schema form
  captured_at  TEXT    NOT NULL,     -- D8 freshness anchor
  source       TEXT    NOT NULL DEFAULT 'task',   -- 'task' | 'operator'
  PRIMARY KEY (workflow, item_id, step_id, attempt)
);
```

- Latest attempt wins on load. `schema_hash` mismatch ⇒ the §5.4 refusal — never silent migration.
- The loader returns a discriminated `{ found: true, output, capturedAt } | { found: false,
  reason }` — no default parameter, no `?? {}` possible; the engine must branch.
- Span events carry checkpoint *summaries* (step, hash, byte size, capturedAt), never payloads.

**Resume scope — explicit (D9).** The checkpoint/resume model covers **rows with a real daemon
task only**: `single` rows and real `operation-member` rows. Explicitly excluded:

- **Operation coordinators** — display rows with no daemon task; they complete by member rollup
  (a `children-terminal` gate, §4), never by resume.
- **Display-only rows** — i9-check's task-less failed members (`data.displayOnly`): nothing to
  resume; delete is their only action, as today.
- **OCR per-page pipeline internals** — the OCR run is ONE task from the workflow model's view;
  its page pool keeps its own internal checkpointing (tiers, per-page retries), surfaced as
  notes (doc 03), never as workflow-level steps or checkpoints.

Resume grain within covered rows is **task boundaries only** (§3.1) — the descriptor's linear
step list is the resume vocabulary; anything that is not a step (gates, page pools, rollups) is
run-state, not a resumable position.

---

## 6. Trace + spans — what this doc owns (D10: schema lives in doc 03)

**Doc 03's discriminated-union event stream is THE wire contract** — event shapes, notes stream,
storage, SSE. This section keeps only the engine-side semantics that doc 02 owns:

- **Span identity + path grammar.** The proven trace id is kept byte-for-byte
  (`<code>-<HHMMSS>-<runId4>`, frozen once, root-prefix propagation, retry inherits it). Span
  identity is `(runId, attempt, spanPath)` with readable path-style ids — `pl-104233-9f3e`
  (run) → `pl-104233-9f3e/searching#2` (task, `#attempt`). `/` never appears in trace ids, so
  everything stays greppable.
- **What the engine brackets.** The engine opens/closes a task span around every step execution
  (a task IS a step — `ctx.step` is gone) and emits `gate.opened`/`gate.resolved` at §4's park
  and resolve points. Engine-owned phases (per-system auth, entry validation) are ordinary task
  spans with reserved keys (`auth:ucpath`) — the pre-first-step gap today's duration code infers
  becomes recorded time. Per-action attribution rides the **notes stream** with span-path
  addressing (D10 — action spans are not span events; doc 03 owns the encoding), so the timeline
  folds task/gate/run spans only.
- **Attempt semantics.** In-run kernel retries (doc 01's `RetryPolicy`) = attempt-suffixed task
  spans within the SAME run (`…/searching#2`). Cross-run retries (operator Retry, recovery) = a
  **new run** carrying `retryOf` on its envelope/`run.queued`, inheriting the trace id. The
  legacy `-N` display suffix is display-only formatting — never parsed, never identity.
- Everything else the old §4 specified (event fields, status folds, label resolution, storage,
  derivations like queue-wait and cancelled-reached-step) is doc 03's, by reference.

---

## 7. Adversarial self-review — how this rots, and the guard for each

| Rot vector | Mechanical guard |
|---|---|
| A new hand-list keyed by workflow ids appears in a component | descriptor-coverage ratchet: ≥3 descriptor ids as literal keys outside allowlisted files fails (§1.4) |
| Labels drift — a third label layer sneaks in beside §1.5's two | guard asserts every step of every descriptor resolves a label from contract-title/step-label alone; `formatStepName` fallback `console.warn`s in dev; e2e stub run asserts zero fallback hits |
| Resume silently substitutes data (`?? {}` on checkpoint load) | loader returns discriminated `{found}` union (no defaultable shape) + `fail-loud-catch-default` ratchet extended to `temp_src/` from day one |
| Stale checkpoint rides into a live write | D8 structural chain: mandatory `freshness.maxAgeMs` on read contracts (§1.4 #3 — a contract without it fails the factory AND the guard), `captured_at` NOT NULL in the store, the bind-graph walk with conservative fallback, override scoped to one resume + audited |
| Checkpoint schema drift "temporarily" bypassed | `schema_hash` check lives inside the single store primitive; unit test pins mismatch ⇒ throw; no bypass parameter exists |
| Descriptor/impl drift (contract with no store impl, or vice versa) | contract objects imported by value (rename = compile error); boot-time impl resolution throws; §1.4 #3 pins it at CI |
| Write gating re-declared per step (the deleted `write` flag returns) | `TaskStep` has no such field to set; mutate-effect contracts are enumerated in the coverage guard's snapshot so adding/removing one is a visible review diff; effect misdeclaration guards are doc 01 §8's |
| A gate becomes a fake polling task again (browser held for days) | gates are the only descriptor vocabulary for waits; emit-time validation (doc 03) rejects undeclared gate ids; a task exceeding its bounded duration fails loud instead of parking |
| `replay` mis-set to make resume "convenient" | REQUIRED field (compile error if omitted); `always-rerun` vs `checkpoint` choices are visible in the descriptor diff, not buried in handlers |
| Crash-mid-write auto-resumes straight into a duplicate submit | recovery runs the mutate contract's idempotency probe FIRST (§5.6 #2 / D17) — `present`→backfill (schema-validated, doc 09 D19), `absent`→retry, else park; there is no auto-resume path directly into a submit, and `probePolicy` is a REQUIRED mutate-step field (compile error if omitted) so the §b decision can't be skipped |
| Actions bypass the wrapped helpers (attribution goes dark) | inline-selector + raw-page-API ban extended to `temp_src/` (`page.` members allowlisted only inside `stores/*/`) |
| Span step-id typos | engine accepts only the descriptor-derived step-id union (compile-time); emit-time assert for dynamic paths |
| Stub lane quietly narrows to happy-path only | derived stubs cover exactly the `example` path; the hand-scripted failure/cancel/parallel scenarios live in the e2e stub lane with their own coverage list (D3) — deleting one fails the lane's scenario manifest check |
| The old and new systems' registries drift during migration | transition guard: every id in old `WORKFLOW_LOADERS` that has migrated must be absent there and present in `DESCRIPTORS` — one list owns each workflow at any moment |

---

## 8. Worked example — person-lookup (the Phase-2 vertical slice)

The first step **imports doc 01 §9.1's `ucpath/search-person-org` contract verbatim** (D16 — one
definition, this doc consumes it): input is the `by-name`/`by-eid` discriminated union, output is
`{ results: Candidate[], selected: Candidate | null }`.

```ts
import { UcpathSearchPersonOrg } from "../../domain/contracts/ucpath/search-person-org.js"; // doc 01 §9.1
import { CrmFindOnboardingRecord, CrmReadOnboardingDates } from "../../domain/contracts/crm/…";
import { DeriveActiveCheckOutcome } from "../../domain/contracts/extraction/…";   // service store (D4)

export const personLookupDescriptor = workflow("person-lookup", PersonLookupInput)
  .meta({ code: "pl", label: "Person Lookup", icon: "Search", category: "Search",
          surface: { shape: "single" },
          inputSubject: (i) => ("emplId" in i ? "eid" : "name"),
          verdicts: { "not-found": { label: "Not found", tone: "warning" },
                      "inactive":  { label: "Inactive",  tone: "warning", tag: true } },
          surfaces: { inputRun: {
            placeholder: "Enter EIDs or names, semicolon-separated (e.g. 10873698; Battistessa, Johnnie)",
            parse: parsePersonLookupInputs } } })
  .step("searching", UcpathSearchPersonOrg, {           // ucpath/search-person-org (doc 01 §9.1)
    replay: "checkpoint",
    bind: ({ input }) => ("emplId" in input
      ? { kind: "by-eid", emplId: input.emplId }
      : { kind: "by-name", name: input.name, keepNonHdh: input.keepNonHdh ?? false }) })
  .step("cross-verify", CrmFindOnboardingRecord, {      // crm/find-onboarding-record
    label: "Cross Verification", replay: "checkpoint",
    bind: ({ input, outputs }) => ({                    // outputs.searching: typed!
      eid: require(outputs.searching.selected, "searching", "selected").emplId,
      name: nameOf(input, outputs.searching) }) })      // require(): fail-loud on null, names the step
  .step("active-status", DeriveActiveCheckOutcome, {    // extraction/derive-active-check-outcome (pure)
    label: "Active Status", replay: "always-rerun",
    bind: ({ input, outputs }) => ({ person: outputs.searching,
      crm: outputs["cross-verify"], keepNonHdh: input.keepNonHdh ?? false }) })
  .step("crm-dates", CrmReadOnboardingDates, {          // crm/read-onboarding-dates
    label: "CRM Dates", when: (i) => i.includeCrmDates === true, replay: "checkpoint",
    bind: ({ outputs }) => ({
      eid: require(outputs.searching.selected, "searching", "selected").emplId }) })
  .build();
// Derived, not declared: systems = ["ucpath", "crm"] (contract id prefixes; service systems excluded).
```

Projections that exist with **zero further edits**: rail entry + icon + category, input-run panel
with the parser, session-card label "Person Lookup", pipeline chips Searching → Cross
Verification → Active Status (→ CRM Dates when flagged), verdict-driven `Not found`/`Inactive`
statuses, e2e happy-path stub emitting the contracts' canonical examples, daemon loader.

**Resume scenario, traced end-to-end.** Input `{ name: "Battistessa, Johnnie" }`; run
`pl-104233-9f3e`; `searching` completes (checkpoint: `{ results: […], selected: { emplId:
"10873698", … } }`, hash `h1`, `captured_at` 10:42:41, spans `…/auth:ucpath#1`, `…/searching#1`
closed `ok`); `cross-verify` throws mid-CRM-search (span `…/cross-verify#1` closed `failed`, run
terminal `failed`).

Operator clicks **Retry**:

1. Engine resolves the logical item `(person-lookup, item)` stored input + `startAt =
   "cross-verify"` (first un-checkpointed step); new run carries `retryOf` (§6).
2. Entry validation (pre-browser): `searching` checkpoint found, `h1` matches the current
   contract's output hash, payload re-parses. **Freshness walk (§5.5):** the replayed checkpoint
   feeds `cross-verify` and `active-status` — no step in this workflow has `effect:"mutate"`, so
   there is no freshness sink and the walk passes trivially. (In separations the same walk is
   what refuses the stale `ucpath-job-summary` → `ucpath-transaction` path — §5.5's error.)
3. New attempt: spans `…/auth:crm#2`, `…/cross-verify#2` (per-action attribution in the notes
   stream, doc 03). Output checkpoints (attempt 2, fresh `captured_at`).
4. `active-status` is `always-rerun`: executes fresh over `{ outputs.searching (replayed),
   outputs["cross-verify"] (new) }` — pure, no browser. `crm-dates` skipped (`when` false ⇒
   span end `skipped`).
5. Run terminal `done`. Timeline = fold over task spans; the retry attempt renders as `#2` chips;
   the trace id shown is still `pl-104233-9f3e` (inherited — logical-operation continuity).

**Failure variant**: operator forces `startAt: "active-status"` on a *fresh* item (no
checkpoints), injecting only `{ searching: { results: [], selected: null } }` — entry validation
throws the §5.4 error naming `cross-verify: missing context (no checkpoint, nothing injected)`
and, from `require()`, `searching.selected` null where `cross-verify`'s bind needs an EID.
Nothing launched, no Duo spent, no partial run row.

---

## 9. Open questions for the operator / orchestrator

1. **Checkpoint retention** — prune with the tracker's 7-day JSONL policy, or keep until the
   logical item is deleted? (Resume across days argues for item-lifetime; freshness (§5.5) makes
   old checkpoints safe-but-refusable rather than dangerous.)
2. **Write-task crash disambiguation — RESOLVED (D17), no longer open.** Every mutate contract ships
   a paired idempotency `probe` (doc 09's `writeSafety.idempotency.probe`), and crash recovery runs
   it FIRST (§5.6 #2): `present`→backfill+`done`, `absent`→retry-safe, `ambiguous`/`unknown`/throw→
   park. The earlier "always park `needs-operator`" default is retired — probe-then-park prevents the
   double-file AND auto-resolves the confident cases. The remaining §b migration decision is the
   per-workflow *pre-write* `probePolicy` knob (doc 09 §5, on the mutate step node), not this
   question.
3. **Injected-data surface scope** — full "start at any step with substitute outputs" UI from day
   one, or engine support first with Edit-Data-shaped UI layered later?
4. **Descriptor `version` field** — add a per-workflow schema version now (stamped into
   checkpoints/spans) or rely purely on `schema_hash`?
5. **In-run parallelism** (today's `ctx.parallel`) — model as sibling task spans under one step
   id, or as first-class DAG edges (`after:` instead of array order)? Array order suffices for
   every current workflow; DAG is a widening we can defer. (A DAG would also refine the §5.5
   bind-graph walk from recorded edges to declared ones.)
