# 01 — The Task Contract & Per-System Task Stores

Status: **Phase 0 revised design — 2026-07-21 external-review corrections integrated.** Conforms
to `00-charter.md` and the binding reconciliation memo `04-reconciliation.md`. The abandoned
Step-0 spike is evidence only and has been deleted; all three effect overloads must be re-proved.

## Ownership (D1 — this doc owns / this doc references)

| This doc **owns** (siblings reference, never redefine) |
|---|
| The task contract and **contract/impl split** (`defineTaskContract` + `defineTask`), system/workflow namespace grammar + closed `SystemId` (D2/D3/D42) |
| Error taxonomy (`TaskError`, declared `errorCodes`) |
| Effect classes + dry-run mechanics (D6/D7), `freshness` + provenance contract fields (D8/D34), and the content-addressed read-artifact boundary (D45) |
| Retry policy |
| Decoration (`decorateTask`, hook semantics, error-propagation rule) |
| Task stores—browser, service, and pure workflow mini-stores (D4/D42), session providers + the single login signature, shared leaf-code homes (`stores/common/`) |
| The task **boundary** statement — tasks are bounded; what is NOT a task (D5's task side) |

| This doc **references** (owner) |
|---|
| Workflow builder API (the single API), descriptor shape, RunEnvelope, run-state machine incl. **gates/parks**, checkpoint/resume + the freshness enforcement walk → **doc 02** |
| Span/event wire schema, notes stream, completion (fan-out/approval) union, storage + SSE → **doc 03** |
| `WriteSafety<In, Out, Proof>` shape attached to `CommitTaskContract` (typed proof/verify + idempotency probe + key, D22/D31) → **doc 09** |

Grounding (read, not imagined): `src/core/kernel/types.ts` (WorkflowConfig/Ctx/SystemConfig),
`src/workflows/person-lookup/workflow.ts` (the `dataString()` untyped-blob hacks, screenshot
sprinkling, `ctx.data.crmMatch as string`), `src/workflows/person-lookup/lookup.ts` +
`src/systems/ucpath/person-org-summary.ts` (the real search shapes the worked example wraps),
`src/workflows/oath-signature/workflow.ts:240-300` (the deferAuth + `loginToUCPath` + `if (!ok)
throw` boilerplate), `src/infra/auth/duo-login-flows.ts` (the well-factored login table — the shape
to imitate), `src/systems/ucpath/selectors.ts` (registry pattern + `// verified` stamps),
`src/systems/onbase/LESSONS.md` (single-app-session-per-identity constraint),
`src/workflows/ocr/orchestrator.ts:1562` (`operationTraceCode` — the cautionary stringly
re-encoding switch).

---

## 1. What today's code teaches us (the problems the contract must kill)

1. **Systems are loose function bags.** `src/systems/ucpath/person-org-summary.ts` exports raw
   `(page, args) => result` functions with hand-written TS types. Nothing declares which system
   session a function needs, whether it mutates, what it throws, or how to retry it. Callers
   (workflows) re-invent all of that per call site.
2. **Workflow handlers are god functions.** person-lookup's handler + step functions are ~800 lines
   mixing navigation, business rules, screenshot policy, and tracker stamping. Output flows through
   `ctx.updateData` — an untyped `Record<string, unknown>` string blob read back with
   `dataString(...)` / `as string` casts. The compiler protects nothing across steps.
3. **Auth is copy-pasted.** `deferAuth: true` + a hand-rolled `ctx.step("ucpath-auth", ...)` +
   `loginToUCPath(page, ...)` + `if (!ok) throw` appears near-identically in 5 workflows.
4. **Names are re-encoded stringly.** `operationTraceCode` re-declares codes that `defineWorkflow`
   already owns; a new workflow compiles fine with the switch stale.
5. **What is already right:** the selectors registries (JSDoc + `// verified` dates + catalog),
   `DUO_LOGIN_FLOWS` (one table, uniform adapter signature, both smoke test and live test derive
   from it), `ctx.retry`'s signal-aware linear backoff, and the leaf drivers themselves (iframe
   handling, employment-instance expansion). These **port verbatim** and get wrapped — the wrapping
   shims themselves (e.g. the login-result adapter, §6.1) are new code and are named as such.

---

## 2. The Task contract

### 2.1 Core types

```ts
// temp_src/domain/contracts/base.ts — bundle-safe: imports zod ONLY (guard, §8)
import { z } from "zod";

/**
 * Closed union — adding a system is a deliberate one-line edit here (D2).
 * Browser systems are named after the REAL src/systems/ directories
 * (old-kronos = UKG Kronos, new-kronos = WFD/Dayforce — NOT "kronos"/"ukg").
 * Service systems (D4) host system-less work; see §3.4.
 */
export type BrowserSystemId =
  | "ucpath" | "crm" | "onbase" | "kuali" | "servicenow"
  | "i9" | "new-kronos" | "old-kronos" | "sharepoint";
export type ServiceSystemId = "extraction" | "ocr" | "roster";
export type SystemId = BrowserSystemId | ServiceSystemId;
/** Pure workflow-specific mini-store namespace; registry coverage validates the id against a real
 * descriptor without making domain import workflows. */
export type WorkflowStoreId = `workflow:${string}`;
export type TaskStoreId = SystemId | WorkflowStoreId;

/** Task ids are namespaced by store: "ucpath/search-person-org" or
 * "workflow:verify/merge-enrichment" (D2 slash grammar). */
export type TaskId<S extends TaskStoreId = TaskStoreId> = `${S}/${string}`;

/** Checkpoints/outboxes cross canonical JSON. Browser objects, Date, Map, class instances, etc.
 * are contract errors, not values the persistence layer guesses how to serialize. */
export type JsonValue = null | boolean | number | string | JsonValue[] |
  { readonly [key: string]: JsonValue };
type IsAny<T> = 0 extends (1 & T) ? true : false;
export type CanonicalJsonSchema<S extends z.ZodType> =
  IsAny<z.output<S>> extends true ? never :
  z.output<S> extends JsonValue ? S : never;

/**
 * D8 (contract side): mandatory on EVERY read contract. How long a
 * checkpointed output of this read may age before it is allowed to feed a
 * commit task on resume. `Infinity` is legal but must be written literally
 * and justified in an adjacent comment (grep ratchet, §8). The enforcement
 * declared-dependency freshness walk is kernel behavior owned by doc 02.
 */
export interface Freshness {
  /** Default for facts in this output; field-path overrides may narrow it. */
  defaultMaxAgeMs: number;
  /** Default is forbidden. `audited` must be explicit and is never legal for identity,
   * idempotency-key, or write-proof fields. */
  defaultOverride?: "forbidden" | "audited";
  byField?: Readonly<Record<string, {
    maxAgeMs: number;
    override?: "forbidden" | "audited";
  }>>;
}

export interface ProvenancePolicy {
  /** `live` means this task actually observed the authoritative source during this execution.
   * `derived` carries all input source facts forward and uses their oldest observedAt. */
  default: "live" | "derived";
  byField?: Readonly<Record<string, "live" | "derived">>;
}

/**
 * `prepare` mutates only ephemeral browser state. `commit` is the sole class
 * allowed to call an external-write primitive. A prepare contract may appear
 * only as the first arm of a transaction node (doc 02), never as a resumable
 * standalone step.
 */
export type EffectClass = "read" | "prepare" | "commit";
```

