# 12 — Operator Trust, Semantic UI Vocabulary, Diagnostics, Knowledge & Workflow Authoring

Status: **Phase 0 binding design — added 2026-07-22 after the whole-plan/legacy-code review;
amended 2026-07-26 (Round 8).** This document owns the human-facing foundation that turns the typed
executor into a system the single operator can understand, debug, extend, and trust. It is
**local-first with deliberate multi-user seams** (D75, §7): it does not add RBAC, user management,
remote administration, distributed coordination, or enterprise deployment ceremony, but four seams
that make a later multi-user migration configuration rather than a second rebuild are load-bearing
from day one and may never be trimmed. It retains correctness controls, PII/secret redaction,
local-only network defaults, durable recovery, and evidence because this tool reads and writes real
HR records. **Round 8 also trims the DSL graph-authoring mode entirely (§5.4, D79a).**
**Amended 2026-07-30 (Round 9):** the base-capability inventory names explicit per-workflow worker
counts and authored fresh-browser-session boundaries instead of executor lanes/capacity math (D87).
**Amended 2026-07-31 (Round 10):** UI knowledge is copied with provenance into an isolated rebuild;
the explorer is Phase-2-only and graph DSL/codegen remains cut.

## Ownership (D1)

| This doc **OWNS** | Imports from the owning sibling |
|---|---|
| Canonical UI vocabulary: `ElementId`, `ScreenId`, `PageStateId`, `ObservationId`, search terms, registry records, generated catalog, and the typed system-driver boundary | Task contract/store/session model → doc 01; page leases → doc 05 |
| Operator evidence receipt, failure record, diagnostic bundle, `explain run`, and redaction policy | Event/storage wire and retention → doc 03; write-binding proof/write ledger → doc 09; secrets → doc 11 |
| Scenario corpus/manifests and the bug→regression-scenario rule | Task `example` and errors → doc 01; graph outcomes → doc 02; test lanes/guards → doc 10 |
| Structured knowledge lifecycle and the AI-assisted `FixRecord` ledger | Existing lessons are migration inputs, not another authority |
| Read-only workflow explorer and the staged, constrained workflow editor | Descriptor/graph/delegation model → doc 02; spans/projections → doc 03 |
| The webpage-ready base capability inventory (§8) | Build order → doc 07 |

This doc does **not** redefine task, graph, command, event, write-safety, config, or storage
contracts. It defines the semantic/operator layer those contracts project into.

All interfaces shown here are readable views of strict, versioned zod schemas; implementation
types are inferred from those schemas. The registry, scenario, failure, evidence, diagnostic,
knowledge, fix, editor-draft, and generated-catalog boundaries reject unknown keys recursively.
Canonical ids/digests/instants are branded. A generic metadata map may exist only inside an opaque,
schema-versioned diagnostic attachment that no workflow, command, projection, or policy reads.

---

## 0. Why this is foundation work, not dashboard polish

The old codebase already contains many correct selectors, identity checks, screenshots, lessons,
and queue actions, but they are difficult to reuse consistently:

- A selector registry key is usually a TypeScript property path, not a stable phrase the operator
  can use in a workflow description. The same visible control can acquire multiple names in code,
  comments, lessons, and AI prompts.
- Browser tasks receive a raw Playwright `Page`, so a task can bypass the registry, page-state
  checks, action tracing, redaction, and subject verification even when better infrastructure
  exists.
- A terminal row says `failed` and often preserves only a message. Reconstructing why it failed
  requires correlating tracker rows, logs, screenshots, session events, and source code manually.
- A `done` row does not present a compact receipt of inputs, observations, decisions, writes,
  verification, checkpoint reuse, and uncertainty. The operator therefore rechecks automation that
  should be trustworthy.
- Lessons accumulate as prose. New guidance is mixed with stale/superseded history, so an AI tool
  can follow the wrong lesson confidently.
- The existing workflow modifier edits presentation and shows mined operations, but the rebuild
  plan did not say whether the new graph is only documentation or a safe editing surface.

These are base concerns because every later workflow otherwise invents names, debug output,
scenarios, evidence, and editor behavior independently—the same drift the descriptor rebuild is
meant to remove.

---

## 1. Canonical UI vocabulary and typed system drivers

### 1.1 Four identifiers with one job each

```ts
export type ElementId = Brand<string, "ElementId">;          // "ucpath.smart-hr.save-submit"
export type ScreenId = Brand<string, "ScreenId">;            // "ucpath.smart-hr.transaction"
export type PageStateId = Brand<string, "PageStateId">;      // "ucpath.smart-hr.ready-to-submit"
export type ObservationId = Brand<string, "ObservationId">;  // "new-kronos.timecard.employee-eid"
```

- **Element** = one interactive or observable UI thing: field, button, row, dialog, header.
- **Screen** = a stable operator-recognizable area or route.
- **Page state** = a validated state of that screen, expressed by positive and negative evidence.
- **Observation** = a typed fact read from the UI, such as the employee EID displayed by the
  currently open timecard.

IDs are stable kebab-case dotted names, never generated from a TypeScript file/property path. A
source rename does not rename the operator vocabulary. Every id has one canonical human label and
zero or more search terms. Search terms help humans/AI find the canonical id; they never create another
identity.

### 1.2 Registry record

