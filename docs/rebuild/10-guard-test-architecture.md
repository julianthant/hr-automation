# 10 — Guard & Test Architecture SSOT (`temp_src`)

Status: **revised 2026-07-22 after the whole-plan/legacy-code review.** No `temp_src` guard
implementation currently exists; this document now covers strict schemas, semantic UI/driver
boundaries, subject binding, queue commands/delegation, evidence/scenarios, notifications, and
authority-store recovery in addition to the existing rebuild safety promises.

Owns gap-audit (`08`) BLOCKER #2: ratchet port map, safety guards, descriptor projection coverage,
guard inventory, TDD topology, and stub/live lanes.

## Ownership header (D1)

| | |
|---|---|
| **This doc OWNS** | The test/guard suite: ratchet inventory, strict-boundary/driver/subject/control/delegation/storage guards, transaction/write/outbox/provenance/artifact safety guards, descriptor projection coverage, accidental-shrink meta-test, TDD tiers, scenario/stub/live lanes. |
| **Imports (never redefines)** | Task contract / `effect` / `example` / `fakeCtx` / mutation primitive / dry-run overloads — **doc 01**. Descriptor shape + `descriptor-coverage.test.ts` §1.4 + run-state/checkpoint/delegation — **doc 02**. Span/event schema + command protocol + storage recovery + notifications + completion/lift/dashboard flip — **doc 03**. Pool/lease/sleep-budget guards — **doc 05**. Receipt/idempotency/fence/subject contract — **doc 09**. Clock/config/secrets single-source — **doc 11**. Semantic UI registry, scenarios, evidence, knowledge/fix records, editor projections — **doc 12**. |
| **Charter bindings** | "Same quality umbrella from day one" (every ratchet covers `temp_src` from the first line); "fail loud"; §1a fill/submit split is the dry-run safety model this doc makes a static invariant; §5 descriptor SSOT retires the parity guards. |

**One-sentence thesis.** The umbrella is only real if ONE place owns *how* every doc's per-§ guard
promise actually lands in `tests/unit/architecture/`, extends the 23 existing ratchets to
`temp_src`, replaces parity guards with descriptor projection coverage, and adds the cross-cutting
safety suite: dry-run composition, transaction pairing, typed write safety, permanent-key dedupe,
atomic outbox/ledger projection, field provenance, and stable identity.

---

## 1. The suite today — what `temp_src` inherits (grounded inventory)

`npm run test:architecture` runs `tests/unit/architecture/**` (dot reporter). 23 guard files today,
in four mechanism families:

- **Grep-ratchets** with a per-file `Record<file,{count,reason}>` allowlist, fail-both-ways (a new
  hit OR a stale over-count): `fail-loud-catch-default`, `wait-for-timeout-allowlist`,
  `inline-selectors-workflows` (extends the base `tests/unit/systems/inline-selectors.test.ts`),
  `nullish-literal-data-fallback`.
- **Registry-parity coverage guards** — side-effect-import the kernel registry (`getAll()`) and diff
  it against a hand-list: `instance-labels-coverage` (vs `INSTANCE_LABELS`), `queue-row-kind-coverage`
  (vs `SUBJECT_TO_KIND`), `archetype-coverage`, `runtime-policy-coverage`. **These exist ONLY because
  of the ~10 parallel registries the charter is killing** — they are the ones the descriptor retires.
- **Structural bans / import-boundary guards** (an exact allowlist or SCC set): `cancel-mechanism`,
  `delegate-to-usage`, `delegate-to-all-impl-callers`, `workflow-boundaries`, `control-layering`,
  `import-cycles` (SCC vs `ALLOWED_CYCLES`), `i9-check-import-guard`, `origin-workflow-banned`,
  `evaluate-named-fn`, `tracker-row-emission` (bans `trackEvent`/`appendFileSync` off the typed emit
  path), `deletion-tombstones`, `dashboard-security-boundary`, `code-conventions` (default-exports /
  filenames / no `.tsx` outside dashboard / console guard), `frontend-tailwind-compliance`.
- **The meta-guard** — `gate-coverage` (2026-07-17): pins the *gates themselves* — `typecheck:all`
  runs BOTH `tsc` programs, `lint --max-warnings 0`, the dashboard tsconfig exists. This is the seed
  of the guard-of-guards manifest (§5).

Allowlist discipline (verbatim, ported): every survivor is read-in-context with a one-line reason;
a new occurrence fails immediately and needs the same review, never a silent add.

---

## 2. Ratchet port map

Each existing guard's fate. **Every fail-loud ratchet must cover `temp_src` from day one** (charter):
ported grep-ratchets extend their glob to `temp_src/**` with a **ZERO allowlist for new `temp_src`
code** and shrink-only entries for verbatim-ported leaves. They are activated atomically with the
first file in their target family; every active scan must prove its resolved file set is non-empty.
Before activation, a missing `temp_src` is an explicit planned state—not a swallowed `ENOENT`.

