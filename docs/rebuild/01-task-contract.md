# 01 — The Task Contract & Per-System Task Stores

Status: **Phase 0 design — for operator review.** Conforms to `00-charter.md` and to the binding
reconciliation memo `04-reconciliation.md` (D2–D8, D15, D16 applied; D22 write-safety attachment amendment applied — see doc 09 §2.1).

## Ownership (D1 — this doc owns / this doc references)

| This doc **owns** (siblings reference, never redefine) |
|---|
| The task contract and the **contract/impl split** (`defineTaskContract` + `defineTask`), id grammar + the closed `SystemId` union (D2/D3) |
| Error taxonomy (`TaskError`, declared `errorCodes`) |
| Effect classes + dry-run mechanics (D6/D7) and the `freshness` contract field (D8's contract side) |
| Retry policy |
| Decoration (`decorateTask`, hook semantics, error-propagation rule) |
| Task stores — browser **and service** stores (D4), session providers + the single login signature, shared leaf-code homes (`stores/common/`) |
| The task **boundary** statement — tasks are bounded; what is NOT a task (D5's task side) |

| This doc **references** (owner) |
|---|
| Workflow builder API (the single API), descriptor shape, RunEnvelope, run-state machine incl. **gates/parks**, checkpoint/resume + the freshness enforcement walk → **doc 02** |
| Span/event wire schema, notes stream, completion (fan-out/approval) union, storage + SSE → **doc 03** |
| `WriteSafety<In, Out>` shape attached to `MutateTaskContract` (receipt/verify + idempotency probe + key, D22) → **doc 09** |

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

/** Task ids are namespaced by store: "ucpath/search-person-org" (D2 slash grammar). */
export type TaskId<S extends SystemId = SystemId> = `${S}/${string}`;

/**
 * D8 (contract side): mandatory on EVERY read contract. How long a
 * checkpointed output of this read may age before it is allowed to feed a
 * mutate task on resume. `Infinity` is legal but must be written literally
 * and justified in an adjacent comment (grep ratchet, §8). The enforcement
 * walk (bind-graph, refuse-loud at resume) is kernel behavior owned by doc 02.
 */
export interface Freshness { maxAgeMs: number; }

export type EffectClass = "read" | "mutate";
```

```ts
// temp_src/base/task.ts — server-side (may import Playwright types)
export interface SessionNeed<S extends SystemId = SystemId> {
  system: S;
  /**
   * OnBase-style constraint: one live app session per identity. Enforced by a
   * CROSS-PROCESS SQLite lease from day one (D15) — daemons are separate OS
   * processes (src/cli-daemon.ts), so an in-process queue cannot serialize
   * them. The kernel acquires the lease before opening the context and
   * releases it on task end/park. Ported knowledge:
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

- **contract** — plain data, bundle-safe, in `temp_src/domain/contracts/<system>/`: id, zod
  input/output, `title`, `effect`, `errorCodes`, `freshness` (reads) / `dryRun` mode (mutations),
  and a **mandatory `example` output**. Descriptors (doc 02) and the dashboard import contracts
  ONLY. E2e stubs derive their **happy path** from `example` (schema-parsed); failure / cancel /
  parallel-worker scenarios REMAIN hand-scripted in the stub lane — examples cannot express them.
- **impl** — `run` + session needs + retry, in the store (`temp_src/stores/<system>/tasks/`),
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
  output: Out;
  /** Declared error taxonomy. ctx.fail() only accepts these codes. */
  errorCodes: Codes;
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
}

export interface MutateTaskContract<Id extends TaskId, In extends z.ZodType,
  Out extends z.ZodType, Codes extends readonly [string, ...string[]]>
  extends TaskContractBase<Id, In, Out, Codes> {
  effect: "mutate";
  /**
   *  - "simulate": the impl stops before the irreversible action when the
   *    run is a dry run, returning an honest "not submitted" output.
   *  - "unsupported": a dry-run run FAILS LOUD before this task is invoked.
   * There is deliberately NO "skip" — silently skipping fabricates a false
   * "done" (charter: fail loud).
   */
  dryRun: "simulate" | "unsupported";
  /** Write-safety attachment (receipt/verify + idempotency probe + key). REQUIRED
   *  on a mutate contract (guard-enforced, doc 09 §8); the *shape* `WriteSafety<In, Out>`
   *  is owned by doc 09 §2.1 (D22) — referenced here, never redefined. */
  writeSafety?: WriteSafety<In, Out>;
}

/** `const Codes` (TS5) keeps errorCodes as a literal tuple — without it the
 *  union collapses to string[] and ctx.fail() would accept anything (D15). */
export function defineTaskContract<
  Id extends TaskId, In extends z.ZodType, Out extends z.ZodType,
  const Codes extends readonly [string, ...string[]],
>(c: ReadTaskContract<Id, In, Out, Codes> | MutateTaskContract<Id, In, Out, Codes>)
```

`defineTaskContract` freezes the object and **fails loud at module load** on: id not matching
`/^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/`, id prefix not a `SystemId`, empty `errorCodes`, `example`
failing `output.parse`, a read contract missing `freshness`. A **type-level test** pins that
`ctx.fail("undeclared-code", …)` fails `tsc` (D15).

```ts
// temp_src/base/task.ts (continued) — the impl side + the binding factory
export type SystemOf<C> =
  C extends { id: `${infer S extends SystemId}/${string}` } ? S : never;

export interface ReadTaskImpl<C extends AnyReadContract> {
  sessions: readonly SessionNeed<SystemOf<C>>[];   // [] legal ONLY in service stores (§3.4)
  retry?: RetryPolicy;
  /** Receives the PARSED input (z.output — defaults/transforms applied);
   *  returns a pre-parse value (z.input of the output schema) that the
   *  kernel parses through contract.output before anything downstream sees it. */
  run: (args: { input: z.output<C["input"]>; ctx: ReadTaskCtx<SystemOf<C>, C["errorCodes"]> })
    => Promise<z.input<C["output"]>>;
}
export interface MutateTaskImpl<C extends AnyMutateContract> {
  sessions: readonly SessionNeed<SystemOf<C>>[];
  retry?: RetryPolicy;
  run: (args: { input: z.output<C["input"]>; ctx: MutateTaskCtx<SystemOf<C>, C["errorCodes"]> })
    => Promise<z.input<C["output"]>>;
}

/** Per-effect overloads (D7): pairing a mutate contract with a read-shaped
 *  impl (or vice versa) fails to compile — the ctx types differ. This is
 *  "compile-time where possible"; the factory's runtime checks are the
 *  always-on backstop (effect/ctx mismatch, dryRun mode present iff mutate). */
export function defineTask<C extends AnyReadContract>(contract: C, impl: ReadTaskImpl<C>): Task<C>;
export function defineTask<C extends AnyMutateContract>(contract: C, impl: MutateTaskImpl<C>): Task<C>;

export type Task<C extends AnyContract> =
  Readonly<{ contract: C; impl: ReadTaskImpl<any> | MutateTaskImpl<any> }> & { readonly __task: true };

export type TaskInput<T>  = T extends { contract: { input:  infer I extends z.ZodType } } ? z.input<I>  : never;
export type TaskOutput<T> = T extends { contract: { output: infer O extends z.ZodType } } ? z.output<O> : never;
```

**`z.input` vs `z.output` (D15, review #4):** step input mappings produce `TaskInput<T>` =
`z.input` — a field with `.default(false)` is *omittable* at the mapping site; `run` receives the
parsed `z.output` value with defaults and transforms applied. Conflating the two (`z.infer`
everywhere) would make every defaulted field required in mappings and defeat transforms.

### 2.3 The task ctx (narrow by construction)

```ts
export interface TaskCtxCommon<S extends SystemId, Codes extends readonly string[]> {
  /** Only the declared system — ctx.page("crm") inside a ucpath task is a compile error.
   *  Absent entirely on service-store ctx (§3.4) — pure compute has no page. */
  page(system: S): Promise<Page>;              // same abort-racing proxy as today
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
  /** Audit screenshot, scoped to this task's system automatically. */
  screenshot(label: string): Promise<void>;
}

export interface ReadTaskCtx<S extends SystemId, Codes extends readonly string[]>
  extends TaskCtxCommon<S, Codes> {}          // no dryRun member AT ALL — a read cannot branch on it

export interface MutateTaskCtx<S extends SystemId, Codes extends readonly string[]>
  extends TaskCtxCommon<S, Codes> {
  dryRun: boolean;                             // threaded to the mutation primitives (§6.2)
}
```

**What TaskCtx deliberately does NOT have:** `updateData` (the untyped blob — display fields become
projections of typed task outputs, doc 03), `step` (a task IS the step), `delegateTo` (delegation
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
  `onbase/upload-document`, `crm/read-onboarding-record`, `ucpath/ensure-authenticated`,
  `extraction/extract-pdf-fields`, `ocr/read-form-pages`, `roster/match-spreadsheet`.
- Verb prefixes are meaningful: `read-`/`search-`/`list-`/`extract-` ⇒ `effect:"read"`;
  `save-`/`submit-`/`upload-`/`create-`/`update-`/`delete-`/`fill-and-submit-` ⇒ `effect:"mutate"`.
  A ratchet test (§8) enforces verb↔effect agreement so a misdeclared effect can't hide.
- A codegen'd `KnownTaskId` union — derived from the **contract barrels**
  (`domain/contracts/*/index.ts`) at build time, like `schemas:export` — gives descriptor
  projections and the dashboard a closed type to key on. Bundle-safe by construction: it is
  generated from files that themselves import only zod.

### 2.6 The task boundary — tasks are bounded; waits are not tasks (D5)

**A task is a run-to-completion Promise with bounded duration** (minutes, not hours). The things
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

## 3. Task stores per system

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
        ensure-authenticated.ts
      onbase/ …  crm/ …  extraction/ …  ocr/ …  roster/ …
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
        ensure-authenticated.task.ts   # generated wrapper — see §6.1
    onbase/ …   crm/ …   kuali/ …
    extraction/               # service store (D4, charter §11): CSV + PDF extraction — sessions: []
    ocr/                      # service store (D4, charter §11): the OCR provider pipeline
    roster/                   # service store (D4, charter §11): spreadsheet matching — sessions: []
    common/                   # shared leaf code across stores — home of src/systems/common/ (D15)
```

### 3.2 `defineStore` — the one impl registry per system

```ts
// temp_src/base/store.ts
export interface TaskStore<S extends SystemId, T extends Record<string, AnyTaskFor<S>>> {
  system: S;
  session: SessionProvider<S>;         // absent on service stores (§3.4)
  tasks: T;                            // typed bag — ucpathStore.tasks.searchPersonOrg
}

export function defineStore<S extends SystemId, T extends Record<string, AnyTaskFor<S>>>(
  system: S, session: SessionProvider<S>, tasks: T,
): TaskStore<S, T>
```

- `AnyTaskFor<S>` constrains every member's contract-id prefix AND every `SessionNeed.system` to
  `S` at the type level. **A store cannot contain a task that touches another store's system.**
  Cross-system behavior (person-lookup's UCPath+CRM dance) is workflow composition, never a task.
- Runtime validation at module load: duplicate ids, id prefix mismatch → throw.
- The store is the ONLY impl registry; the contract barrel is the ONLY contract registry.
  Descriptors (doc 02), the dashboard task index, and the e2e stub happy paths are projections of
  the **contracts**; the daemon resolves impls through the **store**. Coverage ratchets (all in
  `npm run test:architecture`):
  1. **Pairing guard** — every `domain/contracts/<sys>/*.ts` contract is bound by exactly one
     `stores/<sys>/tasks/*.task.ts` `defineTask` call, and vice versa (an impl without a contract
     or a contract without an impl fails CI).
  2. **Reachability guard** — each `*.task.ts` export is reachable from its store's `index.ts`
     (kills "wrote the task, forgot the registry").
  3. **Bundle-safety guard** — the import graph of `domain/contracts/**` may reach only zod and
     `domain/` (no Playwright, no `stores/`, no `base/task.ts`).
  4. **Example guard** — every contract's `example` parses through its `output` schema.
  5. **Freshness guard** — `maxAgeMs: Infinity` requires an adjacent justification comment
     (grep ratchet); a read contract without `freshness` already fails the factory + types.

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
- `sessions: []` is **legal ONLY in service stores**; browser stores stay type-constrained to
  their own system's sessions, and a browser-store task with empty sessions fails the factory.
- Service-store ctx has no `page` member (type-level) and no session provider; `defineStore` for a
  service system takes no `SessionProvider`.
- What service stores are NOT: a home for waits. Tracker-subscription waiting (oath-upload's
  approval park) is a **gate** (§2.6, doc 02) — it must not be smuggled in as a `local` task.

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

**The workflow builder API itself — the single API, conditional steps, gates, replay policy,
resume — is doc 02's.** This section states only the type-level obligations the task contract
imposes on it, with a minimal sketch showing they are implementable:

```ts
// obligations sketch — doc 02 owns the real builder surface
interface FlowScope<WIn, Outs extends Record<string, unknown>> {
  input: WIn;                 // the workflow-constant input (doc 02 §2)
  outputs: Outs;              // typed z.output values of every completed step
}

interface FlowBuilder<
  WIn,
  Steps extends Record<string, AnyTask>,       // name → TASK type (D15: recovers the task for decorate)
  Outs  extends Record<string, unknown>,       // name → output type
> {
  step<Name extends string, T extends AnyTask>(
    name: Name,
    task: T,
    map: (scope: FlowScope<WIn, Outs>) => TaskInput<T>,   // z.input — defaulted fields omittable
  ): FlowBuilder<WIn, Steps & Record<Name, T>, Outs & Record<Name, TaskOutput<T>>>;

  decorate<Name extends keyof Steps & string>(
    name: Name, hooks: TaskHooks<Steps[Name]>, label: string): this;
  instrument(hooks: TaskHooks<AnyTask>): this;
}
```

- **Compile-time:** `map` must return exactly `TaskInput<T>` (`z.input` — §2.2) and can only read
  `input` and prior outputs. Rename a task's output field → every consuming workflow fails `tsc`.
  That is the charter's "a contract change on one side must fail to compile on the other."
  The builder accumulates **two** generic maps: `Outs` for mapping types and `Steps` for task
  types — without `Steps`, `decorate` cannot type its hooks (review #3).
- **Runtime:** the kernel parses the mapped value through `contract.input` before `run` (zod is
  the second wall — this is also exactly doc 02's "start from task N" entry validation: replayed
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

export interface SessionProvider<S extends SystemId> {
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
- **Park/resume (D5):** when a run parks at a gate (doc 02), the kernel releases the run's
  sessions and exclusive leases; on resume it reacquires by calling `login` again — idempotency is
  what makes release-on-park safe. Duo is cleared hands-off by Duo Autopilot inside `login`
  (§2.6, charter §9) — a login either finishes or throws; it never parks.
- When auth must be a *visible, deliberately-timed step* (oath-signature: Duo only after OCR
  approval), `defineStore` auto-generates `"<system>/ensure-authenticated"` — a normal `read` task
  (input `{}`, output `{ alreadyAuthenticated: boolean }`) wrapping the provider. One generated
  wrapper per store; zero copies in workflows.
- `DUO_LOGIN_FLOWS` itself becomes a projection over `stores[*].session` (key/label/run) — the
  smoke test and live auth test keep deriving from one table, which is now the same table the
  kernel uses.

### 6.2 Dry-run: typed, contract-declared, asserted at the mutation primitives

- `dryRun` rides the **RunEnvelope** (kernel-owned, doc 02 — D6), never workflow input.
- `effect:"read"` contracts: unaffected; `ctx.dryRun` does not exist on `ReadTaskCtx` (§2.3), so a
  read task literally cannot branch on it.
- `effect:"mutate"` + `dryRun:"simulate"`: the impl's ctx carries `dryRun: boolean`; the ported
  leaf code already has the branch (separations' pre-submit stop). The output schema must be
  authored so the simulate branch returns an **honest** value (e.g.
  `{ submitted: false, confirmationId: null }`) — never a fabricated success.
- `effect:"mutate"` + `dryRun:"unsupported"`: the kernel fails the run loudly **before invoking
  the task**, naming it ("task onbase/upload-document does not support dry-run").
- **Mechanical enforcement lives at the mutation primitives (D15 — review #9).** The handful of
  ported irreversible helpers (`submitImport`, `clickSaveAndSubmit`, Kuali finalize, …) are
  wrapped once at port time in `stores/common/mutation.ts` to take the ctx's dry-run state and
  **throw** if invoked while `dryRun` is true
  (`"[onbase/upload-document] mutation primitive submitImport invoked during dry-run"`). The
  assertion sits where the irreversible click happens — it cannot be bypassed by destructuring the
  flag (the old recording-getter tripwire could, and is dropped).
- **No-op completions have defined semantics.** A mutate task may legitimately complete without
  reaching any mutation primitive when the no-op is a genuine, declared outcome (onboarding's
  duplicate-hire "Already Submitted" skip). The output must say so honestly
  (`{ submitted: false, reason: "already-submitted" }`) — schema-visible, never inferred. The
  kernel does not require that a mutate run consult `dryRun`; it requires that no mutation
  primitive fires while `dryRun` is true.

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
| 2 | **Stringly dispatch** — `switch (taskId)` re-encoding store knowledge (the `operationTraceCode` pattern) | `KnownTaskId` is a codegen'd closed union from the contract barrels; an architecture grep-ratchet forbids string literals matching `/^(ucpath\|onbase\|crm\|…)\//` outside `domain/contracts/**`, `stores/**`, and generated files; typed `Record<KnownTaskId, X>` maps get exhaustiveness from the compiler |
| 3 | **Silent fallbacks in wrappers** — `catch { return { results: [] } }` in a task shell | Existing `fail-loud-catch-default` + `nullish-literal-data-fallback` ratchets extend to `temp_src` from day one (charter non-negotiable); plus: the kernel rethrows the base TaskError unconditionally and a unit test pins that an `onError` hook failure lands in `hookErrors`, never replacing the base error (D15) |
| 4 | **Effect misdeclaration** — a mutating task marked `read` slips through dry-run | Verb↔effect ratchet (id containing `save\|submit\|upload\|create\|update\|delete\|fill` must be `mutate` or carry an allowlisted justification); read contracts cannot carry `dryRun` and `ReadTaskCtx` has no `dryRun` member (contract-shape compile check), so a "read" doing writes has no dry-run escape hatch; the mutation-primitive assertion (§6.2) throws if such a task reaches an irreversible helper during a dry run — it fails review or fails live dry-run verification |
| 5 | **God tasks** — a task grows into a mini-workflow spanning systems | Type-level: a store task's `SessionNeed.system` is constrained to the store's own system; cross-system logic physically cannot live in one task |
| 6 | **The untyped blob returns** — someone adds a `Record<string, unknown>` side channel for display data | `TaskCtx` has no `updateData`; display fields are projections of typed outputs (doc 03); a ratchet forbids `z.record(` in contract `output` schemas without an allowlist entry |
| 7 | **Auth boilerplate re-accretes** — a workflow hand-rolls a login step | `ensure-authenticated` wrappers are generated by `defineStore`; a grep-ratchet forbids importing `stores/*/session.ts` login fns from `workflows/**` |
| 8 | **Retry as a fallback** — cranking attempts to paper over a broken selector | `attempts` typed `2 \| 3`; `retryOn` has one value (`"transient"`); business-code errors are never transient unless the throw site explicitly claims it, which the fail-loud review catches |
| 9 | **Decoration forks** — copying a base task file to tweak it | One-task-one-file + duplicate-id load-time throw; a ratchet flags two tasks whose `run` bodies import the same `impl` entry function with >90% identical text (cheap AST-less heuristic, allowlisted) |
| 10 | **Schema drift between old and new trees during migration** — dual-maintained leaf code diverges | UCPath selectors: the store file is a **pure re-export** of the old registry until deletion day, with a guard asserting it declares nothing locally (§3.3 — no second copy exists to drift); other leaf code: two-commit port rule (moves are zero-logic diffs), old `src/systems/<x>` deleted when its last workflow migrates (charter), per-workflow migration plan lists the port inventory |
| 11 | **Contract/impl drift** — a contract edited without its impl (or vice versa), or a contract quietly importing server code | Pairing guard + bundle-safety import-graph guard (§3.2); the impl's `run` is typed against the contract's schemas, so a schema edit fails `tsc` in the impl; `example` re-parses on every CI run |
| 12 | **Stale reads feeding writes** — a resumed run replays an old checkpoint into a mutation | `freshness.maxAgeMs` mandatory on every read contract (factory + type); `Infinity` needs a justification comment (grep ratchet); the resume-time bind-graph refusal is doc 02's kernel walk |
| 13 | **Undeclared error codes** — `ctx.fail` drifting to arbitrary strings | `const Codes` literal-tuple inference + a checked-in type-level test pinning that an undeclared code fails `tsc` (D15) |

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
   *  mutate task on resume (D8; enforcement walk in doc 02). */
  freshness: { maxAgeMs: 15 * 60_000 },
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

### 9.2 `onbase/upload-document` (mutate, exclusive session, simulate dry-run)

```ts
// temp_src/domain/contracts/onbase/upload-document.ts
export const UploadDocument = defineTaskContract({
  id: "onbase/upload-document",
  title: "OnBase document import",
  effect: "mutate",
  dryRun: "simulate",
  input: z.object({
    pdfPath: z.string().min(1), docType: z.string().min(1),
    emplId: z.string().regex(/^10\d{6}$/), personName: z.string().min(1),
  }),
  output: z.object({ submitted: z.boolean(), stagedFields: z.array(z.string()) }),
  errorCodes: ["import-form-missing", "field-rejected", "session-held-elsewhere"],
  example: { submitted: true, stagedFields: ["docType", "emplId", "personName"] },
});

// temp_src/stores/onbase/tasks/upload-document.task.ts
export const uploadDocument = defineTask(UploadDocument, {
  // single-app-session (LESSONS.md) — kernel serializes via cross-process SQLite lease (§2.1)
  sessions: [{ system: "onbase", exclusive: true }],
  run: async ({ input, ctx }) => {
    const page = await ctx.page("onbase");
    await openImportForm(page);                       // ported leaf, contention detection intact
    const staged = await fillImportFields(page, input);
    if (ctx.dryRun) {
      ctx.log.info("dry-run: import staged, NOT submitted", { emplId: input.emplId });
      return { submitted: false, stagedFields: staged };      // honest, schema-valid
    }
    await submitImport(page, ctx);   // mutation primitive — throws if ctx.dryRun were true (§6.2)
    return { submitted: true, stagedFields: staged };
  },
});
```

### 9.3 `ucpath/ensure-authenticated` (generated login task)

```ts
// generated by defineStore from stores/ucpath/session.ts — shown expanded for review
export const EnsureAuthenticated = defineTaskContract({
  id: "ucpath/ensure-authenticated",
  title: "UCPath sign-in",
  effect: "read",                       // auth mutates no HR data
  // Auth state is a session property, never data feeding a write — the only
  // justified Infinity in the ucpath contracts (grep ratchet requires this comment).
  freshness: { maxAgeMs: Infinity },
  input: z.object({}),
  output: z.object({ alreadyAuthenticated: z.boolean() }),
  errorCodes: ["auth-failed"],
  example: { alreadyAuthenticated: false },
});

export const ensureAuthenticated = defineTask(EnsureAuthenticated, {
  sessions: [{ system: "ucpath" }],
  run: async ({ ctx }) => {
    const page = await ctx.page("ucpath");
    try {
      // ONE signature (§6.1): Promise<"logged-in" | "already-authenticated">.
      // The duo-login-flows entry underneath ports verbatim; asLoginResult is
      // the named boolean→union adapter wrapper.
      const result = await ucpathSession.login(page, { signal: ctx.signal });
      return { alreadyAuthenticated: result === "already-authenticated" };
    } catch (e) {
      ctx.fail("auth-failed", `UCPath authentication failed: ${errorMessage(e)}`, { cause: e });
    }
  },
});
```

### 9.4 Decorating (oath-signature's transaction audit shots)

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

## 10. Open questions for the orchestrator / operator

1. **Dry-run outputs downstream:** simulate-mode mutations return honest "not submitted" values —
   should a dry run *stop* at the first mutation by default, or continue with those values (today's
   separations dry-run continues)? Proposed default: continue, per-workflow opt-out.
2. ~~Session lifetime ownership for OnBase exclusivity~~ — **resolved by D15**: cross-process
   SQLite lease from day one (§2.1); single-daemon in-process serialization was rejected because
   daemons are separate OS processes.
3. **`errorCodes` granularity:** per-task codes (proposed) vs a shared per-store taxonomy that
   tasks pick from. Per-task is more honest but risks near-duplicate codes across tasks.
4. **Screenshot policy default:** keep today's automatic end-of-step (= end-of-task) audit shot as
   a kernel span hook for every task, or make it opt-in per workflow now that decoration is cheap?
   Proposed: keep automatic (it's an operator-facing audit trail guarantee).
5. **`KnownTaskId` codegen timing:** generated file checked in (reviewable diffs, guard asserts
   freshness) vs generated at build (no drift, invisible in review). Proposed: checked in + guard.