```ts
// Server-only definition under stores/<system>/driver/. Client/task code receives generated ids and
// safe catalog projections, never locator recipes.
export interface UiElementDefinition<ValueSchema extends z.ZodType = z.ZodType> {
  id: ElementId;
  system: BrowserSystemId;
  screen: ScreenId;
  label: string;                         // "Save and Submit"
  searchTerms: readonly string[];        // "submit button", "finalize transaction"
  role: "button" | "field" | "grid" | "row" | "dialog" | "heading" | "link" | "status";
  effect: "observe" | "navigate" | "prepare" | "external-commit";
  value?: CanonicalJsonSchema<ValueSchema>;
  sensitivity: "public" | "hr" | "restricted"; // controls logs/screenshots/diagnostic export
  locator: LocatorRecipe;                // closed recipe union, interpreted by the driver
  requiredStates: readonly PageStateId[];
  verified: { at: DateOnly; method: "live" | "fixture"; evidenceRef: string };
  supersedes?: readonly ElementId[];
}

export interface PageStateDefinition {
  id: PageStateId;
  system: BrowserSystemId;
  screen: ScreenId;
  label: string;
  evidence: readonly StateEvidenceRule[]; // closed all/any/not locator/URL/observation rules
  timeoutMs: number;
}

export interface UiObservationDefinition<S extends z.ZodType> {
  id: ObservationId;
  system: BrowserSystemId;
  screen: ScreenId;
  label: string;
  schema: CanonicalJsonSchema<S>;
  read: ObservationRecipe;               // closed recipe; implementation lives server-side
  authoritativeFor: readonly [
    "subject" | "completion" | "page-state",
    ...("subject" | "completion" | "page-state")[],
  ];
  sensitivity: "public" | "hr" | "restricted";
}
```

`LocatorRecipe`, `StateEvidenceRule`, and `ObservationRecipe` are closed discriminated unions—not
arbitrary callbacks—but the registry that contains them is still **server-only**. Bundle-safe domain
contracts contain branded ids and public metadata schemas, not locator recipes. System drivers
interpret the recipes. A
specialized live-only read may reference a named driver operation, but that operation must resolve
from the same system registry and carry a fixture/test.

### 1.3 One canonical catalog for the operator and AI tools

The build generates a **safe projection** at `generated/ui-catalog.json` and per-system
`UI-CATALOG.md` from the server registry. Each entry includes canonical id, label, search terms,
screen/state, role/effect, verified date/method, sensitivity classification, tasks that use it,
related observations, and an exact registry source link. It deliberately omits locator/state/read
recipes and captured values. Search resolves labels and search terms to exactly one canonical id; a
search-term collision fails generation with both definitions named. The dashboard receives this projection; it
never imports the server registry.

Examples of operator language that resolve without source archaeology:

- “the New Kronos employee EID in the open timecard” →
  `new-kronos.timecard.employee-eid` (`ObservationId`)
- “UCPath Save and Submit” → `ucpath.smart-hr.save-submit` (`ElementId`)
- “the OnBase import form is ready” → `onbase.import.ready` (`PageStateId`)

Existing `SELECTORS.md` and `selector:search` are porting evidence, never runtime inputs. Verified
recipes are copied into `temp_src` with source path/key, verification date, and rebuild tests; the
generated catalog may display the legacy property path as provenance text, not a resolvable search term.
No rebuilt module imports legacy selector code, and old source remains preserved through cutover.

### 1.4 Tasks do not receive raw `Page`

Raw Playwright access is confined to `stores/<system>/driver/**`, worker-owned session
infrastructure, and the registry interpreter. Browser task contexts receive a typed driver:

```ts
export interface SystemDriver<S extends BrowserSystemId> {
  goto(screen: ScreenIdFor<S>): Promise<PageStateProof>;
  waitFor(state: PageStateIdFor<S>): Promise<PageStateProof>;
  read<O extends ObservationIdFor<S>>(id: O): Promise<ObservationValue<O>>;
  fill<E extends FieldElementIdFor<S>>(id: E, value: ElementValue<E>): Promise<ActionProof>;
  /** Commit-class controls are excluded from this union. */
  click<E extends NonCommitClickableElementIdFor<S>>(id: E): Promise<ActionProof>;
  choose<E extends ChoiceElementIdFor<S>>(id: E, value: ElementValue<E>): Promise<ActionProof>;
  /** The only generic path to an element declared `external-commit`. Prepare/read ctx cannot supply
   * this unforgeable capability; the driver validates its intent generation + subject digest. */
  commit<E extends CommitElementIdFor<S>>(
    id: E, capability: MutationCapability,
  ): Promise<ActionProof>;
}
```

Every driver action automatically records the task/span, element id, page state before/after,
duration, and selector recipe actually used. A task can still call a complex named driver method
for a PeopleSoft grid or iframe workflow, but that method is registered with declared inputs,
outputs, used elements/states, and scenarios. It cannot take an untracked raw locator from the task.
Any named operation that reaches an `external-commit` element must accept and validate
`MutationCapability`; this is checked through its dependency graph. Subject observation uses
`driver.read(spec.observe)`, but normalization/comparison and `SubjectProof` construction belong to
the kernel so a driver cannot assert its own match. Extra screenshots are requested through doc 01's
kernel/decorator capture surface, not an unrestricted task driver method.

This preserves the port-first rule: live-verified leaf functions may initially move behind a
driver operation with zero logic change. The boundary changes immediately; internal locator logic
is improved incrementally only after its fixtures/live checks exist.