```ts
// temp_src/base/task.ts — server-side (may import Playwright types)
export interface SessionNeed<S extends BrowserSystemId = BrowserSystemId> {
  system: S;
  /**
   * OnBase-style constraint: one live app session per identity. Enforced by a
   * CROSS-PROCESS SQLite lease from day one (D15) — daemons are separate OS
   * processes (src/cli-daemon.ts), so an in-process queue cannot serialize
   * them. The kernel acquires the lease BEFORE opening the context and retains
   * it until that authenticated context is closed. A task boundary does not
   * release an identity-exclusive lease while the context remains alive.
   * Ported knowledge:
   * src/systems/onbase/LESSONS.md ("single app session per identity ...
   * another-session contention").
   */
  exclusive?: true;
  /** Playwright download capture (today's SystemConfig.acceptDownloads). */
  acceptDownloads?: true;
}

export interface RetryPolicy {
  /** Total attempts including the first. Capped by a ratchet (§8) at 3. */
  attempts: 2 | 3;
  backoffMs: number;
  /**
   * The ONLY selector is "transient": errors flagged transient by the page
   * proxy (Playwright TimeoutError, net::ERR_*) or thrown as
   * ctx.fail(code, ..., { transient: true }). Business failures
   * ("eid-not-found") are NEVER retried — retrying a wrong answer is a
   * silent fallback in disguise.
   */
  retryOn: "transient";
}
```

### 2.2 The contract/impl split (D3)

A task is **two files**:

- **contract**—plain data, bundle-safe, in the matching system/service/workflow contract namespace:
  id, zod
  input/output, `title`, `effect`, `errorCodes`, `freshness` (reads), write safety (commits),
  and a **mandatory `example` output**. Descriptors (doc 02) and the dashboard import contracts
  ONLY. E2e stubs derive their **happy path** from `example` (schema-parsed); failure / cancel /
  parallel-worker scenarios REMAIN hand-scripted in the stub lane — examples cannot express them.
- **impl**—`run` + session needs + read retry, in the matching store's `tasks/`,
  imports Playwright. `defineTask(contract, impl)` binds them; the store is the only impl registry.

```ts
// temp_src/domain/contracts/base.ts (continued)
export interface TaskContractBase<
  Id extends TaskId,
  In extends z.ZodType,
  Out extends z.ZodType,
  Codes extends readonly [string, ...string[]],
> {
  id: Id;
  /**
   * Human label. This is the DEFAULT for the descriptor's step.label (D16);
   * the only override layer is the operator presentation override, and the
   * precedence rule is stated once, in doc 02.
   */
  title: string;
  input: In;
  output: CanonicalJsonSchema<Out>;
  /** Declared error taxonomy. ctx.fail() only accepts these codes. */
  errorCodes: Codes;
  /** Declared secret names; shape/accessor owned by doc 11. Empty/absent means none. */
  requires?: readonly SecretName[];
  /**
   * Mandatory canonical output value. A guard parses it through `output`
   * (§8); the e2e stub lane emits it as the task's happy-path response.
   */
  example: z.input<Out>;
}

export interface ReadTaskContract<Id extends TaskId, In extends z.ZodType,
  Out extends z.ZodType, Codes extends readonly [string, ...string[]]>
  extends TaskContractBase<Id, In, Out, Codes> {
  effect: "read";
  freshness: Freshness;                    // MANDATORY on every read (D8)
  provenance: ProvenancePolicy;             // MANDATORY; prevents transform-based freshness laundering
  /** Downloads/generated files are allowed only as content-addressed cache artifacts through
   * the kernel writer. Mutable append/update targets are not read-task effects. */
  artifacts?: "content-addressed";
}

export interface PrepareTaskContract<Id extends TaskId<BrowserSystemId>, In extends z.ZodType,
  Out extends z.ZodType, Codes extends readonly [string, ...string[]]>
  extends TaskContractBase<Id, In, Out, Codes> {
  effect: "prepare";
  /**
   * Browser-page mutation only: navigate and stage fields. It has no external
   * mutation capability in ctx and is legal only inside a transaction node.
   */
  checkpoint: "in-memory-only";
}

export interface CommitTaskContract<Id extends TaskId<BrowserSystemId>, In extends z.ZodType,
  Out extends z.ZodType, Proof extends z.ZodType,
  Codes extends readonly [string, ...string[]]>
  extends TaskContractBase<Id, In, Out, Codes> {
  effect: "commit";
  /** Required and non-optional. Shape owned by doc 09. */
  writeSafety: WriteSafety<In, Out, Proof>;
}

/** `const Codes` (TS5) keeps errorCodes as a literal tuple — without it the
 *  union collapses to string[] and ctx.fail() would accept anything (D15).
 *
 *  `defineTaskContract` uses one overload per effect. The abandoned Step-0
 *  spike was removed on 2026-07-21; this three-effect API must be re-proved in
 *  the new Phase-1 type spike before implementation. */
type Sealed<T> = T & { readonly __sealed: true };
export type SealedReadContract<Id extends TaskId, In extends z.ZodType,
  Out extends z.ZodType, Codes extends readonly [string, ...string[]]> =
  Sealed<ReadTaskContract<Id, In, Out, Codes>>;
export type SealedPrepareContract<Id extends TaskId<BrowserSystemId>, In extends z.ZodType,
  Out extends z.ZodType, Codes extends readonly [string, ...string[]]> =
  Sealed<PrepareTaskContract<Id, In, Out, Codes>>;
export type SealedCommitContract<Id extends TaskId<BrowserSystemId>, In extends z.ZodType,
  Out extends z.ZodType, Proof extends z.ZodType,
  Codes extends readonly [string, ...string[]]> =
  Sealed<CommitTaskContract<Id, In, Out, Proof, Codes>>;

export function defineTaskContract<
  Id extends TaskId, In extends z.ZodType, Out extends z.ZodType,
  const Codes extends readonly [string, ...string[]],
>(c: ReadTaskContract<Id, In, Out, Codes>): SealedReadContract<Id, In, Out, Codes>;
export function defineTaskContract<
  Id extends TaskId<BrowserSystemId>, In extends z.ZodType, Out extends z.ZodType,
  const Codes extends readonly [string, ...string[]],
>(c: PrepareTaskContract<Id, In, Out, Codes>): SealedPrepareContract<Id, In, Out, Codes>;
export function defineTaskContract<
  Id extends TaskId<BrowserSystemId>, In extends z.ZodType, Out extends z.ZodType, Proof extends z.ZodType,
  const Codes extends readonly [string, ...string[]],
>(c: CommitTaskContract<Id, In, Out, Proof, Codes>): SealedCommitContract<Id, In, Out, Proof, Codes>;
// impl body freezes + fails loud at module load (validation below).

/** The `Any*Contract` aliases used from here on are the SEALED effect-specific
 *  forms with generics erased to their bounds:
 *    AnyReadContract   = SealedReadContract<TaskId, z.ZodType, z.ZodType, readonly [string, ...string[]]>
 *    AnyPrepareContract = SealedPrepareContract<…same bounds…>
 *    AnyCommitContract  = SealedCommitContract<…same bounds…, z.ZodType, …codes…>
 *    AnyContract        = AnyReadContract | AnyPrepareContract | AnyCommitContract
 *  That union is exactly doc 02 §3's `AnyTaskContract`. */
```