| Today's guard | Fate | How, under the new kernel |
|---|---|---|
| `fail-loud-catch-default` | **EXTEND** | glob += `temp_src/**`; zero-allowlist for new code. The single most important ratchet — it is what makes doc 09's probe safe (a `catch{return notFound}` on an idempotency probe is banned here). |
| `nullish-literal-data-fallback` | **EXTEND** | scan all `temp_src/**` except dashboard presentation code; zero-allowlist. This ratifies the Step-1a correction—the old five-folder subset silently omitted `base`, `exec`, `events`, `server`, `intake`, and `forms`. |
| `wait-for-timeout-allowlist` | **EXTEND** | glob += `temp_src/stores/**`; **zero-allowlist new** (doc 05 §7 #3); shrink-only ported. Doc 05 adds the per-task `sleepMs` budget ratchet beside it. |
| `inline-selectors-workflows` (+ base) | **RE-DERIVE, STRONGER** | task impls may contain neither raw selectors nor Playwright `Page`/`Locator` calls. Selectors are private to `stores/<system>/driver/**`; tasks call typed semantic driver methods (docs 01/12). Driver selector literals must belong to the canonical UI registry entry they implement. |
| `evaluate-named-fn` | **PORT** | glob += `temp_src/stores/**`; unchanged rule (`__name` in `page.evaluate` still throws live). |
| `import-cycles` | **EXTEND** | SCC over `temp_src/`; `ALLOWED_CYCLES` starts empty for the new tree. |
| `control-layering` | **EXTEND → matrix** | absorb gap-audit `08` #9: enforce the full `domain → infra/services/systems → core → control/workflows` direction over `temp_src` (today only the `control` edge is guarded). |
| `code-conventions` | **EXTEND + FIX MATCHING** | same rules over `temp_src` (no default exports, kebab/Pascal filenames, no `.tsx` outside dashboard, console guard). Replace `path.includes(prefix)` exemptions with normalized repo-relative exact roots/segments: today's `/scripts/` exemption must not pre-authorize a future `temp_src/**/scripts/**`. |
| `cancel-mechanism` | **RE-DERIVE** | the one-mechanism invariant re-expressed against doc 05's executor + `runRegistry` successor; still a structural ban on a second cancel path. |
| `delegate-to-usage` / `delegate-to-all-impl-callers` | **RE-DERIVE** | delegation is now workflow-composition (docs 01/02). Re-expressed as "child runs enqueue only via the kernel composition API," but note: peer-to-peer store reuse is now *allowed* (charter §1), so the old "no cross-workflow internal import" shape loosens — see `workflow-boundaries`. |
| `workflow-boundaries` | **RE-DERIVE (loosened)** | charter §1 makes tasks peer-reusable, so importing another workflow's *task contract* is legal. New rule: a workflow may import another's **contracts** and store tasks, never its `descriptor.ts` internals or non-task private helpers. |
| `tracker-row-emission` | **RE-DERIVE** | archetype-stamping is gone; the new invariant is doc 03's: writes go only through the typed span-emit path, `appendFileSync` to event JSONL banned outside `temp_src/tracker/`. |
| `deletion-tombstones` | **RE-DERIVE** | UI exposes reversible `hide/unhide`, never ambiguous Delete. No physical delete of authority/audit tables in runtime code; the exact-id offline purge command requires a verified backup and emits a purge receipt (doc 03 §2.4). Legacy tombstones remain lift-only. |
| `dashboard-security-boundary` | **RE-DERIVE FOR LOCAL SCOPE** | Native server binds loopback only, accepts same-origin UI requests, and never grows a LAN/multi-user/auth surface accidentally. During scoped flip, any retained legacy middleware stays correctly ordered behind the native loopback boundary; native Phase 1 does not build a user/account system (docs 11/12). |
| `frontend-tailwind-compliance` | **EXTEND** | over `temp_src/dashboard`. |
| `i9-check-import-guard` | **GENERALIZE** | a descriptor with no transaction/commit contract is structurally read-only; graph coverage proves it cannot reach a mutation capability. |
| `origin-workflow-banned` | **DROP-OR-PORT** | the lineage field it bans does not exist in `temp_src`; keep a banned-term guard only if the concept resurfaces. Decide at Phase 1. |
| `archetype-coverage` | **RETIRE → descriptor** | `descriptor.surface.shape` is the SSOT (§4). |
| `runtime-policy-coverage` | **RETIRE → descriptor** | shape/actions/gates read off the descriptor (§4). |
| `instance-labels-coverage` + `INSTANCE_LABELS` | **RETIRE → descriptor** | label = `descriptor.sessionLabel ?? label` (doc 02 §1.3). |
| `queue-row-kind-coverage` + `SUBJECT_TO_KIND` | **RETIRE → descriptor** | kind derived from `descriptor.inputSubject` inside descriptor-coverage. |
| `gate-coverage` (meta) | **KEEP + EXTEND** | becomes the guard-of-guards manifest (§5): also asserts `test:architecture` still globs `temp_src`, each activated arm resolves ≥1 file, ESLint's command *and actual config* cover `temp_src`, and every named guard file exists + is registered. |
| — | **NEW** | `descriptor-coverage`, `strict-boundary-schemas`, `semantic-ui-registry`, `task-driver-boundary`, `subject-before-fence`, `scenario-coverage`, `control-command-single-path`, `authority-target-no-fallback`, `delegation-manifest`, `storage-recovery`, `notification-durability`, `evidence-receipt`, `knowledge-fix-integrity`, `workflow-editor-compile-integrity`, `legacy-capability-disposition`, `capture-durability-and-scope`, `ai-advisory-no-authority`, `preflight-coverage`, `dry-run-composition-submit-free`, `transaction-pairing`, `write-safety-contract`, `commit-routes-through-mutation`, `no-positional-identity`, atomic-outbox/ledger guards, `clock-single-source`. |

---

## 3. The NEW safety guards (don't exist today, even in spec)

No architecture guard references `dryRun` today; the entire dry-run safety model rests on it. Each
guard below keys off a **closed union** (the contract `effect`, the sealed mutation-primitive
registry, the descriptor node list) — never a text heuristic — so it cannot false-positive on prose.

### 3.1 `dry-run-composition-submit-free.test.ts` — charter §1a as a static invariant

**Thesis: a workflow's dry-run composition provably contains NO reachable submit — the dangerous
action is *absent by construction*, not skipped by a branch.**

For every descriptor, compile the executable graph with `RunEnvelope.dryRun=true`. Assert:
1. each reachable transaction becomes a preview containing its prepare arm only;
2. zero commit contracts, mutation capabilities, fences, or mutation-helper imports are reachable;
3. `dryRun:"unsupported"` transactions fail planning before browser launch; and
4. downstream continuation is legal only when it has no dependency on commit output.

Mutation helpers require a commit-only capability, so the runtime type boundary backs the graph
proof. The live lane asserts prepare spans/preview evidence exist while commit spans/intents do not.

### 3.2 `transaction-pairing.test.ts` — prepare and commit share one lease scope

**Thesis: every real submit has a paired fill; you cannot compose a submit whose fill is absent.**

Every prepare contract appears only in `transaction.prepare`; every commit only in
`transaction.commit`. The pair uses one system and one transaction-scoped lease, has no
checkpoint/gate between arms, binds commit input only from workflow input+declared upstream outputs
(never prepare output), and exposes only commit output downstream. There is no atomic-write
allowlist: a one-click write uses a no-op prepare so dry-run still has an honest preview.
Prepare/commit impls have no task-local retry; an optional transaction retry may rerun the whole
preflight+prepare on a reset lease only before a write intent exists. Runtime fixtures prove the
live probe uses/releases a read lease before transaction acquisition, `probeToFenceMaxMs` is
positive, expiry or a lost fence CAS discards staged state with zero clicks, and cleanup/reset never
occurs between prepare and commit.

### 3.3 `write-safety-contract.test.ts` — completion union + fenced, evidence-qualified recovery (HOSTS doc 09's guard)

**Thesis:** every `effect:"commit"` contract has write safety; no escape hatch. Every completion
arm—receipt/save/upload—has a nontrivial `proofSchema`, normal-output extractor, recovery-probe
extractor, `outputFromProof` reconstruction, and same-store live probe.

- `receipt` (UCPath / ServiceNow) — a non-empty proof schema. Unit-pinned: a commit returning success with proof
  failing its schema throws.
- `save-verify` / `upload-verify` — a read task returning `ProbeVerdict` plus a typed state/artifact
  proof schema. These satisfy the guard without a confirmation number,
  demanding a `receipt` of them would be a guard bug (a type-level test pins that). They still can't
  pass without *earning* a post-submit read-back that doesn't exist today — so the guard forces doc
  09's one genuine addition rather than waving them through.
- `upload-verify` carrying **`unverifiableByPage`** — legal ONLY with an allowlist + `{ reason }`
  entry (§3.5) and a guard-parsed operator-attestation proof example; the submit then always-parks,
  never auto-`done`.

The crash-recovery fixture injects `write.attempting`-without-`write.committed` and asserts: the probe
re-runs FIRST (probe-then-park, D17); a `present` receipt and reconstructed transaction output are
schema-validated before backfill (D19);
one early/bare `absent` cannot authorize a retry; only D64 schema-valid same-key negative evidence
that clears the contract's propagation window and repeated-read policy may mark retryable, while
inconsistent/malformed/`operator-only` absence parks; and simultaneous **or later sequential**
same-key runs cannot create a second fence. Crash
injection proves intent/checkpoint/ledger-outbox/span-outbox atomicity. Parked-write fixtures prove
generic Done/Retry is absent; present proof uses the same parser/atomic commit, absent evidence is
intent-generation/version locked, and stale/double-click resolution changes nothing. A preflight
live `present` fixture atomically records `observed-present` + an `already-present` transaction
outcome but asserts zero write-ledger outboxes, so observation cannot masquerade as filing.

### 3.4 `no-positional-identity.test.ts` — items/checkpoints keyed by stable id, never index

**Thesis (the docs-1/2 invariant): identity is a stable key, never an array position.** A row keyed
by index silently binds the wrong person when the list reorders — the class of the real wrong-person
incident. Guard: ban `members[<int>]` / `items[<int>]` / `checkpoints[<int>]`-style positional lookups
as a row/checkpoint **identity** in `temp_src/{core,workflows,stores,tracker}/**` (iteration is fine;
using the index as the persisted key is not). Structurally reinforces doc 02's `(workflow, item_id)`
logical key (D9) and doc 03's `(runId, attempt, spanPath)` span identity (D10) — both are id-keyed.

### 3.5 `unverifiableByPage` requires an allowlist + reason (D22 — closes the verify escape hatch)

Doc 09's `upload-verify.unverifiableByPage` is the one place a commit contract may declare "this page
genuinely cannot prove landing" and fall to always-park. Left unguarded it is a silent escape from
proof-of-landing (review 09 #5). Ratchet: any `completion` carrying `unverifiableByPage` MUST have a
matching `Record<contractId, { reason }>` allowlist entry and its
`operatorAttestationExample` MUST parse the proof schema's operator-attestation arm, fail-both-ways: a
new `unverifiableByPage` with no argued entry fails, and a stale entry whose contract dropped the
flag fails the reverse. "We can't verify this write" becomes a reviewed, enumerated decision, never a
quiet default — today only OnBase is a candidate, and it must earn its line.

### 3.6 `commit-routes-through-mutation.ts` (D22 — closes the fence-bypass overclaim)

Doc 09's fence-before-click is only "unbypassable" if every real submit actually goes through the
sealed `stores/common/mutation.ts` primitive, which requires the open-intent capability. A leaf
could otherwise fire a raw click. Ratchet: every `effect:"commit"` impl must route its transaction
action through the mutation module—an import/capability graph check. Driver methods capable of a
click/press-class external submit require that capability in their public signature and reach the
sealed primitive internally; a commit impl or driver reaching such an action without it fails. This
complements the raw-page boundary (§2): raw clicks live only in driver internals, and external-write
clicks additionally require the one fenced choke point. Together they make doc 09's
"fence-before-click is unbypassable" a structural fact.

### 3.7 `artifact-effect-boundary.test.ts` — downloads are immutable; mutable files are projections

Read contracts that materialize bytes must declare `artifacts:"content-addressed"`; only the kernel
writer may be reachable from their impl import graph. Direct filesystem write/append imports in task
impls fail, and workflow mini-stores cannot declare artifacts. Descriptor artifact projections are
validated against exact producing node/field and stable non-positional key paths. Fixtures prove
checkpoint+outbox atomicity, duplicate-delivery idempotence, one active projector per sink,
head-hash conflict parking without overwrite, and that `blocking:true` prevents terminal done until
projection acknowledgement. This keeps i9's workbook update from being mislabeled as a retryable
read while still permitting replay-safe browser downloads.

### 3.8 Strict schemas + semantic driver/UI registry

- **`strict-boundary-schemas.test.ts`.** Enumerate every external/durable boundary export (workflow
  input/result, task input/output, run envelope, checkpoint, command, event/note, SSE wire,
  settings, intake, artifact, evidence/failure, notification, knowledge/fix). Each must expose a zod
  schema and infer its TypeScript type from that schema. Object schemas are strict; discriminated
  unions are exhaustive; unknown keys fail. AST guards reject exported persistence/wire interfaces
  with no schema, decision-bearing `Record<string,unknown|JsonValue>`, `any`, unchecked `as`, and
  catch/default parsing at these seams. Runtime corruption fixtures exercise JSONL, SQLite, HTTP,
  SSE, and config reads.
- **`canonical-input-snapshot.test.ts`.** Ingress input applies defaults/coercions/transforms once;
  the stored canonical value round-trips through the descriptor's validation-only `canonicalInput`
  schema on every DB/resume read. A deliberately non-idempotent transform proves resume does not
  reapply it; a corrupted stored value proves validation is not skipped (D62).
- **`semantic-ui-registry.test.ts`.** Every driver action/observation/page-state dependency resolves
  to one same-system canonical registry id. IDs/aliases are unique; aliases cannot form chains or
  cycles; entries have owner/intent/state/selector-strategy/verification metadata and scenario refs.
  Generated `UI-CATALOG.md` must match the registry. Removed ids require an explicit versioned alias
  or a migration that updates all dependents—never a second name for the same element.
- **`task-driver-boundary.test.ts`.** Task/workflow modules cannot import Playwright types, driver
  internals, selector registry implementation, or call `locator/newPage/evaluate` directly. Public
  driver signatures reject selector strings, Page, Locator, and untyped maps; they expose domain
  inputs/outputs and semantic ids. Driver internals remain the sole allowlisted raw-page area.

### 3.9 Subject binding, control commands, and delegation

- **`subject-before-fence.test.ts`.** Every prepare/commit contract has compatible subject specs;
  every write observation resolves to a driver operation. A transaction trace must order
  prepare-end < fresh subject-match < fence-commit < mutation-call on the same lease/run/attempt.
  Mismatch, unknown, missing/stale observation, navigation after proof, or changed attempt produces
  zero fence/click and a structured failure/evidence bundle. Alternating-EID pooled-page and
  file-digest mismatch scenarios are mandatory. A commit with `subject.kind:"none"` instead needs
  a fail-both-ways allowlisted reason and exact staged-page-state `UnscopedBindingProof`; every
  mutation capability is bound to one `WriteBindingProof` digest, never an empty subject placeholder.
- **`control-command-single-path.test.ts`.** Dashboard/CLI/gate/recovery/notification/capture
  modules can mutate authority only through doc 03's D67 command family. Command ids are idempotent
  and target versions are CAS
  checked. Hide is presentation-only; runtime physical deletes and UI label `Delete` fail. Enqueue
  policies get transaction/concurrency fixtures, including an injected active-run lookup error that
  must create zero new runs. Coverage is bidirectional over every mutating route/action; typed gate
  results parse the descriptor result schema and store a checkpoint/ref, notification snooze cannot
  use an acknowledge payload, and capture mutation cannot target a run id.
- **`authority-target-no-fallback.test.ts`.** Cancel/cascade/retry/bump resolve exact targets and
  dependency trees from SQLite. Fixtures make the DB unavailable/inconsistent and pass tempting
  caller-visible roots; the expected result is zero transitions + typed error, never a fallback.
- **`delegation-manifest.test.ts`.** Every child-run has stable edge/item ids, concrete input/result
  schemas, explicit cardinality/join/failure/cancel/retry/visibility policies, and an atomic immutable
  manifest. Scenario matrix covers zero/one/many, duplicate replay, partial failure, all vs
  all-settled, cascade/independent cancel, child retry, parent resume, and two distinct edges.

### 3.10 Trust surfaces: storage recovery, scenarios, evidence, and notifications

- **`storage-recovery.test.ts`.** Boot quick-check/invariants fail closed into read-only degraded
  mode. Online backups are checksummed/manifests verified. A restore drill corrupts a copied
  real-shaped DB, restores the newest verified backup, rebuilds projections only, and proves
  commands/dependencies/checkpoints/write-intents/outboxes survive. No code path creates a fresh
  empty authority DB over an invalid existing file.
- **`scenario-coverage.test.ts`.** Descriptor/task/UI entries reference real, unique, strict
  `ScenarioManifest`s. Every task has happy/empty or no-match/schema-failure/transient/permanent
  coverage as applicable; every write has subject/proof/crash cases; every branch/delegation/gate
  arm is covered. A production bug fix cannot close without a regression scenario id in its
  `FixRecord`. Orphaned, stale-fingerprint, and never-executed scenarios fail.
- **`evidence-receipt.test.ts`.** Every terminal run produces a strict receipt with input/config/
  graph fingerprints, node outcomes, provenance, artifact/proof/failure refs, exclusions, and an
  explicit confidence (`verified|partial|unknown`). `done` requires all mandatory evidence and no
  unresolved write/subject/storage condition. Diagnostic bundle tests prove schema redaction and
  assert no env/cookie/storage-state/raw-SSN leakage.
- **`notification-durability.test.ts`.** Each closed trigger commits a durable inbox item; dedupe,
  ack/snooze/resolve, delivery retry, redaction, and run/failure links are pinned. An injected OS
  delivery failure must leave the critical inbox notification unread and retryable.
- **`knowledge-fix-integrity.test.ts`.** Knowledge records have status/scope/evidence/validity and
  supersession refs; no two active records may claim the same scoped rule without an explicit
  conflict. Fix records link failure, changed contracts/UI ids/scenarios, verification, and commit.
  A verified FixRecord requires a commit plus non-empty evidence; drafts stay out of active
  guidance. Raw chronological lesson append is not accepted as active architecture authority.
- **`workflow-editor-compile-integrity.test.ts`.** Read-only explorer projections round-trip from the
  real descriptor/contract/UI registries. Editable drafts are strict closed-DSL documents with a
  base fingerprint; compile validates every task/UI/scenario/delegation reference and emits a
  deterministic generated artifact. Stale-base apply, handwritten generated-file edits, unsupported
  node kinds, or an apply without a reviewed semantic diff all fail. Rollback restores the exact
  prior version and re-runs descriptor/scenario coverage (doc 12 §5).

### 3.11 Old-capability closure, mobile capture, and advisory AI

- **`legacy-capability-disposition.test.ts`.** Doc 07 §3.6's strict inventory covers every old
  workflow directory, `services/*` module, route file/endpoint family, top-level dashboard component
  family, CLI subcommand/ops script, exporter/codegen/maintenance/dev tool exactly once. New legacy
  paths fail until classified. A proxy requires a concrete removal milestone and native
  disposition. Final-delete mode rejects proxy/undecided entries, missing native/replacement
  targets, retirement without evidence, duplicate path ownership, or a CLI/navigation inventory
  mismatch. This is the mechanical proof that “all workflows migrated” did not forget supporting
  capabilities.
- **`capture-durability-and-scope.test.ts`.** Capture session/photo/finalization schemas are strict
  authority; commands are idempotent and version-CAS checked; photo refs are content-addressed;
  finalize reaches bundle/artifact/intake enqueue only through one stable outbox. Crash/restart
  fixtures at every publish/DB boundary converge to one artifact and one handoff. Phone-origin
  route enumeration is fail-closed: every allowed route is token-scoped and every non-capture,
  operator-only, catch-all, or newly added route returns unavailable externally until explicitly
  reviewed. Expiry uses the Clock and cannot race a finalizing handoff into deletion.
- **`ai-advisory-no-authority.test.ts`.** AI request/result schemas apply redaction before the
  provider call and distinguish produced/unavailable/invalid-response. Import/capability graph checks
  prove advisory modules cannot reach command, gate resolution, workflow state, UI-registry writes,
  subject matching, completion confidence, or mutation capability. Fixtures inject missing keys,
  quota exhaustion, provider errors, malformed output, and prompt injection text; deterministic
  evidence/rules remain unchanged and no empty result is interpreted as “safe” or “no issue.”
- **`preflight-coverage.test.ts`.** Every descriptor-derived secret/system/feature prerequisite and
  every blocking runtime capability resolves to one registered preflight check; every check has a
  consumer and scenario. Dashboard boot, workflow enqueue, Settings health, CLI doctor, and
  `test-login` project the same report contract. Fixtures prove optional-feature failure cannot
  block an unrelated workflow and required failure cannot launch a browser/worker. Direct scattered
  prerequisite checks and auto-repair side effects outside the registry fail the architecture scan.
- **`provider-capability-boundary.test.ts`.** Every service task with remote I/O declares a D63
  capability and receives only its narrowed injected client. Direct provider SDK/raw network imports
  are allowed only in registered `infra/providers/**` adapters. Every capability has timeout/abort,
  concurrency/rate admission, config/secret preflight, redaction, evidence, and unavailable/invalid
  scenarios; every adapter has a consuming contract. Scheduler fixtures prove an exhausted provider
  cannot bypass its global budget or occupy a lane indefinitely.
- **`runtime-dependency-coverage.test.ts`.** D68 compares the closed BrowserSystemId/provider sets,
  endpoint route schemas, secret/config registries, preflight checks, and legacy env/capability
  inventory in both directions. A missing ServiceNow/SharePoint/Old-Kronos endpoint or provider key,
  an unregistered `process.env` read, and a stale registry entry all fail with the exact owner.

---

## 4. `descriptor-coverage.test.ts` — the ONE guard that replaces the parity guards

Owned by **doc 02 §1.4**; this doc owns the **crosswalk** (which old guards it retires) and the
**exhaustiveness argument**. A table-driven test over the core composition-root registry and its
generated client projection. It is exhaustive because every named projection in this matrix is derived
from the descriptor, and the guard walks the whole projection set—a descriptor that fails to
project any surface fails the build:

| Projection (the surface) | Old parallel list it kills | descriptor-coverage check (§1.4) |
|---|---|---|
| id + `code` (trace prefix) | `operationTraceCode` switch | ids unique; codes unique + 2 chars (#1) |
| `icon` | `WORKFLOW_ICONS` | `icon ∈ ICON_NAMES` exhaustive (#1) |
| `label` / `sessionLabel` | `INSTANCE_LABELS` | `sessionLabel ?? label`; round-trip (retires parity) |
| `inputSubject` → queueRowKind | `SUBJECT_TO_KIND` | kind derived, not hand-listed (retires parity) |
| `surface.shape` (archetype) | archetype hand-decl | shape read off descriptor (retires parity) |
| run surfaces (`inputRun`/`uploadRun`) | `INPUT_RUN_REGISTRY`, `RUN_MODAL_REGISTRY`, the two `DASHBOARD_*_WORKFLOWS` lists | pure `DESCRIPTORS.filter(...)` derivations (#2) |
| steps + gates (timeline source) | step-label switches (`formatStepName`, `types.ts:405`) | node ids unique; labels from contract `title`; timeline computed from spans + these (#3/#4) |
| `systems` (session planner input) | hand `systems:` list | derived union of contract `<system>/` prefixes; each a known `SystemId`/service store (#4) |
| `verdicts` | `queue-row-status-index` + `statusExtensions` | closed tuple keys unique; emitted verdict must belong to descriptor (doc 03) |
| `completion` targets | OCR approve branching | targets typecheck vs target descriptors' strict `input` and terminal `result` (#5) |
| graph branch/fork/child/gate subscriptions | handler-side delegation and wait registries | all edges/joins/targets/results/policies typed and validated; target input/result generics may not erase to unknown |
| scenario corpus + minimal happy stub | e2e stub map | examples seed the minimal happy execution; descriptor references every branch/delegation/gate/control scenario in the checked manifest corpus (§7) |
| runtimePolicy actions | `runtime-policy-coverage` | actions/gates read off descriptor (retires parity) |
| `details`, capabilities, coordinator, completion-consumption, artifact projections | detail/runtime-policy special cases and i9 retention append | every emitted detail/action/member/coordinator projection validates; Edit Data paths exist in producing schemas and exclude identity/idempotency/proof/provenance; artifact source/key paths exist in exact node outputs and every sink kind resolves |
| `enqueue`, actions, delegation policies | workflow-specific route/control handlers | only closed doc 03 policies/actions; every action projects the standard CAS command target and no custom row mutation callback exists |
| task UI dependencies + subjects | selectors/helpers scattered through workflows | every semantic id resolves in the same-system driver registry; every write has an enforceable subject observation; raw page access is absent |
| workflow terminal `result` | parent reading child tracker blobs | strict result derives only from declared terminal dependencies and every awaited child consumes that exact schema |
| evidence requirements | implicit “done means probably okay” | required receipts/proofs/artifacts/failure/confidence project from the descriptor/contracts; terminal completeness validates |
| presets, match key, item-id derivation | per-workflow input/control registries | input presets parse; identity functions return stable non-positional ids |
| presentation/queue title/operator subject | queue presentation switches | client projection carries resolved policies; no workflow-id branching in components |
| version/fingerprints | implicit deploy compatibility | stamped consistently into run/checkpoint/span/client projection; clean-checkout reproducibility + source/schema-change sensitivity prove deterministic manifest (no path/mtime/function-string input) |

Plus two guarantees: bundle-safety—descriptor modules import only zod/domain; the core registry
is the only layer importing workflows, and the dashboard imports only generated/wire projections.
A **new-hand-list
ratchet** — any object literal in `temp_src/` (outside `descriptor.ts`/`workflow-registry.ts`) whose
keys include ≥3 known workflow ids fails with "derive it from DESCRIPTORS instead." That ratchet is
is a smell detector, not the completeness proof: it misses arrays, maps, JSON, and one/two-workflow
exceptions. The explicit projection matrix above and source-surface inventory are authoritative.

---

## 5. The guard-of-guards manifest — accidental shrink protection, not an undeletable law

Rot vector: a guard file is deleted, renamed, or dropped from the `test:architecture` glob, and
nobody notices the umbrella shrank. Extends the existing `gate-coverage` meta-guard.

`docs/rebuild/guard-inventory.json` is the reviewed design inventory (owner, invariant, replacement
required on removal). `tests/unit/architecture/guard-manifest.test.ts` loads it rather than defining
a second inline name set. The test asserts:
1. every inventory name maps to a real file under `tests/unit/architecture/`;
2. every `*.test.ts` file present is in the inventory (no unregistered guard — forces a
   conscious add, and forces this doc's inventory to stay honest);
3. `test:architecture` in `package.json` still globs the directory (a rename can't orphan the suite);
4. every active `temp_src` scan resolves at least one file; a family is activated in the same commit
   as its first file, and `ENOENT`/an unmatched glob is never converted to green;
5. the `temp_src`-scoped ratchets (the extend-set in §2) each still include a `temp_src` glob token,
   so nobody can quietly narrow a ratchet back to `src/` only during the dual-maintenance window;
6. `gate-coverage`'s existing assertions (both `tsc` programs, `--max-warnings 0`) are kept inline;
7. ESLint's CLI target and the matching `eslint.config.js` typed rule block both include `temp_src`.

ESLint's known empty-pattern behavior is part of the ordering contract: no unmatched `temp_src`
argument is added before the first real file, and `--no-error-on-unmatched-pattern` is forbidden.
The first file, CLI target, and full config coverage land atomically.

The manifest prevents accidental file deletion, rename, or glob orphaning. It **cannot** prevent a
deliberate coordinated edit that deletes both a guard and its inventory entry; no self-owned test can.
Guard removal therefore requires an explicit architecture decision entry naming the retired
invariant and its replacement/manual rationale, checked by CI for removed inventory keys and by
code review. The plan makes no stronger mechanical claim.

### 5.1 The full registered set — where every doc's guards converge

The inventory is the one machine-readable place the umbrella is enumerated. Each doc owns its guards'
contracts; the manifest owns that they exist and stay wired. The set (contract-owner in parens):

- **Ported/extended ratchets (this doc, §2):** `fail-loud-catch-default`, `nullish-literal-data-fallback`,
  `wait-for-timeout-allowlist`, `inline-selectors-workflows` (+ systems base), `evaluate-named-fn`,
  `import-cycles`, `control-layering` (+ layer matrix), `code-conventions`, `cancel-mechanism`,
  `delegate-to-usage`, `delegate-to-all-impl-callers`, `workflow-boundaries`, `tracker-row-emission`,
  `deletion-tombstones`, `dashboard-security-boundary`, `frontend-tailwind-compliance`.
- **New safety guards:** `dry-run-composition-submit-free`,
  `transaction-pairing`, `write-safety-contract` (typed proof on every union arm + the
  `unverifiableByPage` allowlist), `commit-routes-through-mutation`, atomic-write-outbox,
  permanent-key sequential/concurrent dedupe, recovery-negative-proof-settlement,
  ledger-projector concurrency/tail-anchor,
  `no-positional-identity`, `edit-data-field-policy`, canonical-input-snapshot (raw + parsed +
  ingress/canonical schema hashes; resume validates but never reapplies defaults/transforms),
  `strict-boundary-schemas`,
  `semantic-ui-registry`, `task-driver-boundary`, `subject-before-fence`,
  `control-command-single-path`, `authority-target-no-fallback`, `delegation-manifest`,
  `storage-recovery`, `scenario-coverage`, `evidence-receipt`, `notification-durability`,
  `knowledge-fix-integrity`, `workflow-editor-compile-integrity`, `legacy-capability-disposition`,
  `capture-durability-and-scope`, `ai-advisory-no-authority`, `provider-capability-boundary`,
  `runtime-dependency-coverage`, and `preflight-coverage`.
- **Descriptor SSOT (doc 02):** `descriptor-coverage` — replaces `archetype-coverage`,
  `runtime-policy-coverage`, `instance-labels-coverage`, `queue-row-kind-coverage`, `i9-check-import-guard`.
- **Task-store guards (doc 01):** pairing, reachability, bundle-safety, `example`-parse, freshness,
  verb↔effect, `KnownTaskId` stringly-dispatch ratchet, `z.record` output ban, auth-boilerplate ban,
  UCPath-selectors pure-re-export, undeclared-error-code type-test, commit-capability boundary,
  declared-secret reachability (every `requireSecret` name appears in its contract and descriptor union),
  provenance-policy coverage (pure/service/workflow transforms cannot declare live observation without
  an allowlisted authoritative source operation; derived outputs retain oldest input provenance),
  canonical-output-no-any, content-addressed-artifact boundary (direct mutable filesystem writes in
  task impls fail; workflow mini-stores cannot declare artifacts), provider-capability declaration/
  injection boundary.
- **Event/dashboard guards (doc 03):** dashboard-component purity (no `workflow ===`), client
  re-projection import-boundary, identity-on-patch throw, undeclared-vocabulary emit-validation,
  sealed-completion (`defineFormSpec`, + oath-upload & verify pinned to NO `CompletionProgram`),
  lift-adapter deletion ratchet, legacy-schema-version bump+adapter+fixture coverage,
  notes-not-a-data-channel, non-recursive wire type-test,
  real-tracker-day zero-quarantine replay fixture, command CAS/idempotency/enqueue policies,
  authority target fail-closed behavior, durable notification delivery, SQLite backup/restore
  drill, D13 golden-payload parity gate.
- **Local artifact projector guards (docs 03/06):** stable non-positional outbox key, checkpoint+
  outbox atomicity, duplicate-delivery idempotence, single projector per sink, workbook head-hash
  conflict parks without overwrite, and blocking projection ack before terminal done.
- **Parallelism guards (doc 05):** driver-lease/raw-Page boundary, subject observation ordering,
  per-contract sleep budget, single-flight
  login, onbase-`exclusive` lease, `newPage(` ratchet, fan-out-starvation, pool-size `// verified` config,
  bounded task/transaction deadline, executor teardown soak, lane-overlap.
- **Meta (this doc):** `gate-coverage` + `guard-manifest` itself.

A guard added to any doc that never lands in the inventory fails the manifest — so a doc's §guards
promise cannot quietly stay a promise.

---

## 6. TDD topology for `temp_src` — four tiers, each an owned home

"Same quality umbrella, made concrete." A new task or workflow is built **test-first** against these:

1. **Pure-logic unit** — `task.impl.run({ input, ctx: fakeCtx })`. Doc 01 §7B makes every task run a
  plain-object call; the `fakeCtx` contract uses the matching effect-specific ctx with a fake typed
   `driver`/`recordData` and, only for commit tests, an explicit test mutation capability.
   No fake Page/Locator is exposed. `dryRun` is
   never a ctx flag; it changes graph composition before execution.
   "Pure logic extracted and unit-tested" = the impl's decision logic is a pure
   function the run composes, tested with a fake ctx and no browser — the *primary* hardening tier
   (charter #2: types first, then this).
2. **Contract / type** — every contract's mandatory `example` parses through its own `output` schema
   (doc 01 guard #4); type-level tests pin that undeclared `errorCodes` fail `tsc`, a commit
   contract missing typed completion proof fails the write-safety guard, and no task ctx has a `dryRun` member
   (so a mis-declared read can't branch on dry-run — doc 01 §2.3). **Fixtures come from `example`**
   (D3): the mandatory canonical output is the single reusable fixture — stubs, unit tests, and the
   dashboard preview all consume it, so it can't drift.
3. **Architecture ratchets** — §2's ported grep-ratchets + §3–§5's new guards, each glob covering
   `temp_src/**` with a zero-allowlist for new code and shrink-only for ported leaves.
4. **E2e stub lane + live lane** — §7.

Write order for a new task (red→green): write the contract (`example` fails to parse → red) → write
the impl `run` typed against the contract → pure-logic unit test with `fakeCtx` (red → green) →
register in the store index (reachability guard green) → add the node to a descriptor
(descriptor-coverage green) → if it commits, add typed proof+probe (write-safety green) and its prepare
pair (pairing green).

---

## 7. Stub + live lanes on the new kernel

**Stub lane (`HRAUTO_E2E_STUBS=1`).** Today `maybeWrapE2EStub` clones a `RegisteredWorkflow`, sets
`systems: []`, and walks the real step list with a hand-written `StepDataFn` per workflow
(`stub-workflows.ts`), honoring file-based **hold gates** (park a run mid-step) and one-shot **fail
gates** (`E2EScriptedFailError` → terminal `failed` + Retry). Migration:

- **Minimal happy path becomes derived** (D3): the executor runs each descriptor's `nodes`, and each task's
  stub output is its contract's `example` (schema-parsed) instead of a hand-written `StepDataFn`. The
  hand-maintained per-workflow scripts disappear — the stub map is a descriptor projection
  (descriptor-coverage #(stub) covers it), so it can't drift from the real steps.
- **What `example` cannot express lives in the registered scenario corpus** (doc 12): failure,
  cancel, subject mismatch, proof unknown, gate, delegation, retry, and parallel overlap are strict
  `ScenarioManifest`s with deterministic fixture drivers and timed control events. The existing
  file-based hold/fail-gate mechanism (`e2e-gates/`) remains an implementation primitive, not an
  unindexed parallel list. Doc 05 §7 #1's lane-overlap scenario holds two workflows simultaneously
  and asserts span overlap (`maxConcurrentLanes ≥ 2`).
- **Span-emitting workflows**: the stub daemon emits the same span/note events (doc 03) a real run
  would, so the dashboard parity gate (D13) and lift-free new-server projections are exercised
  without a browser. `oath-upload`-style real-handler-with-stubbed-legs cases port as test seams.

**Live lane (`tests/live/`, opt-in, never CI).** Ports as-is: real Chromium, real UCSD SSO, Duo
cleared hands-off by the enrolled WebAuthn credential (charter §9 — no phone step). Its safety
boundary is unchanged and is now *structural*: **`dryRun=true` = the submit task is not in the
   composition** (§3.1), so a live dry-run reads the real path and proves no commit span, fence,
   intent, or mutation call exists, with no possibility of an irreversible write — the write-safety contract (doc 09) only
ever engages on a real submit, which a dry-run composition doesn't contain. The dashboard headless
`playwright-cli` verification loop (root CLAUDE.md "Verifying dashboard changes") is unchanged: seed
a synthetic tracker dir → boot the real new-server dashboard → drive + assert on the a11y snapshot.

---

## 8. Adversarial self-review — how the guard set rots, and the meta-guard for each

| # | Rot vector | Meta-guard |
|---|---|---|
| 1 | **Allowlists grow unchecked** — every failure "fixed" by an allowlist add | Each entry needs a one-line `reason` (ported discipline); the fail-both-ways ratchet fails on a *stale over-count* too, so a shrunk violation forces the entry down; periodic review is a lesson, not a guard — honest residual risk, mitigated by zero-allowlist for *new* `temp_src` code. |
| 2 | **A guard is deleted or dropped from the glob** | inventory catches accidental deletion/orphaning; coordinated removal requires a checked decision record and review—honest non-mechanical boundary (§5) |
| 3 | **A ratchet quietly narrows back to `src/` only** during dual-maintenance | Manifest check #5: the extend-set must keep a `temp_src` glob token. |
| 4 | **`temp_src` escapes coverage or a missing tree passes vacuously** | Each target family activates atomically with its first file; every active arm asserts a non-empty file set. Missing paths/unmatched ESLint patterns fail rather than skip, and CLI+config coverage are both pinned. |
| 5 | **A new parity/hand-list registry reappears** | explicit projection inventory/coverage is primary; ≥3-id heuristic is secondary only |
| 6 | **The composition/pairing guard false-positives on prose** | both key off closed unions and graph nodes; one-click writes use a no-op prepare, not an escape hatch |
| 7 | **This doc becomes a stale prose index** | §5's manifest is the machine SSOT; the two-way file↔inventory check exposes drift even if this prose lags. |
| 8 | **Meta-risk: three new safety docs (09/10/11) drift** | Each is a D1-owned contract doc the master plan (07) *references*, never redefines; this doc imports their contracts and only hosts their guards. |
| 9 | **The write-safety guard regresses to demanding a flat `receipt`** (would wrongly reject Kuali/OnBase) | §3.3 walks doc 09's `completion` UNION (`receipt\|save-verify\|upload-verify`, D22): save-verify/upload-verify pass with a typed `ProbeVerdict` read-back and NO confirmation number; a type-level test pins that demanding `receipt` of a save-verify contract is itself a guard bug. The `unverifiableByPage` allowlist (§3.5) and the mutation-primitive fence-routing ratchet (§3.6) each fail-both-ways, so the verify escape hatch and the fence bypass can't quietly re-open. |
| 10 | **A broad path exemption leaks into a nested rebuild directory** | `code-conventions` matches normalized repo-relative roots/segments, never `includes(prefix)`; a fixture proves `temp_src/x/scripts/y.ts` is not exempt merely because `/scripts/` appears inside it. |
| 11 | **A schema guard checks only top-level objects while nested records stay open** | schema walker recursively inspects object/union/lazy members and mutation-tests unknown keys at every nested object boundary |
| 12 | **A scenario exists on disk but no lane ever executes it** | scenario runner emits coverage by scenario id + required assertion ids; manifest guard fails orphaned, referenced-but-unexecuted, or stale-contract-fingerprint scenarios |
| 13 | **A recovery test “restores” only rebuildable projections** | restore drill asserts exact hashes/counts for non-rebuildable authority families and deliberately wipes projection tables before replay; swapping the roles makes the fixture fail |

---

## 9. Worked example — adding one new submit-bearing workflow

Scenario: a new `badge-reissue` workflow that fills and submits a UCPath form. Red→green, and what
must be registered:

1. **Contracts.** Write `ucpath/fill-badge-reissue` (`effect:"prepare"`) and `ucpath/submit-badge-reissue`
   (`effect:"commit"`). RED: `write-safety-contract` fails — the commit contract has no proof/
   `idempotency.probe`. Add `receipt` (the `T…` transaction number, ported from
   `readLatestTransactionNumber`) + `probe: "ucpath/find-existing-badge-reissue"`. RED: the
   add compatible EID subject declarations and scenario ids. The `example` guard fails until each
   contract's example parses; subject/scenario coverage remains red until the observation and
   mismatch/proof/crash fixtures exist. GREEN.
2. **Impls + unit.** Write both `run`s in `stores/ucpath/tasks/`; they use only the typed UCPath
   driver and the submit fires through `stores/common/mutation.ts`. Pure-logic unit tests with
   `fakeCtx` for the fill's field-mapping and
   the submit's receipt-parse (red→green). Reachability guard: both must be in the store index.
3. **Descriptor.** Add a `badge-reissue` transaction node pairing fill+submit under one lease, plus version, complete presentation/runtime fields, `code`, `icon`,
   `inputSubject`, strict terminal result, enqueue/action policy, scenarios, run surfaces. RED:
   `descriptor-coverage` fails until id/code unique, icon ∈
   ICON_NAMES, systems union resolves. GREEN.
4. **Safety guards fire.** `transaction-pairing`: GREEN (one lease, no boundary). `dry-run-
   composition-submit-free`: the dry-run plan contains the prepare preview and no commit capability.
   `commit-routes-through-mutation`: GREEN because the submit fires
   through `stores/common/mutation.ts`; raw Page/selector access would fail the driver boundary.
   `subject-before-fence` proves staged EID match and mismatch/no-read stop before fencing.
   `write-safety-contract`:
   GREEN — the `receipt` completion arm is satisfied (a UCPath `T…` receipt); a Kuali form here would
   instead pass via the `save-verify` arm with no confirmation number (§3.3). `no-positional-identity`:
   GREEN as long as members key on EID, not index.
5. **Register.** Add `badgeReissueModule` once to the composition root's `WORKFLOW_MODULES` tuple;
   `SERVER_REGISTRY` and `DESCRIPTORS` derive from it and coverage proves key parity. Stub happy path is
   derived from the `example`s automatically; registered fail/cancel/subject/proof scenarios come
   from the descriptor/contract scenario ids. No `INSTANCE_LABELS`/`SUBJECT_TO_KIND`/icon-map edits—those lists no
   longer exist. **Guard-manifest**: unchanged (no new guard *file*), but if this workflow needed a
   bespoke guard, it must be added to the inventory or the manifest test fails.
6. **Live proof.** A live dry-run asserts prepare preview exists and no commit span/intent exists;
   the transactional Phase-2 proof also crash-injects after a controlled commit and validates recovery.

Net: the safety suite plus descriptor projection coverage replace synchronized hand-edits and parity
guards—one contract change, and the compiler plus ratchets force the rest.