### 1.5 Registry separation—no “one giant task store” ambiguity

| Concern | Canonical owner | Reuse meaning |
|---|---|---|
| Business/system operation (“search Person Org”, “fill termination”) | System task store (doc 01) | Compose the proven operation in workflows |
| UI vocabulary/locator/page-state/observation | UI registry + system driver (this doc) | All system tasks share one named UI fact/control |
| Completed output within a run/item | Checkpoint store (doc 02) | Resume/replay without rescanning when freshness permits |
| Pure workflow-specific transform/join | Workflow mini-store (doc 01) | Peer-reuse typed computation, no browser |

The task store prevents repeated reinvention of *operations*. The UI registry prevents repeated
reinvention of *selectors and page truth*. Checkpoints prevent repeated work *within a run/item*.
The workflow mini-store prevents repeated pure transformation code. A workflow never treats one as
an informal substitute for another.

---

## 2. Trust evidence: what happened, why the result is credible, and what remains uncertain

### 2.1 Durable `FailureRecord`

A failed task/run persists a structured failure; `span.ended.error?: string` alone is retired.

```ts
export interface FailureRecord {
  failureId: FailureId;
  fingerprint: string;                 // stable normalized task/code/state/element signature
  runId: RunId; traceId: TraceId; attempt: PositiveInt;
  workflowId: WorkflowId; nodeId?: NodeId; taskId?: TaskId;
  code: ErrorCode; summary: string; transient: boolean;
  subject?: { expected?: SubjectEvidenceWire; observed?: SubjectEvidenceWire;
              proofRef?: WriteBindingProofId };
  page?: { screen?: ScreenId; state?: PageStateId; urlRedacted?: string; title?: string };
  action?: { elementId?: ElementId; operation?: UiActionKind; sequence?: PositiveInt };
  causeChain: readonly FailureCause[];  // bounded, typed; hook/decorator errors remain secondary
  diagnosticBundleId?: DiagnosticBundleId;
  remediation: readonly RemediationAction[];
  occurredAt: IsoInstant;
}
```

The event stream carries `{ failureId, code, summary, transient }`; the full record lives in
SQLite/diagnostic storage and is fetched on demand. Failure fingerprints power “same failure seen
before” links without treating message text as identity.

### 2.2 Automatic diagnostic bundle

On an unexpected state, task failure, subject mismatch, recovery park, or operator-requested
snapshot, the kernel captures one bounded bundle:

- failure record and causal chain;
- redacted URL/title, active `ScreenId`/`PageStateId`, and last N driver actions;
- expected vs observed subject proof, or the allowlisted unscoped binding proof for a genuinely
  subjectless file/catalog commit;
- screenshot(s) allowed by sensitivity policy;
- accessibility/DOM excerpt around the failed element, not an unbounded page dump;
- visible error banners and selector recipes attempted;
- relevant browser console/network failures with request bodies/credentials removed;
- parsed input digest and schema/fingerprint—not unrestricted raw SSN/PII;
- descriptor/task/config/build fingerprints, resolved prod/test instance;
- worker, lease, claim generation, clock health, disk/DB health;
- checkpoint ids/freshness/provenance summaries and prior retry lineage.

Bundles are content-addressed and indexed by `DiagnosticBundleId`. Retention is explicit: ordinary
bundles follow notes retention unless pinned by an active knowledge/fix record or a write-recovery
case. Restricted fields are redacted at capture time. Redaction is not deferred to the UI.

### 2.3 `RunEvidenceReceipt`

Every terminal run—success, failure, cancellation, or partial outcome—has a server-derived receipt:

```ts
export interface RunEvidenceReceipt {
  receiptId: EvidenceReceiptId;
  runId: RunId; traceId: TraceId; workflowId: WorkflowId; attempt: PositiveInt;
  generatedAt: IsoInstant;
  descriptorFingerprint: Fingerprint;
  configFingerprint: Fingerprint;
  retryOf?: RunId;
  input: readonly EvidenceFact[];          // redacted canonical values + immutable input hash
  observations: readonly EvidenceFact[];   // source, observedAt, task, checkpoint origin
  decisions: readonly DecisionEvidence[];  // branch/gate/identity/dedupe decisions + reason
  actions: readonly ActionEvidence[];      // external reads/prepares/commits/local projections
  verification: readonly VerificationEvidence[];
  output: readonly EvidenceFact[];
  reuse: readonly ReuseEvidence[];         // fresh live, checkpoint, corrected, prior proof
  warnings: readonly UncertaintyEvidence[];
  confidence: "verified" | "partial" | "unknown";
  result: "verified-done" | "done-with-warnings" | "failed" | "cancelled" | "partial";
}
```

The `verified-done` result key is displayed as **Done** only when the descriptor's declared
completion criteria all have evidence and `confidence === "verified"`. `done-with-warnings` is legal only for
declared, non-load-bearing optional observations whose absence cannot change a transaction or core
result. Unknown/ambiguous mandatory facts force `partial`/`failed`/parked state and can never be
hidden by a green status. A transaction's expected/observed subject and proof source are visible
alongside its receipt. Read-only workflows still show source observations and decisions so their
output is auditable. A receipt invariant test rejects `verified-done` with anything but verified
confidence or any unresolved mandatory evidence obligation.