`defineTaskContract` freezes the object and **fails loud at module load** on: id not matching
the system/workflow namespace grammar, unknown system prefix, malformed `workflow:<id>`, empty
`errorCodes`, `example`
failing `output.parse`, output/proof not canonical-JSON round-trippable, or a read contract missing
`freshness`/`provenance`. `CanonicalJsonSchema` rejects `any` and known non-JSON output types at
compile time; the factory
round-trip is the runtime backstop. A **type-level test** pins that
`ctx.fail("undeclared-code", …)` fails `tsc` (D15).

```ts
// temp_src/base/task.ts (continued) — the impl side + the binding factory
export type NamespaceOf<C> =
  C extends { id: `${infer S extends TaskStoreId}/${string}` } ? S : never;
export type BrowserSystemOf<C> = Extract<NamespaceOf<C>, BrowserSystemId>;
export type SessionsFor<C> = [BrowserSystemOf<C>] extends [never]
  ? readonly []
  : readonly [SessionNeed<BrowserSystemOf<C>>];
type BaseReadCtxFor<C extends AnyReadContract> = [BrowserSystemOf<C>] extends [never]
  ? NamespaceOf<C> extends WorkflowStoreId
    ? PureTaskCtx<C["errorCodes"]>
    : ServiceTaskCtx<C["errorCodes"]>
  : ReadTaskCtx<BrowserSystemOf<C>, C["errorCodes"]>;
export type ReadCtxFor<C extends AnyReadContract> = BaseReadCtxFor<C> &
  (C extends { artifacts: "content-addressed" }
    ? { artifacts: ContentAddressedArtifactWriter }
    : { artifacts?: never });

export interface ReadTaskImpl<C extends AnyReadContract> {
  sessions: SessionsFor<C>; // browser store must name its own system; service/workflow store must be []
  retry?: RetryPolicy;
  /** Receives the PARSED input (z.output — defaults/transforms applied);
   *  returns a pre-parse value (z.input of the output schema) that the
   *  kernel parses through contract.output before anything downstream sees it. */
  run: (args: { input: z.output<C["input"]>; ctx: ReadCtxFor<C> })
    => Promise<z.input<C["output"]>>;
}
export interface PrepareTaskImpl<C extends AnyPrepareContract> {
  sessions: readonly [SessionNeed<BrowserSystemOf<C>>];
  retry?: never; // transaction node owns whole-pair retry before a fence; never retry half-filled page state
  run: (args: { input: z.output<C["input"]>; ctx: PrepareTaskCtx<BrowserSystemOf<C>, C["errorCodes"]> })
    => Promise<z.input<C["output"]>>;
}
export interface CommitTaskImpl<C extends AnyCommitContract> {
  sessions: readonly [SessionNeed<BrowserSystemOf<C>>];
  /** A commit attempt is never generically retried; doc 09 owns recovery. */
  retry?: never;
  run: (args: { input: z.output<C["input"]>; ctx: CommitTaskCtx<BrowserSystemOf<C>, C["errorCodes"]> })
    => Promise<z.input<C["output"]>>;
}

/** Per-effect overloads (D7): pairing a commit contract with a read-shaped
 *  impl (or vice versa) fails to compile — the ctx types differ. This is
 *  "compile-time where possible"; the factory's runtime checks are the
 *  always-on backstop. */
export function defineTask<C extends AnyReadContract>(contract: C, impl: ReadTaskImpl<C>): Task<C>;
export function defineTask<C extends AnyPrepareContract>(contract: C, impl: PrepareTaskImpl<C>): Task<C>;
export function defineTask<C extends AnyCommitContract>(contract: C, impl: CommitTaskImpl<C>): Task<C>;

export type Task<C extends AnyContract> =
  Readonly<{ contract: C; impl: ImplFor<C> }> &
  { readonly __task: true };

export type ImplFor<C extends AnyContract> =
  C extends AnyReadContract ? ReadTaskImpl<C> :
  C extends AnyPrepareContract ? PrepareTaskImpl<C> :
  C extends AnyCommitContract ? CommitTaskImpl<C> : never;

export type TaskInput<T>  = T extends { contract: { input:  infer I extends z.ZodType } } ? z.input<I>  : never;
export type TaskOutput<T> = T extends { contract: { output: infer O extends z.ZodType } } ? z.output<O> : never;
```