### 2.4 Rerun transparency

A retry/rerun receipt links to the prior run and shows a field-level diff:

- input changed vs unchanged;
- checkpoint reused vs rerun, with age/freshness/provenance;
- operator-corrected fields and the facts they superseded;
- branch/gate outcomes that changed;
- prior durable write proof reused (therefore no click) vs new fenced write;
- configuration/descriptor/task fingerprint differences.

The dashboard never labels replayed data as newly observed. This is the operator-facing projection
of docs 02/09's provenance and permanent proof rules.

### 2.5 `explain run`

One CLI/API command is the canonical debug entry point:

```text
cli explain run <traceId|runId> [--json] [--bundle <dir>]
```

It resolves the operation tree and prints: current/terminal state, node timeline, checkpoint reuse,
subject bindings, failure fingerprint, last successful action, open gate/dependency, command
history, notification state, write intent/proof, and concrete next safe action. `--bundle` exports a
redacted portable diagnostic package plus a manifest/hash. Codex/Claude prompts reference this
command and the generated catalog instead of asking the operator to manually assemble logs.

---

## 3. Scenario corpus: workflows improve safely as new cases are discovered

### 3.1 `example` is not a scenario

Doc 01's contract `example` remains the canonical happy-path output used for type checks and cheap
stubs. A scenario includes inputs, page/data fixtures, timing/failure injection, expected actions,
evidence, and terminal outcome. The previous plan's hand-scripted failure/cancel matrix is replaced
by a registered corpus rather than remaining an unnamed side list.

```ts
export interface ScenarioManifest {
  id: ScenarioId;                       // "new-kronos/stale-timecard-after-search"
  title: string;
  scope: { taskId?: TaskId; workflowId?: WorkflowId; nodeId?: NodeId };
  kind: "happy" | "expected-absence" | "schema-failure" | "unexpected-state" |
        "wrong-subject" | "transient" | "permanent" | "timeout" | "cancel" |
        "parallel" | "branch" | "gate" | "delegation" | "command" | "proof" |
        "crash" | "recovery" | "storage";
  fixture: FixtureRef;
  input: JsonValue;
  injections: readonly ScenarioInjection[];
  expect: ScenarioExpectation;
  contractFingerprint: Fingerprint;
  requiredAssertions: readonly [ScenarioAssertionId, ...ScenarioAssertionId[]];
  source?: { failureFingerprint?: string; knowledgeId?: KnowledgeId; fixId?: FixId };
}
```

The manifest schema is strict and runtime-parsed. Fixture payloads are sanitized before check-in;
restricted live captures remain local content-addressed artifacts and tests use derived/synthetic
equivalents. `input` is a generic canonical-JSON envelope only because one corpus serves every
contract; corpus load resolves `scope`, parses it through that exact task/workflow input schema, and
stores the parsed value plus schema fingerprint before any scenario can execute.

### 3.2 Minimum scenario coverage

- Every task: happy path, every declared business absence/error code, schema-invalid input/output.
- Every browser task: expected page state, unexpected page state, selector missing, cancellation,
  and subject mismatch for subject-scoped tasks.
- Every transaction: dry-run preview, prepare failure, probe unknown/ambiguous/present/absent,
  probe-age expiry, fence CAS loss, commit failure before/after click, proof failure, crash recovery,
  repeated same key.
- Every child-run/delegation: zero/one/many children, child fail/block/partial policy, parent cancel,
  child retry and parent resume, duplicate fan-out replay, two independent delegations joining.
- Queue/control: stale command version, authoritative target mismatch, DB unavailable, partial bulk
  failure, hide/restore, enqueue coalesce/reject/supersede/parallel.
- Storage: disk full, corrupt DB, missing/torn WAL, failed migration, backup restore, projector lag.

### 3.3 Unexpected states become data, never fallbacks

If a page does not match a declared `PageStateId`, the driver returns/throws `UnexpectedPageState`
with captured evidence and parks/fails according to the descriptor. It does not try an unlabeled
fallback selector and continue. The diagnostic bundle makes the new state observable; when the
operator fixes it, the fix adds a new state/transition or adjusts the existing definition and adds
a scenario. The system therefore grows from real use without silently claiming an unmodeled case
completed.

### 3.4 Bug-to-regression rule

Every non-trivial fix must link to a scenario that failed before and passes after. If the bug cannot
be reproduced safely, the `FixRecord` must say why and link to the closest deterministic invariant
test plus live evidence. A failure fingerprint may not be marked resolved with only a code diff.

---

## 4. Structured knowledge and AI-assisted fix history

### 4.1 LESSONS are migration input, not the new authority

The plan does **not** move `LESSONS.md` wholesale into each rebuilt store. During a store/workflow
migration, each relevant old lesson is triaged into one of three destinations:

1. active reusable guidance → a `KnowledgeRecord`;
2. historical incident/context → incident history linked from a record/scenario;
3. superseded/incorrect/duplicate → retained only in git history, not the generated active guide.

The old file remains authoritative for preserved legacy code. The rebuilt system
uses only the structured store and its generated active view, eliminating a permanent dual source.

```ts
export interface KnowledgeRecord {
  id: KnowledgeId;
  status: "active" | "superseded" | "retired" | "unverified";
  scope: { system?: SystemId; workflow?: WorkflowId; task?: TaskId;
           element?: ElementId; pageState?: PageStateId };
  title: string;
  symptom: string;
  trigger: string;
  rootCause: string;
  invariant: string;
  fix: string;
  regressionScenarios: readonly ScenarioId[];
  evidence: readonly EvidenceRef[];
  verifiedAt?: IsoInstant;
  supersedes?: readonly KnowledgeId[];
  sourceCommits?: readonly string[];
}
```

Records are strict-schema JSON under `knowledge/records/`; one generated `KNOWLEDGE.md` per system
shows **active only** guidance for humans/AI. Incident history and superseded records remain
queryable but are not injected into ordinary prompts/search results unless explicitly requested.

### 4.2 `FixRecord`—what Codex/Claude changed and how it was proven

```ts
export interface FixRecord {
  id: FixId;
  failureFingerprint?: FailureFingerprint;
  status: "draft" | "verified";
  requestedBy: "operator" | "codex" | "claude";
  summary: string;
  affected: readonly (TaskId | WorkflowId | ElementId | PageStateId)[];
  files: readonly string[];
  scenarios: readonly ScenarioId[];
  verification: readonly EvidenceRef[];
  commit?: string;
  knowledge?: readonly KnowledgeId[];
  createdAt: IsoInstant;
}
```

Raw chats, AI explanations, and uncommitted reasoning are never runtime authority. A fix becomes
trusted only through code + schemas + scenarios/tests/live evidence + an optional linked knowledge
record. `status:"verified"` requires a commit id and non-empty verification evidence; an uncommitted
or unproven change remains a visible draft and is excluded from active guidance. `cli explain
failure <fingerprint>` shows prior fixes and whether the same scenario still passes.

### 4.3 Maintenance and search

- New record creation checks for matching scope/symptom/element/scenario before adding; suspected
  duplicates require an explicit supersedes/related link.
- A scheduled/manual audit validates referenced ids/files/scenarios/commits and marks stale records
  `unverified`; it never silently leaves dead guidance active.
- Search defaults to `status:active`, current descriptor/task fingerprints, and the current UI ids.

### 4.4 Optional AI assistance reads the evidence; it never becomes the evidence

The old `services/llm` capabilities are explicitly dispositioned rather than disappearing behind a
proxy. Shared provider/key/rate-limit clients move under infra because OCR and contact normalization
also consume them. The operator-facing adapters remain on-demand and advisory:

| Legacy capability | Native disposition |
|---|---|
| failure triage | optional explanation over a `FailureRecord` + redacted bundle index; cannot set retryability or issue a command |
| run summary | optional narrative over the deterministic `RunEvidenceReceipt`; receipt facts/outcome always render beside it |
| record sanity check | deterministic schema/rule issues are authoritative; optional model issues are separately labelled suggestions and never auto-block/approve |
| selector suggestion | development-only candidate recipe/element-id brief from a redacted accessibility snapshot; it cannot edit the registry or stamp verification |
| contact normalization | doc 06's typed normalization task; every proposed change shows source/confidence and requires the owning review policy |

Every invocation parses a strict request, applies schema-driven redaction **before** provider use,
and parses a closed result. It records `promptTemplateVersion`, redacted input digest/evidence refs,
provider/model, start/end, result-schema fingerprint, and one outcome:
`advisory-produced | unavailable | invalid-response`. Pool exhaustion, missing keys, provider error,
and invalid JSON are visible `unavailable/invalid-response`, never an empty “looks fine” result.
Advisories can be copied into a draft `FixRecord` only by an explicit operator/Codex/Claude action;
they cannot transition a run, resolve evidence, select identity, acknowledge a warning, create a UI
registry entry, or call the command/mutation services.
- A migrated selector/element id updates records through the canonical registry mapping; free text
  is not used as the join key.

---

## 5. Workflow explorer/editor—staged hybrid, one graph

### 5.1 Decision

Build a **read-only workflow explorer in Phase-2 tail 2i**, with closed presentation/policy editing
alongside it after graph, validation, versioning, and evidence are proven. A free-form visual
programmer and DSL/codegen are rejected: graph/composition, arbitrary code, selectors, and
write-proof logic remain reviewed source work.

### 5.2 Phase A—read-only explorer (Phase-2 tail 2i)

The explorer is a projection of the exact descriptor and live span/checkpoint data—not a mined or
parallel graph. It shows:

- workflow input schema, surfaces, identity, enqueue policy, actions, systems, secrets;
- nodes/edges, branch conditions, parallel joins, delegation policies, gates;
- each task's input/output/error/effect/freshness/provenance/scenarios;
- UI elements/page states/observations used by each browser task;
- transaction subject-binding, probe, fence, proof, and dry-run boundary;
- editable vs read-only checkpoint fields;
- source links to descriptor, contract, impl, driver, scenarios, knowledge;
- on a selected live run: the same graph overlaid with timings, attempts, checkpoint reuse,
  failures, children, evidence, and current safe actions.

This serves both operator debugging and AI code changes: “the failure is at
`separations/ucpath-transaction → ucpath.smart-hr.ready-to-submit`” resolves to stable ids and source
locations without reverse-engineering row prose.

### 5.3 Phase B—safe edits only

In Phase-2 tail 2i, the editor may change only a closed, reviewable subset:

- presentation labels/order/grouping and notification preferences;
- choose explicitly allowlisted presentation and operational policy values from closed unions;
- configure descriptor-allowlisted Edit Data fields.