**`z.input` vs `z.output` (D15, review #4):** step input mappings produce `TaskInput<T>` =
`z.input` — a field with `.default(false)` is *omittable* at the mapping site; `run` receives the
parsed `z.output` value with defaults and transforms applied. Conflating the two (`z.infer`
everywhere) would make every defaulted field required in mappings and defeat transforms.

### 2.3 The task ctx (narrow by construction)

```ts
export interface TaskCtxCommon<Codes extends readonly string[]> {
  signal: AbortSignal;
  log: TaskLogger;                             // structured; auto-tagged with taskId + span
  /**
   * Typed fail-loud throw. Produces a TaskError whose message names the task
   * and the offending value:
   *   ctx.fail("eid-not-found", `no Person Org row for EID ${input.emplId}`,
   *            { subject: input.emplId })
   * → "[ucpath/search-person-org] eid-not-found: no Person Org row for EID 10694136"
   */
  fail(code: Codes[number], message: string,
       opts?: { subject?: string; transient?: boolean; cause?: unknown }): never;
  /** Observational data-provenance points (port of today's ctx.recordData). */
  recordData(point: DataPoint | DataPoint[]): void;
}

export interface PureTaskCtx<Codes extends readonly string[]>
  extends TaskCtxCommon<Codes> {} // workflow transforms: no page/artifact/mutation

export interface ServiceTaskCtx<Codes extends readonly string[]>
  extends TaskCtxCommon<Codes> {} // service I/O is contract-declared; no page/mutation

export interface ArtifactRef {
  id: `sha256:${string}`;
  sha256: string;
  bytes: number;
  mediaType: string;
}
export interface ContentAddressedArtifactWriter {
  /** Writes temp → fsync → atomic rename under the artifact root. Same bytes = same path. */
  put(source: Uint8Array | NodeJS.ReadableStream,
      meta: { mediaType: string }): Promise<ArtifactRef>;
  /** Reads by validated ref; contracts never receive or expose an operator filesystem path. */
  open(ref: ArtifactRef): Promise<NodeJS.ReadableStream>;
}

export interface BrowserTaskCtx<S extends BrowserSystemId, Codes extends readonly string[]>
  extends TaskCtxCommon<Codes> {
  /** Only the declared browser system; cross-system page access is a compile error. */
  page(system: S): Promise<Page>;
  screenshot(label: string): Promise<void>;
}

export interface ReadTaskCtx<S extends BrowserSystemId, Codes extends readonly string[]>
  extends BrowserTaskCtx<S, Codes> {}

export interface PrepareTaskCtx<S extends BrowserSystemId, Codes extends readonly string[]>
  extends BrowserTaskCtx<S, Codes> {} // no external mutation capability

export interface CommitTaskCtx<S extends BrowserSystemId, Codes extends readonly string[]>
  extends BrowserTaskCtx<S, Codes> {
  /** Only capability that can invoke an audited external-write primitive. */
  mutation: MutationCapability;
}
```

**What TaskCtx deliberately does NOT have:** `updateData` (the untyped blob — display fields become
projections of typed task outputs, doc 03), `step` (the graph node owns orchestration), `delegateTo` (delegation
is workflow-level composition, doc 02), free-form `retry` (retry is declared, kernel-executed),
and **any wait/park primitive** (§2.6).

### 2.4 Error taxonomy

```ts
export class TaskError extends Error {
  readonly taskId: string;
  readonly code: string;          // ∈ the task's declared errorCodes, or "unhandled"
  readonly subject?: string;      // the offending value: EID, doc id, filename, selector intent
  readonly transient: boolean;    // retry eligibility — false unless proven transient
  readonly decoratedBy?: string;  // set when a before/after hook (§4) threw
  /** Secondary failures from onError hooks — NEVER replaces the base error (D15). */
  readonly hookErrors?: readonly { hook: string; error: unknown }[];
}
```

- The kernel wraps any non-`TaskError` escaping `run` as `code:"unhandled"`, `transient:false`,
  preserving `cause`. Nothing escapes without a task name attached — a trace line alone identifies
  the broken task (charter target #1).
- `instanceof`/`code` branching replaces today's ad-hoc `WorkflowError` subclasses; the two real
  branching cases (`EmplIdNotRecognizedError`, `RetryPageError`) become declared codes.
- Message contract is pinned by a unit test: `[<taskId>] <code>: <message>`.
- **The base TaskError always propagates.** A failing `onError` hook attaches to `hookErrors`;
  it can never replace `"submit-failed"` with `"decorator-failed"` (§4.1, pinned by test).

### 2.5 Identity & naming scheme

- `id = "<system>/<verb-object>"`, kebab-case (D2): `ucpath/search-person-org`,
  `onbase/upload-document`, `crm/read-onboarding-record`,
  `extraction/extract-pdf-fields`, `ocr/read-form-pages`, `roster/match-spreadsheet`.
- Verb prefixes are meaningful: `read-`/`search-`/`list-`/`extract-` ⇒ `effect:"read"`;
  `fill-`/`stage-` ⇒ `effect:"prepare"`; `save-`/`submit-`/`upload-`/`create-`/`update-`/`delete-`
  ⇒ `effect:"commit"`. `fill-and-submit-` is forbidden: it must become a transaction pair.
  A ratchet test (§8) enforces verb↔effect agreement so a misdeclared effect can't hide.
- A codegen'd `KnownTaskId` union — derived from the **contract barrels**
  (`domain/contracts/*/index.ts`) at build time, like `schemas:export` — gives descriptor
  projections and the dashboard a closed type to key on. Bundle-safe by construction: it is
  generated from files that themselves import only zod.

### 2.6 The task boundary — tasks are bounded; waits are not tasks (D5)

**A task is a run-to-completion Promise with bounded duration** (minutes, not hours). The executor
races every task against the immutable run snapshot's `timeouts.taskMs` and the run AbortSignal;
transactions additionally have `timeouts.transactionMs`. Browser timeout poisons/releases the
lease; service SDK/file operations must honor the same signal. A timeout before a fence may restart
preflight; after a fence it enters doc 09 recovery and is never a generic retry. The things
today's code does that do NOT fit that shape are explicitly **not tasks**:

- **Long waits — OCR approval, child-signature watching, external signals** (oath-upload's
  `subscribeToApproval` park + hours-long wait-signatures watch) are **gate nodes** declared in the
  descriptor and owned by **doc 02's run-state machine**; their wire form is doc 03's
  `gate.opened`/`gate.resolved` events. A task never contains an unbounded poll.
- **Session policy at a park (kernel rule, stated here because stores implement it):** a parked
  run **RELEASES its browser sessions** — holding a Duo'd UCPath page across an overnight approval
  wastes a browser and rots the session anyway. On resume the kernel reacquires via the store's
  session provider; `login` is idempotent (§6.1), so reacquisition is just another login call that
  usually short-circuits to `"already-authenticated"` or re-runs Duo. Exclusive leases (§2.1) are
  released with the session.
- **Duo is fully automated — never a gate (charter §9).** Duo Autopilot clears the MFA WebAuthn
  ceremony hands-off inside the session provider's `login`, for ALL runs — production included.
  There is no phone-approval poll anywhere in the new design; `login` ends by succeeding or
  throwing within seconds and never parks the run. (`duo-poll.ts` and its manual-approval wait do
  not port.)

---

## 3. Task stores per system plus pure workflow mini-stores

### 3.1 Layout in `temp_src`

```
temp_src/
  domain/
    contracts/                # D3: bundle-safe contract files — zod + domain imports ONLY
      base.ts                 # SystemId, TaskId, Freshness, contract types, defineTaskContract
      ucpath/
        index.ts              # contract barrel — KnownTaskId codegen + pairing guard read this
        search-person-org.ts
        save-oath-signature.ts
      onbase/ …  crm/ …  extraction/ …  ocr/ …  roster/ …
      workflows/
        verify/merge-enrichment.ts       # pure workflow-specific contract
  base/                       # task.ts (impl types + defineTask), store.ts, errors.ts, session.ts
  stores/
    ucpath/
      index.ts                # defineStore("ucpath", { ...tasks }) — THE impl registry
      session.ts              # SessionProvider: login/prepareLogin/resetUrl/idleRefresh/exclusive
      selectors.ts            # PURE RE-EXPORT of src/systems/ucpath/selectors.ts (D15 — see §3.3)
      SELECTORS.md            # regenerated by the (extended) selectors:catalog script
      LESSONS.md              # moved with the store
      impl/                   # verbatim-ported leaf drivers (person-org-summary.ts, ss-smart-hr.ts…)
      tasks/
        search-person-org.task.ts      # defineTask(contract, impl) — binds the pair
        save-oath-signature.task.ts
    onbase/ …   crm/ …   kuali/ …
    extraction/               # service store (D4, charter §11): CSV + PDF extraction — sessions: []
    ocr/                      # service store (D4, charter §11): the OCR provider pipeline
    roster/                   # service store (D4, charter §11): spreadsheet matching — sessions: []
    workflows/
      verify/                 # pure mini-store: effect:"read", sessions:[]; peer-reusable
        index.ts
        tasks/merge-enrichment.task.ts
    common/                   # shared leaf code across stores — home of src/systems/common/ (D15)
```

### 3.2 `defineStore` — one impl registry per task namespace

```ts
// temp_src/base/store.ts
export interface BrowserTaskStore<S extends BrowserSystemId, T extends Record<string, AnyTaskFor<S>>> {
  namespace: S;
  session: SessionProvider<S>;
  tasks: T;                            // typed bag — ucpathStore.tasks.searchPersonOrg
}
export interface HeadlessTaskStore<N extends ServiceSystemId | WorkflowStoreId,
  T extends Record<string, AnyReadTaskFor<N>>> {
  namespace: N;
  session?: never;
  tasks: T;
}

export function defineStore<S extends BrowserSystemId, T extends Record<string, AnyTaskFor<S>>>(
  namespace: S, session: SessionProvider<S>, tasks: T,
): BrowserTaskStore<S, T>;
export function defineStore<S extends ServiceSystemId, T extends Record<string, AnyReadTaskFor<S>>>(
  namespace: S, tasks: T,
): HeadlessTaskStore<S, T>;
export function defineWorkflowStore<Id extends string,
  T extends Record<string, AnyReadTaskFor<`workflow:${Id}`>>>(
  workflowId: Id, tasks: T,
): HeadlessTaskStore<`workflow:${Id}`, T>;
```

- `AnyTaskFor<S>` constrains every browser-store member's contract-id prefix and every
  `SessionNeed.system` to `S`. `AnyReadTaskFor<N>` makes service/workflow stores read-only and
  sessionless; a workflow mini-store cannot obtain `page` or `MutationCapability`. The composition
  root also requires every `workflow:<id>` namespace to match a real descriptor id.
  **A store cannot contain a task that touches another store's system.**
  Cross-system behavior (person-lookup's UCPath+CRM dance) is workflow composition, never a task.
- Runtime validation at module load: duplicate ids, id prefix mismatch → throw.
- The store is the ONLY impl registry; the contract barrel is the ONLY contract registry.
  Descriptors (doc 02), the dashboard task index, and the e2e stub happy paths are projections of
  the **contracts**; the daemon resolves impls through the **store**. Coverage ratchets (all in
  `npm run test:architecture`):
  1. **Pairing guard** — every system or workflow contract is bound by exactly one matching
     `stores/**/tasks/*.task.ts` `defineTask` call, and vice versa (an impl without a contract
     or a contract without an impl fails CI).
  2. **Reachability guard** — each `*.task.ts` export is reachable from its store's `index.ts`
     (kills "wrote the task, forgot the registry").
  3. **Bundle-safety guard** — the import graph of `domain/contracts/**` may reach only zod and
     `domain/` (no Playwright, no `stores/`, no `base/task.ts`).
  4. **Example guard** — every contract's `example` parses through its `output` schema.
  5. **Freshness/provenance guard** — `maxAgeMs: Infinity` requires an adjacent justification
     comment; field overrides must name real output paths; a read contract without both declarations
     fails the factory + types, and derived transforms retain their oldest contributing observation.
  6. **Artifact guard** — task code may reach filesystem/download materialization only through a
     declared content-addressed writer; workflow mini-stores cannot declare artifacts, and mutable
     append/update paths are confined to reviewed serialized projectors.

### 3.3 Porting selectors + LESSONS (wrap, don't rewrite)

- **UCPath selectors are NOT copied — they are re-exported.** `stores/ucpath/selectors.ts` is a
  pure re-export of `src/systems/ucpath/selectors.ts` until the old tree's deletion day (D15):
  27 commits touched that file, ~7 since June — a copied snapshot WILL drift during the
  dual-maintenance window. A guard asserts the store file stays a pure re-export (no local
  declarations) until the old registry is deleted, at which point the content moves wholesale.
  The same pattern is offered to any other high-churn store (crm, kuali) at its migration time;
  low-churn stores may move their registry in the port commit.
- **Two-commit rule per store:** commit 1 is a pure move (`LESSONS.md`, `impl/*` moved with only
  import-path edits — reviewable as zero-logic-diff); commit 2 wraps `impl` in `defineTask` shells
  + contract files. Re-derivation is forbidden (charter): `// verified <date>` stamps, `.or()`
  fallback chains, `getContentFrame`, employment-instance expansion, Duo two-phase factor logic
  move byte-for-byte.
- `npm run selectors:catalog` + `selector:search` extend to `temp_src/stores/*/selectors.ts` (same
  script, extra glob) so the intent-search loop keeps working during migration.
- The existing inline-selector architecture guard extends to `temp_src/stores/*/tasks/**` and
  `impl/**` — tasks import from the store's `selectors.ts`, never `page.locator(...)` inline.

### 3.4 Service stores — system-less work has a home (D4)

Pure compute and non-browser pipelines get **service stores** under the same contract:

- **`extraction`** — CSV + PDF extraction (onboarding's `extraction` step, filename parsing).
  Deterministic, no I/O beyond the filesystem. Its outputs land in workflow input fields via
  **operator-defined column mapping** (charter §11): the operator connects a source column title to
  a canonical field (e.g. some spreadsheet's column → `eid`); mapped values parse through the
  workflow's zod input schema, so ingest is validated by construction. Full design: doc 06.
- **`ocr`** — the OCR provider pipeline (`src/services/ocr/` ports here): model calls, fabrication
  tiering, tolerant-field handling. External I/O, but no browser.
- **`roster`** — spreadsheet matching, using the same operator-defined column mapping onto
  canonical fields (charter §11). Full design: doc 06.

Rules:
- Same contract types, same id grammar (`extraction/extract-pdf-fields`), same error taxonomy, same
  `example`/`freshness` obligations. A service read that feeds a write (roster match → OnBase
  upload) declares `freshness` like any other read.
- `sessions: []` is legal only in **headless service/workflow stores**; browser stores stay
  type-constrained to exactly one need for their own system, and a browser-store task with empty or
  cross-system sessions fails the types and factory.
- Service-store ctx has no `page` member (type-level) and no session provider; `defineStore` for a
  service system takes no `SessionProvider`.
- A read that downloads or creates a local file declares `artifacts:"content-addressed"` and receives
  the kernel `ContentAddressedArtifactWriter`; direct mutable-path writes/imports from a task fail an
  architecture guard. A retry can therefore recreate the same cache artifact but cannot append a
  workbook or mutate operator-owned state. Mutable local projections use stable-keyed SQLite outboxes
  and serialized projectors (docs 03/06), not task `run` side effects.
- What service stores are NOT: a home for waits. Tracker-subscription waiting (oath-upload's
  approval park) is a **gate** (§2.6, doc 02) — it must not be smuggled in as a `local` task.

### 3.5 Workflow mini-stores — pure specialization, never a system-policy bypass

`stores/workflows/<id>/` holds only pure, sessionless `effect:"read"` tasks whose contract ids use
`workflow:<id>/<verb-object>`. These are workflow-specific transforms/joins that are still useful to
reuse peer-to-peer (for example verify's typed enrichment merge). If a task navigates a browser,
stages a form, commits, or calls a system-specific external API, it belongs in that system/service
store instead. The descriptor coverage guard proves each workflow namespace exists, and the
headless-store overload makes prepare/commit/page access a compile error.
Workflow mini-stores also reject `artifacts`; peer reuse is contract reuse, never a path to hidden
filesystem state. Their contract/impl files may not import workflow descriptors or another mini-
store's implementation, so peer imports cannot create a runtime module cycle.

---

## 4. Customization / decoration model

### 4.1 The invariant

**A decorated task is the same task.** Decoration returns a value of the *same* type `T` — same
contract, same schemas, same effect, same sessions. Hooks can observe, add side actions
(screenshots, extra validation, waits), and veto by throwing — they can never change the input,
replace the output, or swallow the error.

```ts
// temp_src/base/decorate.ts
export interface TaskHooks<T extends AnyTask> {
  before?: (args: { input: TaskInput<T>; ctx: HookCtx }) => Promise<void>;
  after?:  (args: { input: TaskInput<T>; output: TaskOutput<T>; ctx: HookCtx }) => Promise<void>;
  /** Observe only. The kernel ALWAYS rethrows the base TaskError; if this
   *  hook itself throws, its failure is attached as TaskError.hookErrors —
   *  secondary metadata, never a replacement (D15; pinned by unit test). */
  onError?: (args: { input: TaskInput<T>; error: TaskError; ctx: HookCtx }) => Promise<void>;
}

export function decorateTask<T extends AnyTask>(base: T, hooks: TaskHooks<T>, label: string): T
```

- `HookCtx` = `{ page (read-only, the task's system), screenshot, log, signal }` — no `fail` with
  the task's codes. A `before`/`after` hook that throws produces `code:"decorator-failed"`,
  `decoratedBy: label` — a broken decoration is never attributed to the base task. An `onError`
  hook that throws does NOT produce a new error at all: the base error propagates with the hook
  failure in `hookErrors` (§2.4).
- `after` throwing = extra validation failing loud (e.g. oath-signature asserting the saved page
  shows the expected signature date). The output is still the base task's output — a workflow that
  wants a transformed value does it in the next step's input mapping (§5), pure and typed.
- Stacking: `decorateTask(decorateTask(t, a, "x"), b, "y")` — hooks run outside-in for `before`,
  inside-out for `after` (standard middleware order), pinned by a unit test.

### 4.2 Where instrumentation attaches

| Layer | Mechanism | Example |
|---|---|---|
| One step of one workflow | `.decorate("transaction", hooks, label)` on doc 02's builder | pre/post-submit form screenshots in oath-signature |
| Every step of one workflow | `.instrument(hooks)` on doc 02's builder | per-step audit screenshot policy |
| Every task everywhere | kernel-level span hooks (doc 03) | step timing, `data:point` lanes |

Today's automatic end-of-step screenshots and error screenshots become kernel span hooks — zero
per-workflow code, same as now, but attached at the task boundary instead of `ctx.step`.

### 4.3 Why adding a task cannot break neighbors

- Tasks are **frozen values with no shared mutable state**. There is no `ctx.data` blob a new task
  could clobber (person-lookup's `startDate`-clobbering bug — active-status overwriting the CRM
  value — is structurally impossible: each output is its own typed record).
- The only inter-task coupling is the **explicit input mapping** (§5). Adding step N+1 adds a key
  to the outputs record; existing mappings don't see it. Removing/renaming an output field breaks
  the *consuming mapping* at compile time — the failure surfaces at the edit, not at runtime.
- Decoration returns the same type, so a decorated step slots anywhere the base did; hooks can't
  alter data flow.

---

## 5. Composition — what the contract requires of the builder

**The workflow builder API itself—read/transaction/branch/fork/child/gate nodes, replay, and
resume—is owned and specified only by doc 02.** This section states the obligations task contracts
impose on that builder; it deliberately does not publish a second API sketch.

- **Compile-time:** every node bind must return exactly `TaskInput<T>` (`z.input`—§2.2) and can only
  read workflow input plus declared upstream node outputs. Rename a task output field → every
  consuming read/transaction/branch/child mapping fails `tsc`.
  That is the charter's "a contract change on one side must fail to compile on the other."
  Doc 02's builder accumulates both exact node outputs and each node's concrete contract tuple so
  decoration remains typed without reducing non-task graph outputs to a broad top type.
- **Runtime:** the kernel parses the mapped value through `contract.input` before `run` (zod is
  the second wall—this is also doc 02's "start from graph node N" entry validation: replayed
  checkpoints flow into `outputs` and any missing required data fails the parse loudly, naming the
  task and field). `run`'s return is parsed through `contract.output` — a task cannot leak an
  out-of-contract shape downstream (today's "stub emitted the display label `"A"` instead of the
  enum" class of bug dies at the boundary it was born).
- Branching/conditional steps, fan-out, gate nodes, and checkpoint/replay are doc 02 scope; the
  contract here only fixes what a step IS.

---

## 6. Auth and dry-run as contract concerns

### 6.1 Auth: store-provided, kernel-executed, boilerplate deleted

```ts
// temp_src/base/session.ts
export type LoginResult = "logged-in" | "already-authenticated";

export interface SessionProvider<S extends BrowserSystemId> {
  system: S;
  /**
   * THE one login signature (D15 — review #7 found three incompatible ones).
   * Idempotent: safe to call on an authenticated page (returns
   * "already-authenticated"); throws on failure. The DUO_LOGIN_FLOWS entry
   * itself ports verbatim; its Promise<boolean> result is mapped by a NAMED
   * ADAPTER WRAPPER (asLoginResult) — the wrapper is new code, not a
   * verbatim claim.
   */
  login(page: Page, opts: { instance?: string; signal?: AbortSignal }): Promise<LoginResult>;
  prepareLogin?(page: Page): Promise<void>;
  resetUrl?: string;
  idleRefresh?: IdleRefreshCadence;     // today's IDLE_REFRESH_SYSTEMS entry moves here
  exclusive?: true;                     // OnBase — mirrors SessionNeed.exclusive (SQLite lease, §2.1)
}
```

- The kernel computes a workflow's session set as the **union of its composed tasks' `sessions`** —
  no per-workflow `systems:` list to keep in sync with what the handler actually touches.
- Default is today's eager parallel-staggered Duo chain. A workflow overrides per system with
  `auth: { ucpath: "on-first-use" }` — the kernel then logs in lazily at the first task that
  requests that page. That replaces `deferAuth: true` **and** the entire 15-line hand-rolled
  auth-step boilerplate in 5 workflows.
- **Park/resume (D5):** when a run parks at a gate (doc 02), the kernel closes its contexts and
  only then releases identity-exclusive leases; on resume it reacquires by calling `login` again.
  Idempotency is what makes release-on-park safe. Duo is cleared hands-off by Duo Autopilot inside `login`
  (§2.6, charter §9) — a login either finishes or throws; it never parks.
- When auth must be deliberately delayed (oath-signature: UCPath only after OCR approval), the
  descriptor uses `auth(...:"on-first-use")`; the first downstream node acquisition emits a visible
  session/auth child span. Login is pool infrastructure, not a fake task contract or checkpoint.
- `DUO_LOGIN_FLOWS` itself becomes a projection over `stores[*].session` (key/label/run) — the
  smoke test and live auth test keep deriving from one table, which is now the same table the
  kernel uses.

### 6.2 Dry-run: a graph composition, not a task flag

- `dryRun` rides the **RunEnvelope** (kernel-owned, doc 02 — D6), never workflow input or TaskCtx.
- Read nodes execute normally. A transaction node executes its `prepare` arm under a retained page
  lease, records an honest `transaction.previewed` span, and ends the run at the node when dry-run
  policy is `stop-after-prepare`. Its `commit` arm is absent from the executable plan.
- A prepare task has no `MutationCapability`; a commit task is never invoked in a dry run. Ported
  external-write helpers accept `CommitTaskCtx["mutation"]`, so read/prepare code cannot call them.
- `dryRun:"unsupported"` belongs on the **transaction node**, not the commit task. The executor
  rejects such a run before launching a browser.
- A genuine no-op established by durable history/live prewrite probe short-circuits before commit
  and yields doc 02's typed `TransactionOutcome{disposition:"already-present"}` reconstructed from
  validated proof. The commit impl is not called and no ledger entry claims this run filed it. It is
  not a dry-run simulation.
- Transaction-node validation proves prepare and commit require the same browser system/context,
  the prepare arm is `in-memory-only`, and there is no gate/checkpoint boundary between them.

---

## 7. Alternative shapes for the core contract

### A. Class-based (`class SearchPersonOrg extends Task<In, Out>`)

*Pros:* familiar OO decoration via subclassing; instanceof dispatch; per-task private helpers.
*Cons:* subclass-decoration is exactly the **fork** we're banning (a subclass can override `run`
wholesale and drift from the base — today's cross-spec `approveTo!` borrowing with more ceremony);
zod schemas as `static` members break inference ergonomics (`z.infer<typeof X.input>` on statics
needs annotations); `this`-binding traps in hooks; metadata is behind a constructor, so descriptor
projection needs instantiation — fatal for the bundle-safe contract split (D3).

### B. Plain object + `defineTaskContract`/`defineTask` factories (recommended)

*Pros:* matches the codebase's proven `defineWorkflow` idiom; **best-in-class zod inference**
(generics flow from the literal object; no annotations at call sites); the contract IS plain data →
descriptors and the dashboard import it directly with no Playwright in the graph (D3); decoration
is a pure wrapper returning the same type (fork-resistant by construction); trivially
unit-testable (`task.impl.run({ input, ctx: fakeCtx })`); load-time validation in two small
factories.
*Cons:* no inheritance for shared behavior — shared behavior must live in `impl/` helpers (which is
what we want); the generic signatures of the factories are gnarly (one-time cost in
`domain/contracts/base.ts` + `base/task.ts`).

### C. Fluent builder (`task("ucpath/x").input(S).output(S).run(fn)`)

*Pros:* reads nicely; can stage type inference per call.
*Cons:* partially-built states exist at runtime (forgot `.run()` compiles until the terminal call is
required — needs extra type machinery); worse error locality (a schema mismatch points at the
builder chain, not a field); more base machinery to maintain; harder to grep (task shape varies).

**Recommendation: B.** It is the only shape where (a) the contract is inert data the descriptor
layer can import without executing anything, (b) decoration structurally cannot fork the base, and
(c) the team's existing mental model (`defineWorkflow`) carries over. The builder shape is retained
**only** for workflow composition (doc 02), where accumulating generics genuinely need staged
inference — tasks stay plain objects.

---

## 8. Adversarial self-review — rot vectors and their guards

| # | How it rots back | Mechanical guard |
|---|---|---|
| 1 | **Parallel lists return** — someone hand-maintains a task list beside the stores (icons, labels, stubs) | Contracts + stores are the only sources; the pairing/reachability ratchets (§3.2) fail CI on an unregistered task; every projection (descriptor, dashboard, stub happy paths) is generated from contracts and has its own guard, per charter #5 |
| 2 | **Stringly dispatch** — `switch (taskId)` re-encoding store knowledge (the `operationTraceCode` pattern) | `KnownTaskId` is codegen'd from all system/service/workflow contract barrels; a ratchet forbids task-id literals (including `workflow:*`) outside contracts, stores, descriptors, and generated files; typed `Record<KnownTaskId, X>` maps get compiler exhaustiveness |
| 3 | **Silent fallbacks in wrappers** — `catch { return { results: [] } }` in a task shell | Existing `fail-loud-catch-default` + `nullish-literal-data-fallback` ratchets extend to `temp_src` from day one (charter non-negotiable); plus: the kernel rethrows the base TaskError unconditionally and a unit test pins that an `onError` hook failure lands in `hookErrors`, never replacing the base error (D15) |
| 4 | **Effect misdeclaration** — an external write hides in read/prepare code | Verb↔effect ratchet (`fill|stage`→prepare; `save|submit|upload|create|update|delete`→commit); external-write helpers require the unforgeable `MutationCapability`, which exists only on `CommitTaskCtx`; dry-run plans contain zero commit nodes |
| 5 | **God tasks** — a task grows into a mini-workflow spanning systems | Browser store sessions are constrained to that system; service/workflow stores are sessionless and have no page. Cross-system logic physically belongs in graph composition |
| 6 | **The untyped blob returns** — someone adds `any`/`Record<string, unknown>` side channels for display data | `CanonicalJsonSchema` rejects `any`/non-JSON outputs; `TaskCtx` has no `updateData`; display fields are projections of typed outputs (doc 03); a ratchet forbids `z.record(` in contract `output` schemas without an allowlist entry |
| 7 | **Auth boilerplate re-accretes** — a workflow hand-rolls a login step | Auth timing is descriptor policy and execution is pool-owned; a grep-ratchet forbids login-task contracts and importing `stores/*/session.ts` login functions from workflows |
| 8 | **Retry as a fallback** — cranking attempts to paper over a broken selector | `attempts` typed `2 \| 3`; `retryOn` has one value (`"transient"`); business-code errors are never transient unless the throw site explicitly claims it, which the fail-loud review catches |
| 9 | **Decoration forks** — copying a base task file to tweak it | One-task-one-file + duplicate-id load-time throw; a ratchet flags two tasks whose `run` bodies import the same `impl` entry function with >90% identical text (cheap AST-less heuristic, allowlisted) |
| 10 | **Schema drift between old and new trees during migration** — dual-maintained leaf code diverges | UCPath selectors: the store file is a **pure re-export** of the old registry until deletion day, with a guard asserting it declares nothing locally (§3.3 — no second copy exists to drift); other leaf code: two-commit port rule (moves are zero-logic diffs), old `src/systems/<x>` deleted when its last workflow migrates (charter), per-workflow migration plan lists the port inventory |
| 11 | **Contract/impl drift** — a contract edited without its impl (or vice versa), or a contract quietly importing server code | Pairing guard + bundle-safety import-graph guard (§3.2); the impl's `run` is typed against the contract's schemas, so a schema edit fails `tsc` in the impl; `example` re-parses on every CI run |
| 12 | **Stale reads feeding writes** — a resumed run replays an old checkpoint into a commit | freshness+provenance metadata are mandatory on every read; derived outputs retain oldest input observation; `Infinity` needs a justification comment; graph dependencies are declared, never inferred by executing JavaScript bind functions (doc 02) |
| 13 | **Undeclared error codes** — `ctx.fail` drifting to arbitrary strings | `const Codes` literal-tuple inference + a checked-in type-level test pinning that an undeclared code fails `tsc` (D15) |
| 14 | **A read task hides a mutable local write** — retry duplicates a workbook row or overwrites an operator edit | read tasks can access only the content-addressed artifact writer when declared; direct mutable filesystem writes fail a guard; mutable sinks are stable-keyed serialized outbox projections (docs 03/06) |

Honest residual risks (no full mechanical guard): (a) *output schemas that are too loose*
(`z.string()` where an enum belongs) — mitigated by review + the stub-must-emit-canonical-values
lesson becoming a test-fixture convention (the mandatory `example` at least pins one canonical
value per contract); (b) *the `impl/` layer quietly growing new unported logic* — mitigated by the
two-commit rule but ultimately a review discipline.

---

## 9. Worked example — three real tasks, decoration in practice

### 9.1 `ucpath/search-person-org` (read) — the canonical example (D16)

**Defined once, here; doc 02 imports it verbatim.** The output shape is taken from the REAL
primitive it wraps — `lookupPersonInUcpath` (`src/workflows/person-lookup/lookup.ts`), which
returns `PersonLookupRunResult { input, results, selection, allAttempts }` built from
`EidResult` (`src/systems/ucpath/person-org-summary.ts:132`) and `PersonLookupSelection`
(`src/workflows/person-lookup/outcome.ts:39`). Two deliberate exclusions from the contract:
`allAttempts` (the per-strategy search trail — audit material for doc 03's notes stream, not data
a downstream step may key on) and `EidResult.rowIndex` (a page-local drill-in artifact).

```ts
// temp_src/domain/contracts/ucpath/search-person-org.ts — bundle-safe: zod only
import { z } from "zod";
import { defineTaskContract } from "../base.js";

const Query = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("by-name"), name: z.string().min(1),
             keepNonHdh: z.boolean().default(false) }),
  z.object({ kind: z.literal("by-eid"), emplId: z.string().regex(/^10\d{6}$/, "EID must be 10xxxxxx") }),
]);

/** Mirrors EidResult (person-org-summary.ts) — required/optional per the real interface. */
const Candidate = z.object({
  emplId: z.string(), emplRecord: z.string(),
  name: z.string(), lastName: z.string(),
  hrStatus: z.string(), businessUnit: z.string(),
  jobCode: z.string(), jobCodeDescription: z.string(),
  // Populated after drill-in — optional on the real interface:
  department: z.string().optional(), deptId: z.string().optional(),
  positionNumber: z.string().optional(),
  startDate: z.string().optional(),        // ORG Instance Last Hire — NOT the assignment EFFDT
  effectiveDate: z.string().optional(),    // selected assignment-row EFFDT
  terminationDate: z.string().optional(),
  terminationReason: z.string().optional(),
  expectedJobEndDate: z.string().optional(),
  fte: z.string().optional(), emplClass: z.string().optional(),
});

const EXAMPLE_CANDIDATE: z.input<typeof Candidate> = {
  emplId: "10873698", emplRecord: "0", name: "Nguyen,Amy", lastName: "Nguyen",
  hrStatus: "Active", businessUnit: "SDCMP", jobCode: "004723",
  jobCodeDescription: "BLANK AST 3", department: "HOUSING/DINING/HOSPITALITY",
  deptId: "000123", positionNumber: "40012345",
  startDate: "09/15/2025", effectiveDate: "01/01/2026",
};

export const SearchPersonOrg = defineTaskContract({
  id: "ucpath/search-person-org",
  title: "UCPath Person Org search",
  effect: "read",
  /** Identity/status data that may feed a live write (separations feeds a
   *  termination off it). A checkpoint older than 15 min may not feed a
   *  commit task on resume (D8; enforcement walk in doc 02). */
  freshness: { defaultMaxAgeMs: 15 * 60_000 },
  provenance: { default: "live" }, // this execution read the authoritative UCPath grid
  input: Query,
  // Mirrors PersonLookupRunResult minus allAttempts (audit → notes stream):
  output: z.object({
    results: z.array(Candidate),
    selection: z.object({
      status: z.enum(["resolved", "not-found", "ambiguous"]),   // PersonLookupStatus, verbatim
      searchName: z.string(),
      selected: Candidate.nullable(),
      candidateEids: z.array(z.string()),
    }),
  }),
  errorCodes: ["results-grid-missing", "drill-in-failed"],
  example: {
    results: [EXAMPLE_CANDIDATE],
    selection: { status: "resolved", searchName: "Nguyen, Amy",
                 selected: EXAMPLE_CANDIDATE, candidateEids: ["10873698"] },
  },
});
```

```ts
// temp_src/stores/ucpath/tasks/search-person-org.task.ts — server-side impl
import { defineTask } from "../../../base/task.js";
import { SearchPersonOrg } from "../../../domain/contracts/ucpath/search-person-org.js";
import { lookupPersonInUcpath } from "../impl/person-lookup.js";   // ported primitive

export const searchPersonOrg = defineTask(SearchPersonOrg, {
  sessions: [{ system: "ucpath" }],
  retry: { attempts: 2, backoffMs: 2000, retryOn: "transient" },
  run: async ({ input, ctx }) => {
    const page = await ctx.page("ucpath");
    // employment-instance expansion + preferred-row selection intact (verbatim port)
    const lookup = await lookupPersonInUcpath(page, input,
      input.kind === "by-name" ? { keepNonHdh: input.keepNonHdh } : {});
    ctx.recordData({ direction: "read", field: "candidates", value: String(lookup.results.length) });
    return { results: lookup.results, selection: lookup.selection };
  },
});
```

Note what vanished versus today's `searchingStep`: no `ctx.updateData` stamping (projection's job),
no inline screenshot policy (decoration/kernel), no `dataString` casts, no per-call-site error
prose rules ("never stamp prose into emplId" is structurally dead — `emplId` isn't a writable blob
field). And note the `z.input`/`z.output` split working: a mapping may omit `keepNonHdh`
(defaulted), while `run` receives it as a definite `boolean`.

### 9.2 OnBase import — separate prepare/commit contracts, one transaction lease

```ts
export const FillImport = defineTaskContract({
  id: "onbase/fill-import",
  title: "Fill OnBase import",
  effect: "prepare",
  checkpoint: "in-memory-only",
  input: z.object({
    pdfPath: z.string().min(1), docType: z.string().min(1),
    emplId: z.string().regex(/^10\d{6}$/), personName: z.string().min(1),
  }),
  output: z.object({ stagedFields: z.array(z.string()) }),
  errorCodes: ["import-form-missing", "field-rejected", "session-held-elsewhere"],
  example: { stagedFields: ["docType", "emplId", "personName"] },
});

export const SubmitImport = defineTaskContract({
  id: "onbase/submit-import",
  title: "Submit OnBase import",
  effect: "commit",
  input: z.object({ emplId: z.string(), documentDigest: z.string() }),
  output: z.object({ proof: OnBaseUploadProofSchema }),
  errorCodes: ["upload-unverified", "session-held-elsewhere"],
  example: { proof: ONBASE_UPLOAD_PROOF_EXAMPLE },
  writeSafety: onBaseUploadSafety, // doc 09: typed state/artifact proof
});

export const fillImport = defineTask(FillImport, {
  sessions: [{ system: "onbase", exclusive: true }],
  run: async ({ input, ctx }) => {
    const page = await ctx.page("onbase");
    await openImportForm(page);
    const staged = await fillImportFields(page, input);
    return { stagedFields: staged };
  },
});

export const submitImport = defineTask(SubmitImport, {
  sessions: [{ system: "onbase", exclusive: true }],
  run: async ({ input, ctx }) => {
    const page = await ctx.page("onbase");
    await clickImport(page, ctx.mutation);
    return { proof: await verifyImportedDocument(input) };
  },
});
```

Doc 02 pairs these in one `transaction` node. The kernel retains the same OnBase page/context and
global identity lease from the first prepare action through commit verification. Dry-run executes
`fillImport` and stops; `submitImport` is not in the executable plan.

### 9.3 Decorating (oath-signature's transaction audit shots)

Decoration is this doc's; the full composed person-lookup flow (binding, conditional steps, gates)
lives in doc 02 §3.2 and imports these contracts verbatim (D16).

```ts
const auditedSave = decorateTask(ucpathStore.tasks.saveOathSignature, {
  before: async ({ ctx }) => ctx.screenshot("oath-staged"),
  after:  async ({ ctx }) => ctx.screenshot("oath-saved"),
}, "oath-form-audit");
// same type as the base — slots into any step the base fits; on the builder,
// the equivalent is .decorate("transaction", hooks, "oath-form-audit") (doc 02).
```

---

## 10. Settled design questions

1. ~~Dry-run continuation~~ — **resolved 2026-07-21:** a dry run stops successfully after the first
   transaction prepare arm by default. A later preview-only graph may continue only through nodes
   whose inputs do not depend on a commit output; the graph validator proves that dependency.
2. ~~Session lifetime ownership for OnBase exclusivity~~ — **resolved:** cross-process SQLite
   lease covers the authenticated context lifetime; context closes before lease release (§2.1).
3. ~~`errorCodes` granularity~~ — **resolved 2026-07-21:** contracts declare per-task literal tuples.
   Shared error-code constants may live in a store, but each task explicitly selects its subset;
   near-duplicate codes are preferable to a broad code a task can never emit.
4. ~~Screenshot policy default~~ — **resolved 2026-07-21:** browser tasks capture the existing
   automatic terminal audit screenshot through a kernel hook. Service/workflow tasks have no
   screenshot ctx. Additional shots are explicit decoration; removing the terminal shot requires a
   named system-level privacy/volume policy, not a per-workflow silent opt-out.
5. ~~`KnownTaskId` codegen timing~~ — **resolved 2026-07-21:** checked in for reviewable diffs;
   generation runs in the normal build and a freshness guard fails when the file differs.