It may not author arbitrary JavaScript, new task implementations, selectors/locator recipes,
page-state evidence, subject matchers, mutation helpers, proof schemas, idempotency keys, or secrets.
Those remain code changes. The editor may generate a patch scaffold naming the exact required files
and failed obligations.

### 5.4 Compile/apply protocol

Every edit is a draft with a base descriptor version/fingerprint. “Validate” runs the same builder,
schema, graph, guard, and scenario checks as source-authored descriptors. “Generate patch” produces:

- canonical descriptor JSON/TypeScript patch;
- human-readable semantic diff (nodes, edges, effects, policies, UI ids, evidence obligations);
- impacted workflows/tasks/scenarios;
- new descriptor version/fingerprint requirement.

> **DSL-authored mode is TRIMMED (D79a, operator 2026-07-24).** This section previously defined
> two authoring modes and a whole second pipeline for the DSL one: exclusive per-workflow mode,
> deterministic codegen into `descriptor.generated.ts`, an isolated-output-directory build,
> restart-gated atomic apply, and exact-hash rollback. It is cut. Two reasons, both from the plan's
> own text: §b question 12 expects everything real to stay source-authored, and the Phase-2 proof
> would have needed a *synthetic* workflow because no real candidate was ever named — a pipeline
> whose only user is its own test. **Every workflow is source-authored.** Reconsideration requires
> a new explicit operator architecture decision; migration questionnaires cannot enable it.

**What remains after the trim.** There are two apply levels. **Presentation-only** changes write the
existing strict versioned override through temp+fsync+atomic-replace and can hot-apply.
**Graph/composition/code-only policy** changes never mutate a live descriptor; the editor emits a
**reviewed code-change brief** and
cannot apply the edit itself. Anything the closed editable set cannot express produces a
**code-change brief**, never partial config and never a second authority.

*(Historical rejected DSL design—do not implement.)*
A DSL draft runs codegen, typecheck, graph guards, the impacted scenario set, and a clean build in an
isolated output directory. Apply atomically stores the prior DSL/version for rollback, writes the new
DSL+generated artifacts, and requires a controlled server restart; it never loads arbitrary code or
hot-switches execution classes. Rollback restores the exact prior DSL/generated hash and re-runs the
same gates. The editor never rewrites handwritten task/driver code. Enqueued runs retain their
stamped descriptor/config snapshot; only new runs after restart use the activated version. A stale
base fingerprint conflicts and must be rebased.

### 5.5 New-workflow authoring path

The same explorer provides a guided scaffold flow so adding a workflow does not begin with string
search and copied boilerplate:

1. choose a unique workflow id/code/category and strict input/result schemas from canonical fields;
2. search registered tasks by intent/system/input/output, inspect their scenarios/UI dependencies,
   and compose task/transaction/branch/parallel/child/gate nodes;
3. define stable item identity, input subject, result derivation, enqueue/actions, delegation,
   freshness, evidence, and notification expectations;
4. receive an automatically generated “missing obligations” list—unbound fields, uncovered branch,
   missing subject observation, result dependency, proof/probe, scenario, UI id, or secret;
5. generate a source-authored workflow/scenario scaffold plus code-change brief; no DSL or runtime
   generated descriptor is produced.

The authoring UI never invents a task because a name looks similar. It shows exact schemas and
requires an explicit binding. New browser behavior starts in the UI registry/driver/task contract,
then becomes selectable by workflows; this is the “fix once, reuse everywhere” path.

### 5.6 What happens to the old workflow modifier

Its useful presentation editing and operation mining are port inventory. The preserved legacy
modifier remains isolated with `src`; it is never proxied or imported. The new read-only explorer replaces mined operations with descriptor tasks and
driver UI ids. Presentation overrides may migrate into Phase B once they round-trip through the
same descriptor projection. Generated `config/workflow-design/*.md` files are not runtime
authority; the descriptor and validated draft history are.

---

## 6. Notifications—durable, event-derived, and actionable

The notification wire is owned by doc 03; this section defines operator behavior. Notifications
are produced server-side from durable state/event transitions, never solely from a React effect.
They survive dashboard reloads and dedupe by stable fingerprint.

Notify only when the operator would need to know or act after missing a toast:

- run failed/Done (`verified-done` key)/Done with warnings/cancelled/partial;
- operator gate opened or resolution failed;
- write recovery needs proof/absence confirmation;
- subject mismatch;
- storage/backup/integrity/disk health failure;
- repeated failure fingerprint crossed a threshold;
- capture or blocking local projection completed/failed.

Transient acknowledgements (“copied”, “saved draft”, “retry requested”) remain ephemeral UI
messages. Every durable notification links to a run/failure/gate/command/storage incident and offers
only actions currently authorized by the server projection. Reading/snoozing affects the
notification, never the underlying run or failure.

---

## 7. Local-FIRST scope, the multi-user seams, and the retained safety floor

**Amended 2026-07-23 (D75).** The operator intends to open this tool to other people later and
wants that to be *configuration, not a second rebuild*. So the scope statement is no longer
"local-only" but **local-first with four deliberate seams**. Everything below about what is *not*
built is unchanged; what changes is that four cheap structural decisions are now load-bearing and
**may never be trimmed as ceremony**, because retrofitting any of them later means touching every
command, every run, and every stored record.

| Seam | What it means today | Why it must exist now |
|---|---|---|
| **Actor attribution** | every command, run, approval, gate resolution, ledger entry, and fix record carries `requestedBy`/`actor`, constant `"local-operator"` | retrofitting an actor onto an existing immutable ledger and command history is impossible — the old rows have no honest answer |
| **One identity checkpoint** | a single auth seam every request passes through, returning the constant local operator | one place to change later; without it, authorization logic scatters across routes |
| **Credential-set-keyed sessions** | browser sessions/logins keyed by credential set, with exactly one set configured | a future user brings their own HR logins and their own Duo; pre-keying makes that config |
| **Per-actor notification/read state** | the inbox is actor-keyed with one actor | read-state is per-person by nature; a global unread flag cannot be split later |

This does **not** soften the safety floor and does not add scope: no RBAC, no permissions UI, no
user management, no teams, no network deployment or TLS, no per-user dashboards, no remote sync.
The dashboard still binds loopback. D79c follows directly from this: commands keep `version` +
`actor` in the wire shape **everywhere**, while CAS enforcement stays only where a real race exists
(cancel-tree, edit-vs-resume, gate resolution, write-recovery) — the seam is in the shape, not in
the enforcement cost.

Not built now: user accounts/RBAC, tenant separation, remote/cloud deployment, distributed
consensus, external audit signing, high availability, public API compatibility, or enterprise
plugin ecosystems.

Still mandatory:

- bind the operator dashboard/API to loopback only; native LAN/remote operator mode is rejected;
- permit exactly one explicit exception: an operator-started, short-lived mobile-capture ingress
  may expose only the token-scoped phone assets/status/upload/replace/reorder/delete/finalize routes
  listed in doc 06 §5.1. The ingress starts with a capture session, expires/stops with it, and cannot
  route to queue, commands, files, evidence, settings, health, or any catch-all route;
- never log/export secrets; restrict and redact SSN/I-9/HR data in notes/bundles/screenshots;
- durable DB integrity/backups/restore because local single-operator state is irreplaceable;
- fail-closed writes, subject binding, typed commands, and immutable write receipts;
- schema validation at every persisted/transport boundary;
- reproducible diagnostics and scenarios.

These are correctness and recoverability requirements, not production-scale ceremony.

---

## 8. Base capability inventory (webpage-ready)

The following is the canonical list Claude may use to build an explanatory webpage. It describes
what the **base** implements before workflow-specific leaf behavior is migrated:

1. Strict runtime-validated domain types and branded ids.
2. Read / prepare / commit task effects with typed inputs, outputs, errors, freshness, provenance,
   examples, and scenarios.
3. Per-system task stores, service stores, and pure workflow mini-stores.
4. Canonical semantic UI registry with stable element/screen/page-state/observation names.
5. Typed system drivers; no raw Playwright page in workflow/task code.
6. Workflow descriptor as the single source for graph, UI, actions, identity, gates, and policies.
7. Typed DAG nodes: read, transaction, branch, parallel join, child run, and gate.
8. Standard delegation contract for one/many children, joins, failure, cancellation, retry, and
   partial outcomes.
9. Workflow-constant input plus typed checkpoint context and start-at-node validation.
10. Field-level provenance, freshness checks, and safe Edit Data patches.
11. Server-authoritative enqueue/coalesce/supersede policies and versioned command engine.
12. Standard queue operations: cancel, retry, bump, hide/restore; destructive purge is separate.
13. Explicit per-workflow worker counts, one active item per worker, visible backpressure, and authored fresh-browser-session boundaries.
14. Page reset/poison isolation and context-exclusive write transactions.
15. Automated Duo login for every authenticated browser session, including production; service-only
    runs do not acquire a browser or invoke Duo.
16. Fail-closed fresh subject binding before every real person/file-scoped write fence; declared
    subject assertions are also available to high-risk reads.
17. Permanent write intents, same-key concurrency fence, typed landing proof, and at most one
    unattended commit attempt per intent generation; recovery needs typed positive proof or a
    sequence of authoritative negative observations all captured after the propagation window,
    otherwise it
    parks, and there is no generic “force done”.
18. Never-pruned ordered actor-attributed write ledger projected from atomic outboxes; hash-chain/
    tail-anchor tamper evidence is deferred until multi-user.
19. Content-addressed immutable artifacts and idempotent outbox-based mutable projections.
20. Append-only span/note streams and server-side queue/timeline/session projections.
21. Durable actor-keyed typed notifications with read/unread state and optional snooze.
22. Structured failure records and automatic redacted diagnostic bundles.
23. Per-run evidence receipts showing inputs, observations, decisions, actions, verification,
    output, reuse, and uncertainty.
24. `explain run`/`explain failure` CLI/API and portable diagnostic export.
25. Registered scenario corpus with wrong-page/wrong-subject/crash/control/storage cases.
26. Bug-fix rule requiring a linked regression scenario or explicit evidence exception.
27. Structured active/superseded/retired knowledge records instead of append-only lessons.
28. AI FixRecord ledger linking code changes, failures, scenarios, evidence, and commits.
29. Read-only workflow explorer overlaying descriptor design and live execution on the same graph.
30. Constrained, versioned editing of closed presentation and operational-policy fields in Phase-2
    tail 2i; graph/composition changes remain source-authored code changes.
31. Operator-defined spreadsheet mappings keyed by stable target-field path (not just concept),
    with projection fingerprints, duplicate-safe source columns, per-cell schema errors, and saved
    layout maps.
32. One command envelope with strict run, gate, notification, and capture arms; typed gate results
    live in authority while events carry only their immutable reference/hash.
33. Raw ingress transformed exactly once into canonical input; every authority read revalidates a
    transform-free/default-free canonical schema and semantic changes require explicit migration.
34. Immutable per-run config/instance snapshots and one injectable clock.
35. Fail-loud fiscal-year configuration and one secrets accessor.
36. SQLite startup doctor, WAL/disk monitoring, native online backups whose completed copy
    self-reports its authority generation, pre-migration backup, tested restore, and read-only
    rescue mode.
37. Full type/lint/architecture/fixture/stub/live guard umbrella with non-vacuity checks, zero-debt
    rebuild linting, and fingerprinted shrink-only legacy test-lint debt during coexistence.
38. Bidirectional runtime/state/import isolation plus one global cutover interlock; no per-run
    legacy/native generation or gradual production flip.
39. Immutable intake admission manifests and hash-diffed reruns showing every valid, rejected, and
    explicitly excluded source row.
40. Guided new-workflow scaffolding with task/schema search and a generated missing-obligations list.
41. Loopback-only single-operator control runtime, with only the short-lived token-scoped mobile
    capture ingress exception; no RBAC/team/HA/remote operator deployment machinery in the base.
42. Generated UI and active-knowledge catalogs plus exact source links for operator/Codex/Claude
    reference—generated views are never a competing authority.
43. Durable restart-safe mobile capture sessions with immutable photo refs, idempotent ordering,
    retryable bundle outbox, and atomic PDF→intake/OCR handoff.
44. Typed contact/address normalization that distinguishes unchanged, ambiguous, and provider-
    unavailable results and preserves the source of every proposed field change.
45. Closed provider capabilities for OCR/geocoding/AI, with narrowed injected clients, infra-only
    SDK/network adapters, timeout/abort/concurrency/rate/cost budgets, preflight, evidence, and
    produced/unavailable/invalid outcomes—remote I/O cannot hide in an import.
46. Optional schema-bounded AI triage/sanity/selector/summary assistance over redacted structured
    evidence; it has no command, identity, registry-write, completion, or mutation authority.
47. Machine-checked legacy capability disposition so every old service/route/UI/CLI/tool is native,
    replaced, retired in the target, or visibly blocking cutover; it never authorizes old-source deletion.
48. One exhaustive runtime-dependency inventory covering every browser system, provider,
    endpoint, env/config/secret consumer, and preflight check in both directions.
49. One typed environment doctor powering startup, Settings health, workflow preflight, and
    `test-login`, with exact blocking capability and remediation instead of scattered checks.

### What is better than the old codebase

- Fix a selector/page-state once in the system driver; every task using the canonical id benefits.
- Fix an operation once in the task store; workflows compose it rather than copy it.
- A field rename breaks consumers at compile time and invalid external/persisted data fails at
  runtime boundaries instead of leaking inward.
- Wrong/stale person pages are blocked by authoritative observed identity, not inferred from what
  the operator searched for.
- Queue/delegation behavior is kernel-owned and uniform instead of workflow-specific route logic.
- A run cannot claim success without evidence; reruns disclose what was reused and why.
- Failures arrive with a stable fingerprint, context bundle, prior fixes, and a safe next action.
- New scenarios discovered during real use become regression fixtures instead of silent fallbacks.
- AI tools read current generated guidance and stable ids, not a pile of contradictory lessons.
- The workflow editor explains the real graph first and edits only what the contracts can prove.

---

## 9. Mechanical guards

Doc 10 registers the following:

- canonical UI ids/search terms unique; every task-used element/state/observation resolves;
- raw `Page`/`Locator` imports and `page.` calls restricted to driver/session infrastructure;
- subject-scoped browser tasks have registered authoritative observations and mismatch scenarios;
- strict runtime schemas parse all UI registry, scenario, knowledge, fix, evidence, failure, and
  diagnostic manifests;
- no persisted free-form `Record<string, unknown>`/`Record<string, JsonValue>` outside an explicit
  opaque diagnostic payload that is never used for decisions;
- every non-trivial fix references a registered regression scenario/evidence exception;
- generated active knowledge contains no superseded/retired/unverified records;
- workflow editor drafts cannot name unregistered tasks/fields/policies and cannot modify active
  run snapshots;
- diagnostic redaction fixtures prove restricted example values never appear in exported bundles;
- durable notifications derive from server events and dedupe/lifecycle transitions are replay-safe.

---

## 10. Explicit residuals

- Locator/page-state correctness still ultimately depends on live system behavior. The registry
  makes evidence, ownership, and reuse explicit; it cannot make a stale live verification current.
- Some pages expose no authoritative subject identity. A subject-scoped write on such a page cannot
  auto-commit; it must gain a verified cross-page observation/proof or park for typed operator
  confirmation. “The search succeeded” is not sufficient evidence.
- A constrained visual editor cannot express every complex workflow. Falling back to reviewed code
  is expected, not a failure of the model.
- Diagnostic screenshots may contain unavoidable HR context. Capture-time redaction/minimization
  reduces exposure but cannot promise perfect visual redaction; restricted bundles remain local and
  short-lived unless pinned.
