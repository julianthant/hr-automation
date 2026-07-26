# Reconciliation memo — binding cross-doc decisions (2026-07-17 through 2026-07-26)

Status: **binding revision 2026-07-26 (Round 8).** Earlier rounds remain as decision history;
Round 7 supersedes incompatible typing, UI-access, control, delegation, recovery, trust,
knowledge, and workflow-editor claims, and Round 8 supersedes the migration/coexistence model.

> **What this doc is, as of Round 8: a decision CHANGELOG, not a specification.** Its job is to
> record *what was decided, when, and which doc owns it* — so a reader can reconstruct why a
> contract has its current shape. It is **not** where you read the current contract. The owning
> doc (D1 matrix below) is the only readable current truth, and every ratified decision must be
> folded into that doc **in the same commit that records it** (charter standing rule, added
> 2026-07-26). Round 8 entries are therefore deliberately one-liners with a pointer: the normative
> text lives in the owner. Rounds 1–7 predate that rule and still carry normative prose; treat
> the owning doc as authoritative wherever they differ.

Three adversarial reviews (`reviews/01-review.md`, `reviews/02-review.md`, `reviews/03-review.md`)
found that docs 01–03 describe divergent systems at their seams. This memo is the orchestrator's
binding resolution. **Every decision below overrides anything contradicting it in docs 01–03.**
Amendment agents rewrite each doc to comply; a doc may reference another doc's owned contract but
must never redefine it.

> **Implementation rule:** don't implement from this file. D1–D25 are historical rationale, not
> copyable current API/DDL; D26–D72 amend each other in round order (later wins); D73–D86 are
> pointers only. **Read the owning doc.** If an owning doc contradicts a decision here, the doc is
> either correct (it was folded) or stale (it wasn't) — check the doc's amendment date against the
> round date and fix the doc, never work from this memo. Current contract shapes live in owning
> docs 01–03 and 05–06/09–12.

## D1 — Contract ownership matrix (one owner per concept, others reference)

| Concept | Owner |
|---|---|
| Task contract (`defineTask`), id grammar, error taxonomy, effect/dry-run mechanics, retry policy, decoration, stores, session providers, shared leaf-code homes | **Doc 01** |
| Workflow builder API (single API), descriptor shape, RunEnvelope, run-state machine incl. gates/parks, checkpoint/resume model | **Doc 02** |
| Span/event wire schema, notes stream, storage layout, lift adapter, SSE wire shapes, completion (fan-out/approval) union | **Doc 03** |
| Executor lanes, resource budgets, page/driver leases, fairness/backpressure, page isolation | **Doc 05** |
| Canonical-field intake mapping, normalization outcomes, admission manifests, durable capture, roster/local projections, Edit Data | **Doc 06** |
| Write intents, proof/completion union, subject proof, recovery sequence, immutable ledger | **Doc 09** |
| Guard/test inventory, scenario execution lanes, non-vacuity/meta-guard | **Doc 10** |
| Clock, config/instance snapshots, fiscal dates, secrets, environment preflight, local network boundary | **Doc 11** |
| Semantic UI vocabulary/drivers, run evidence/diagnostics, scenario corpus, structured knowledge/fix records, workflow explorer/editor, base capability inventory | **Doc 12** |

Each doc gets a header table stating what it owns and what it imports from siblings.

## D2 — Task identity
`<system>/<verb-object>` slash grammar (doc 01's). One closed `SystemId` union covering browser
systems (named after the REAL `src/systems/` dirs — `new-kronos`, `old-kronos`, not `kronos`) plus
service systems (D4). Doc 02/03 examples updated (`ucpath.searchPerson` etc. are wrong).

## D3 — Client-safe contract split (resolves the bundle-fault-line collapse)
A task is split into:
- **contract** — plain data: id, zod input/output, title, effect, errorCodes, freshness (D8),
  mandatory `example` output. Lives in `temp_src/domain/contracts/<system>/` (bundle-safe, satisfies
  the "descriptors import only zod + domain" guard).
- **impl** — `run` + session needs, lives in the store (`temp_src/stores/<system>/tasks/`), imports
  the typed system-driver API. Raw Playwright imports live only in that store's driver/session
  internals. `defineTask(contract, impl)` binds them; the store is the only impl registry.
Descriptors and the dashboard import contracts only. E2e stubs derive their happy path from
`example` (schema-parsed); failure/cancel/parallel scenarios come from the registered strict
`ScenarioManifest` corpus rather than per-test ad hoc stubs
(examples cannot express them — review 02 #12).

## D4 — System-less work gets service stores
Service stores (`extraction` for file parsing, `normalization` for typed contact/address cleanup,
`roster` for matching, and `ocr` for the provider pipeline) use the same contract; `sessions: []` is legal only for service stores and pure
`workflow:<id>` mini-stores; browser stores stay type-constrained to their own system's sessions.

## D5 — Waits and operator gates are run-state, not task internals
Tasks remain run-to-completion with bounded duration. Long waits (OCR approval, child-signature
watching, external signals) are **gate nodes** declared in the descriptor and owned by doc 02's
run-state machine; doc 03's `gate.opened/resolved` events are their wire form. Kernel policy: a
parked run RELEASES its browser sessions; resume reacquires via the store session provider
(re-login is idempotent). Duo is cleared automatically by Duo Autopilot on EVERY login — production
included (operator directive 2026-07-17, charter §9): there is no phone-approval poll, pause, or
manual-MFA path anywhere in the new design. Login is always unattended and bounded.

## D6 — dryRun lives on the RunEnvelope (kernel-owned), never in workflow input. Doc 02's table is amended.

## D7 — Write-ness is derived, never re-declared (amended by D26)
`TaskStep.write` is deleted. All write gating derives from the contract's closed effect:
`read | prepare | commit`; only `commit` is an external write and it is legal only inside a
transaction node paired with `prepare`. `defineTask` uses effect-specific overloads and the runtime
factory remains the always-on backstop. Dry-run composition removes commit arms rather than asking a
task to branch on a flag.

## D8 — Checkpoint freshness (closes the stale-read→live-write hole, review 02 #2; amended by D34)
Every read contract declares default + validated field-path freshness and provenance. Checkpoints
retain per-field source observations; derived values retain the oldest contributing observation.
At resume, the kernel walks declared DAG dependencies to every commit sink. An over-age contributing
fact refuses loudly—naming checkpoint, field, source age, limit, and consuming commit—and requires a
live rerun or a contract-permitted field-scoped audited override. `Infinity` is explicit policy
metadata with adjacent justification and is illegal for identity/key/proof facts.

## D9 — Resume-model scope (explicit)
Resume covers rows with a real daemon task only (`single`, real `operation-member`). Explicitly
excluded: display-only rows (operation coordinators, i9 display-only members — nothing to resume)
and the OCR per-page pipeline (one task externally; its page pool keeps internal checkpointing,
surfaced as notes). Doc 02 fixes its schema to reality: `tasks.id` is `TEXT`, the logical key is
`(workflow, item_id)`.

## D10 — One event schema (doc 03's union, amended)
Doc 03's discriminated-union event stream is THE wire contract; doc 02 §4 becomes a reference.
Amendments to 03's schema: span identity = `(runId, attempt, spanPath)` using doc 02's readable
path-style span ids; `worker` kind and first-class `discarded`/`interrupted` outcomes kept; in-run
kernel retries = attempt-suffixed task spans, cross-run retries = `retryOf` new run; the legacy
`-N` display suffix stays display-only formatting. **Action spans move to the notes stream** (task/
run/gate spans stay in `spans/`) — preserves per-action attribution via spanPath without exploding
the span stream; timeline folds read spans only. SSE member payloads send ids + deltas, never fully
resolved nested member trees.

## D11 — Completion union re-derived from as-built code
Doc 03 §4 is rewritten against `tracker/dashboard/ocr/approve.ts` + `prepare.ts` as-built, and must
express: intent-derived child shape (operationWorkflow), `deriveItemId`, the per-document target
consuming the per-record target's actually-enqueued itemIds (ordered stages, not flat independent
targets), oath-upload's owner-consumes via a sibling born-at-upload task (`subscribeToApproval`) with
NO coordinator, and i9's prepare-route member enqueue + task-less display-only failed rows. Stay
declarative (typed staged completion program on the descriptor); if a case truly cannot be declared,
the doc says so explicitly rather than mis-modeling it.

## D12 — Lift adapter re-derived from the kernel terminal contract
Mapping enumerated from `tracked-workflow.ts` (plain `done`, `failed`-with-step, `skipped`,
`interrupted`, `superseded`, pseudo-step `<step>:failed:<err>`, approve/ocr-prep failures), not the
OCR happy path. Lift reads the visible-entries layer (deletion tombstones respected). Quarantine
(loud card), NEVER throw — including post-cutover legacy rows and invalid archetypes. No fabricated
`run.claimed`/worker spans for task-less display rows. Gates outside OCR are enumerated per
workflow (EID/identity-approval, standalone-OCR approval with no parentRunId). Pinned by replaying
real `.tracker` days through the lift asserting zero quarantines.

## D13 — The dashboard flip is SCOPED, not wholesale (operator-reviewable)
Parity gate covers queue rows + log panel + session cards + wfCounts only. Workflow modifier,
settings, mobile capture, and AI-assist proxy to the old endpoints until their explicit D58
migration milestones.
One-week legacy-dashboard fallback stays. (Review 03 sized wholesale flip at ~103 endpoints / ~122
components — an unacceptable pre-Phase-2 mega-milestone.)

## D14 — SQLite role (expanded by D21/D45/D50/D51/D59)
SQLite remains system-of-record for claims, checkpoint payloads, dependencies/manifests, commands,
write/artifact outboxes, notifications, ledger heads, and capture handoffs (NOT rebuildable/deletable);
spans/notes JSONL is the display/audit source. Doc 03's "deletable projection" claim is scoped to
projection tables only.

## D15 — Doc 01 compile-level + porting fixes (all accepted from review 01)
Builder accumulates a `Steps` type map so `decorate` can type its hooks; step mappings return
`z.input<In>` while `run` receives `z.output<In>`; `const` type parameter for `errorCodes` + a
type-level test pinning that undeclared codes fail tsc; ONE login signature
(`Promise<"logged-in" | "already-authenticated">`) with the bool adapter named as a wrapper (not
"verbatim"); OnBase exclusivity = cross-process SQLite lease from day one; the UCPath store
selectors file RE-EXPORTS `src/systems/ucpath/selectors.ts` until deletion day (kills dual-
maintenance drift; same pattern offered to other high-churn stores); `onError` hooks: the base
TaskError ALWAYS propagates, hook failures attach as secondary metadata (pinned by test); dry-run
consultation asserted at the mutation primitives (submit helpers), with legitimate no-op
completions (duplicate-hire skip) given defined semantics; `stores/common/` added for shared leaf
code (`src/systems/common/`).

## D16 — Labels and overrides: exactly two layers
Step label = descriptor `step.label`, defaulting to the contract's `title`. The ONLY override layer
is the operator presentation override (serve-time, visible in settings). Precedence stated once, in
doc 02. The worked example task (`ucpath/search-person-org`) is defined once, in doc 01 §9; doc 02
imports it verbatim.

---

## Reconciliation round 2 (2026-07-18) — write-safety skeptic (`reviews/09-review.md`)

The adversarial review of docs 09/10/11 found two blockers in write-safety and several cross-doc
seams. These decisions are binding and override anything contradicting them in 09/10 (and amend the
earlier D8/D14).

- **D17 — Crash recovery is PROBE-THEN-PARK, not always-park (amends D8 + doc 02; negative arm
  further amended by D64).** On a crash
  during a real submit, recovery re-runs the idempotency probe FIRST: `present` → backfill +
  ledger + done (no second submit); `absent` → record a negative observation for D64 settlement;
  `ambiguous`/`unknown`/throw → PARK `needs-operator`. Rationale: always-park does NOT prevent a
  double-file, it only defers everything to manual; probe-then-park recognizes typed positive proof
  and may resolve only an evidence-qualified negative sequence, while fail-closed unknown or
  unsettled evidence still honors "be very sure." D8's "crash-mid-write still parks needs-operator" clause and doc 02 §5.5 / §5.6#2 / OQ2 /
  the line-364 statement are amended to this. In the final three-effect model, doc 02's
  **transaction node** gains a required `probePolicy` (`"always" | "retries-and-recovery-only"`,
  no default — the §b migration
  question); the recovery probe is always-on regardless.
- **D18 — Same-key concurrency fence (BLOCKER fix).** `idempotency_key` gets a **partial UNIQUE /
  mutex among un-committed `write_intents`**, and beat ① MUST consult `write_intents` for an
  in-flight `attempting` row on the same key BEFORE the live-page probe. Two runs deriving the same
  key (or one after a lost lease) can no longer both fence-and-click. This is load-bearing for the
  parallel kernel (doc 05) — without it, exactly-once is false under concurrency.
- **D19 — Recovery backfill is schema-validated (BLOCKER fix).** The recovery `present`-backfill
  MUST run `completion.schema.parse` on the probe-returned receipt; a parse failure → PARK. There
  is NO path to `done` with an unvalidated receipt, recovery included.
- **D20 — Honest scope (amends doc 09 §12).** The double-**file** class is closed by the fence +
  key-mutex. The duplicate-**person** (too-early racy read) class is NOT structurally closed — it
  is mitigated by porting the race-classifiers + live verification + the (conditional, create-path)
  pending-termination sweep, and disclosed as a residual, not claimed "structurally impossible."
- **D21 — Storage owner is doc 03 (D1).** Doc 03 §2.1/§2.3 must actually add: the `ledger/` dir
  (hash-chained append-only JSONL, per-system+day, never pruned) and the `write_intents` SQLite
  table (added to the system-of-record set, amending D14's "claims + checkpoint payloads"). Doc 03
  must also DECIDE the base spans/notes retention (today an open question) so 09's "never-pruned"
  floor sits above a settled number rather than a guessed "30 days."
- **D22 — Contract-shape + guards owner split (terminology amended by D26).** Doc 09 owns the
  **commit** contract's required `writeSafety` shape: `completion` is a UNION (`receipt |
  save-verify | upload-verify`) + `idempotency`. Doc 10's
  `write-safety-contract` guard must walk that union — it must NOT demand a flat `receipt` schema
  from Kuali/OnBase (which use save-verify/upload-verify per charter §13). Doc 10 adds ratchets:
  `unverifiableByPage` requires an allowlist+reason entry, and every `effect:"commit"` impl must
  route its external action through a typed system driver operation that requires doc 12's
  `MutationCapability`; raw task-level `page.click` is impossible. The driver operation may cross
  the fence only through the kernel mutation primitive. Port fix: the "outcome unknown, refusing success" throw is in
  `clickSaveAndSubmit` (`transaction.ts:855-859`), not `waitForTransactionOutcome`.
  Doc 01 amendment (so the attachment isn't orphaned inside doc 09): doc 01 §2.2's
  `CommitTaskContract` carries the **required field** `writeSafety: WriteSafety<In, Out, Proof>`;
  doc 09 owns that shape and doc 10 guards it. There is no optional reference stub and no
  two-effect `MutateTaskContract` in the final model.

---

## Reconciliation round 3 (2026-07-18) — historical, superseded Step-0 spike

Before building the base, a throwaway type-inference PROTOTYPE (master plan §Phase 1, item 1d's
mandated first sub-task) compiled the CONTRACT / IMPL / BUILDER generics under the REAL toolchain
(TS 5.9.3 + zod 4.4.3, `strict` + `verbatimModuleSyntax` + `moduleResolution: bundler`). **Verdict:
the "coupled by contract" typing HOLDS** — all 7 load-bearing properties proven, **zero errors**,
and the green is non-vacuous by construction (each of the four `@ts-expect-error` controls suppresses
a real error — TS errors on an unused one — and every positive check uses an `any`-proof exact-`Equal`
helper). Three minimal shape refinements were required to reach the clean green; they are **binding**
and amend docs 01/02. None is a design compromise — D25 is a *correction* of an ambiguity doc 02 left
open, caught exactly as the spike was meant to.

- **D23 — `defineTaskContract` is TWO per-effect overloads (amends doc 01 §2.2).** It returns the
  EFFECT-SPECIFIC sealed contract (`SealedReadContract` / `SealedMutateContract`), never one signature
  over `ReadTaskContract | MutateTaskContract`. A union return distributes and defeats `defineTask`'s
  per-effect overload routing; the effect-specific return keeps a defined contract's static type
  effect-specific (and reinforces the fill/submit split — a read and a write are distinct types from
  birth). `const Codes` is retained on both overloads. The sealing brand is a pure intersection, so
  all four generics survive it.
- **D24 — `StepEntry` carries the conditional flag as a literal type param (amends doc 02 §3).**
  `StepEntry<C, Cond extends boolean = boolean>` — the default keeps the bare `StepEntry<C>` form
  valid everywhere it is written; the accumulator stores the LITERAL `true`/`false`. The original
  `conditional: boolean` field collapsed the flag, so `OutputsOf` could never add `| undefined` and
  the conditional-skip typing (a `when`-step's output being `T | undefined`) would be dead.
- **D25 — `.step` is a SINGLE signature with a derived `HasWhen<O>`; the two-overload form is
  REJECTED (amends doc 02 §3).** The spike proved the overload route is actively harmful: during
  overload probing TS drops contextual typing on the `bind` arrow, its return literal widens
  (discriminants collapse to `string`), the call mis-resolves to the first overload, and every
  downstream step's `outputs` is silently poisoned with spurious `| undefined`. The single signature
  `step<Id, C, O extends StepOpts<WIn,S,C>>(…): …StepEntry<C, HasWhen<O>>` keeps contextual typing
  intact. **Doc 02 must forbid reintroducing `.step` overloads.**
  - **Disclosed residual (1d must verify).** Making `probePolicy` a COMPILE error when omitted on a
    mutate step (doc 02's earlier claim) needs `StepOpts` conditional on `C`'s effect; that specific
    inference was NOT part of the Step-0 spike. 1d verifies it compiles, else enforcement falls back to
    the factory + `descriptor-coverage` guard (runtime-enforced always — fail-loud holds either way).

**Scope not covered (honest).** The spike is pure types: it did NOT exercise `.build()` runtime
wiring or runtime zod validation of `bind` returns — those get a runtime spike when 1d/1e are built.
At that time `.rebuild-spike/` was retained locally for later promotion. It was deleted in the
2026-07-21 reset because its two-effect linear surface no longer proves the Round-4 graph. Item 1e
now requires a new real-scale three-effect DAG proof rather than promoting this battery.

---

## Reconciliation round 4 (2026-07-21) — external rebuild-plan review

The prior `temp_src` skeleton and `.rebuild-spike/` were deleted. These decisions are binding and
override/amend D2–D3/D5–D8/D12–D15/D17–D25 wherever they conflict.

- **D26 — Three task effects; transaction-scoped fill/commit.** `read` observes external state;
  `prepare` mutates only an ephemeral browser page; `commit` is the sole external-write class.
  Prepare and commit are separate task contracts/spans but one workflow `transaction` node and one
  uninterrupted page/context lease. No checkpoint, park, retry, reset, or `startAt` exists between
  them. Dry-run executes prepare and has no executable commit arm or mutation capability.
- **D27 — The workflow is a typed DAG, not a linear step list.** Foundation vocabulary includes
  read, transaction, output-dependent branch, parallel fork/join, typed child-run, and typed gate
  nodes. Conditions may read declared prior outputs. Verify/onboarding/oath-upload must be expressible
  without handler-side delegation or branching. Dependencies are declared and runtime-audited;
  proxy-walking bind functions is prohibited for freshness decisions.
- **D28 — Descriptor exhaustiveness is concrete.** Doc 02's descriptor includes version/fingerprint,
  full graph, details, actions/runtime policy, presets, match/item identity, presentation, gates with
  subscriptions/resolvers, coordinator/completion-consumption, capabilities, and completion program.
  Completion/child targets retain concrete input schemas; `WorkflowRef<unknown>` and unknown derives
  are forbidden. The explicit projection coverage matrix—not the ≥3-id heuristic—is the proof.
- **D29 — Layer ownership is acyclic.** Domain defines dependency-free contracts only. Stores and
  workflow descriptors depend on domain. `core/workflow-registry.ts` is the composition root that
  imports workflows/stores. Domain never imports workflows. Dashboard consumes a validated generated/
  server projection, never workflow modules. No forward contract stub may precede its owning phase.
- **D30 — Permanent-key write intent.** `(system,idempotency_key)` is the permanent primary key across
  attempting, retryable, committed, and externally-observed-present states. Durable lookup is never
  skipped and satisfied rows are never exempt. A later pristine run reuses validated proof + typed
  output rather than fencing again. A live probe that discovers a pre-existing external transaction
  permanently blocks a click but emits no write ledger entry—the automation did not file it. The
  live prewrite probe policy may only affect a truly unseen/retryable key.
- **D31 — Every completion arm has typed proof.** Receipt, save-verify, and upload-verify each carry
  the same nontrivial `proofSchema` used for normal output and recovery-probe backfill. No optional or
  genuinely-idempotent escape hatch exists for commit contracts. `outputFromProof` also reconstructs
  and parses the full transaction-node output so recovery/preflight-present can satisfy downstream
  typed dependencies without fabricating missing fields.
- **D32 — Atomic commit outbox.** Intent commit, typed transaction-output checkpoint + proof, ledger outbox, terminal-span
  outbox, and run state commit in one SQLite transaction. Recovery reconciles all committed-intent /
  missing-outbox / unprojected permutations. Executors never append the write ledger directly.
- **D33 — Serialized, anchored ledger.** One SQLite-coordinated projector assigns per-file sequence
  and hash, preventing concurrent chain forks. SQLite ledger-head anchors make record-boundary tail
  truncation and missing files detectable. Local DB+file coordinated tampering remains out of scope.
- **D34 — Field provenance, not checkpoint freshness laundering.** Checkpoints retain per-field
  live observed times and operator correction provenance. Editing one field never refreshes untouched
  facts and never asserts current external truth. Read contracts classify output fields as live or
  derived; derived fields carry their input source set and oldest observation, so a transform cannot
  refresh stale facts. A stale corrected fact needs a live rerun or an
  explicit field-scoped, single-resume audit override. Editability is descriptor-allowlisted and
  excludes stable identity, original input, idempotency, write proof, and provenance fields.
- **D35 — Semantic resume compatibility.** Runs/checkpoints stamp descriptor version plus contract
  and implementation fingerprints. Equal output schema alone is insufficient. Resume across a
  fingerprint change requires a checked-in typed checkpoint migration or refuses loudly.
  Raw submitted input and the once-parsed canonical input snapshot are stored separately with the
  input-schema hash; resume uses the parsed snapshot and never re-applies changed defaults/transforms.
  Fingerprints come from deterministic content-hash manifests over canonical relative dependency
  closures + generated schemas/toolchain, never `Function.toString`, mtimes, or absolute paths.
- **D36 — Safe session exclusivity.** UCPath transaction acquisition drains/blocks all sibling reads
  on that PeopleSoft context; read/read sharing remains allowed. OnBase's cross-process identity
  lease covers the authenticated context lifetime and releases only after context close.
- **D37 — Per-run migration authority.** Enqueue stamps engine and cutover generation. New native
  runs can start while an enumerated legacy drain set finishes; late authorized legacy terminals are
  not quarantined. Rollback is another generation. The legacy SPA fallback reads a compatibility API
  projected from unified native/lifted state, so native runs remain visible. Legacy row/log/session
  schemas are versioned rather than frozen; a source-schema change requires version bump, lift adapter,
  and golden fixtures in the same commit, while unstamped historical data is explicit `v0`.
- **D38 — Intake reaches novel and duplicate headers.** Generic header-row candidates do not require
  known aliases. Operator selection resolves uncertainty. Mappings bind normalized header+occurrence
  column ids; duplicate reuse requires confirmation; fingerprint input is canonical structured JSON,
  not a space-joined string.
- **D39 — Guard claims are bounded honestly.** Guard inventory prevents accidental shrink. It cannot
  stop coordinated deletion of guard+inventory; removals require an explicit decision/replacement and
  code review. Before the tree exists, guard plumbing does not claim to scan it; each target family
  activates atomically with its first file and proves a non-empty scan. ESLint CLI and typed config
  coverage land together, unmatched-pattern suppression is banned, the nullish ratchet covers the
  whole non-dashboard tree, and path exemptions use exact normalized roots rather than substring
  matches. The suite also adds transaction pairing, commit capability, sequential dedupe,
  atomic-outbox, projector-concurrency, tail-anchor, provenance, and real-scale graph type fixtures.
- **D40 — Config contracts are executable.** `resolveConfig():Config` returns plain values;
  `resolveConfigWithProvenance()` returns config+source map+fingerprint. Nested schema parents have
  valid defaults and no `.url().default("")`. Production and sparse test endpoints are separate;
  settings/env test overrides cannot silently replace production. Enqueue stamps a complete resolved
  instance/config snapshot; browser pools partition by it and tasks never re-resolve mutable config.
- **D41 — The old spike is not ratification.** D23–D25 are historical observations about a smaller
  two-effect, three-step prototype. The new Phase-1 proof must cover three effects, transaction
  pairing, output branches, fork/join, typed child runs, typed gates/completion, and realistic graph
  scale before the production workflow builder/descriptor implementation is built.
- **D42 — Workflow mini-stores are headless-only.** D2's closed `SystemId` still owns all browser and
  service stores. Pure workflow-specific read/transform tasks may use
  `workflow:<descriptor-id>/<verb-object>`; composition-root coverage binds that namespace to a real
  descriptor. The headless store type requires `sessions:[]` and exposes no page or mutation
  capability. Every prepare/commit and every browser task remains under its owning system prefix.
- **D43 — Probe before staged-page mutation; fence immediately before commit.** A transaction binds
  and parses commit input only from workflow input plus declared upstream outputs, never prepare
  output. Durable history and any policy-required live probe run first on a separate read lease.
  The exclusive transaction lease then runs prepare; a required migration-justified
  `probeToFenceMaxMs` is checked before the permanent-key CAS fence, followed immediately by commit
  and proof on the retained page. Probe navigation therefore cannot erase staged state; an expired
  probe or lost CAS discards the page without clicking.
- **D44 — Parked writes have typed, generation-locked resolutions.** Generic Done/Retry actions do
  not apply to an unfinished write intent. Confirmed-present proof parses through the same completion
  schema and performs the same atomic intent/checkpoint/outbox/run commit. Confirmed-absent records
  operator/time/evidence and makes the same permanent intent retryable for a later CAS generation.
  `unverifiableByPage` requires a typed operator-attestation proof arm. No action deletes, voids, or
  reopens committed history.
- **D45 — Local artifacts are not hidden read mutations.** Read tasks may create only immutable
  content-addressed artifacts through a declared atomic writer. Mutable files such as i9's retention
  workbook are stable-keyed SQLite outbox projections with serialized, head-hash-checked projectors;
  a blocking sink must acknowledge before the run reports done. This retains the three task effects
  without making task retry duplicate an append.

---

## Reconciliation round 5 (2026-07-22) — whole-plan + legacy-code improvement review

These decisions answer the operator's maintainability/trust/debugging/workflow-authoring brief and
the failure modes found by rereading the old codebase. They are binding and supersede any earlier
statement that leaves these seams implicit.

- **D46 — Runtime schemas are the type authority.** Every external/durable boundary (workflow/task
  input and result, run/checkpoint, command, event/note, SSE, config, intake, artifact, evidence,
  notification, knowledge/fix) has a strict, versioned zod schema; TypeScript types are inferred
  from it. Unknown keys fail. Canonical ids/dates/instants/digests/amounts are branded. Missing,
  optional, nullable, unknown, not-applicable, and redacted are distinct—no empty-string/null/default
  collapse. Open `Record<string,unknown|JsonValue>` cannot carry decision state.
- **D47 — Semantic UI registry + typed drivers are the reusable browser-task store.** Canonical
  `ElementId`, `PageStateId`, `ScreenId`, and `ObservationId` entries own selector strategy,
  meaning, valid page states, verification date, aliases, and scenarios. Tasks receive a typed
  `SystemDriver`, never Page/Locator/selectors. Raw Playwright access is confined to driver/session
  internals. External-commit UI operations additionally require the fenced mutation capability.
  Generated `UI-CATALOG.md` is a safe projection without locator recipes and gives the operator and coding agents one vocabulary; aliases
  are explicit migrations, not duplicate names. The task store reuses business operations; the UI
  registry reuses proven element knowledge; checkpoints/mini-stores reuse typed computed facts.
- **D48 — Fresh subject binding is mandatory before every real write fence.** Prepare and commit
  contracts declare compatible expected subject + semantic observation + matcher. After prepare on
  the exact lease, the kernel re-observes the staged person/file/catalog, records a strict redacted
  `SubjectProof`, and fences only on a fresh match. Mismatch/unknown/missing/stale proof yields zero
  fence/click. The mutation capability is bound to intent generation + subject-proof digest. This
  closes stale-open-record writes; it does not claim upstream business selection is correct.
- **D49 — One command protocol owns enqueue and queue-row operations.** Dashboard, CLI, gates,
  recovery, and editor issue durable idempotent CAS commands. Descriptors choose closed enqueue and
  action policies. Cancel resolves authoritative SQLite dependency targets and fails closed—never
  caller-visible root fallback. Active-run lookup failure cannot degrade to enqueue. Retry preserves
  immutable input/config and creates linked run history; bump changes scheduling only. The UI says
  Hide/Unhide for reversible presentation tombstones. Physical purge is an offline exact-id command
  requiring a verified backup and a purge receipt; workflows own no row mutation handlers.
- **D50 — Delegation is a typed atomic graph contract.** `WorkflowRef` carries strict input and
  successful result schemas. Every child edge declares stable edge/item identity, cardinality,
  await/join, failure, cancellation, child-retry/parent-resume, and visibility policies. Parent,
  children, dependencies, and immutable fan-out manifest commit atomically. Replay reuses the
  manifest; separate edges never join via a broad “all children under parentRunId” query. The
  kernel implements control semantics; workflows only choose policies and bind typed inputs/results.
- **D51 — Non-rebuildable SQLite authority has a recovery contract.** WAL/foreign-key/full-sync
  authority transactions, boot quick-check + invariant queries, checksummed online backups,
  retention, read-only degraded mode, `storage doctor`, exact-backup atomic restore, and an automated
  restore drill are Phase-1 requirements. JSONL rebuilds projection tables only and may never invent
  lost claims/dependencies/checkpoints/write intents/outboxes/commands. Post-backup uncertain writes
  park behind recovery probes.
- **D52 — Trust is a first-class output.** Structured `FailureRecord`s, redacted automatic diagnostic
  bundles, terminal `RunEvidenceReceipt`s, and `cli explain run` link input/config/graph/schema
  fingerprints, node outcomes, provenance, UI actions/page states, screenshots/artifacts, subject
  proofs, exclusions, write proofs, and confidence. `done` requires mandatory evidence and no
  unresolved write/subject/storage condition. Notifications are durable deduped inbox records;
  desktop delivery is best-effort and cannot be the only alert.
- **D53 — Behavioral scenarios are maintained product data.** Task/workflow/UI contracts reference
  checked-in strict `ScenarioManifest`s covering happy, no-match/empty, schema failure, transient/
  permanent failure, branch/gate/delegation/control, subject mismatch, proof/crash, and discovered
  real-world variants as applicable. Examples seed only the minimal happy path. Every production
  bug fix links a regression scenario; orphaned, stale, or referenced-but-unexecuted scenarios fail
  guards. This is how workflows improve as new cases appear without silent catch-all fallbacks.
- **D54 — Chronological lessons are not active architecture authority.** Port only verified current
  rules into scoped, statused, evidence-linked `KnowledgeRecord`s with validity/supersession. Every
  Codex/Claude-assisted fix creates a `FixRecord` linking failure, changed contract/UI ids, scenario,
  verification, and commit. Existing LESSONS/CLAUDE lessons are triaged into active/superseded/
  historical—not bulk-copied—and duplicate active rules are rejected.
- **D55 — Workflow tooling is staged hybrid, not graph-as-code fantasy.** Phase 1 ships a read-only
  Workflow Explorer generated from descriptors/tasks/UI ids/scenarios/evidence, with exact source
  links and run replay/explanation. Phase 2 may add constrained edits for presentation, safe closed
  policies, and typed task-node composition. Source-authored workflows receive patch scaffolds only;
  a workflow converted to DSL-authoring has exactly one versioned strict definition and deterministic
  generated descriptor. Every applicable edit compiles/validates/diffs/version-bumps before restart-
  gated atomic apply/rollback. Arbitrary TypeScript, selectors, driver code, proof rules, and schema
  semantics stay code-reviewed. Generated design-intent briefs remain projections, never hand-edited authority.
- **D56 — Local-only scope is deliberate (amended only by D59).** Native operator dashboard binds loopback only; Phase 1 omits
  accounts/RBAC/teams/remote sync/HA/certificates/external audit signing. Non-loopback bind fails.
  Correctness, redaction, least-retained evidence, safe file permissions, backups, and loopback Origin
  checks remain because the tool controls live HR systems and diagnostic artifacts may be shared.
- **D57 — Intake reruns are manifest-backed.** Mapping/validation produces an immutable
  `IntakePlanManifest` containing source artifact digest, mapping and workflow fingerprints, every
  valid row→stable item/input hash, every correction, rejection, and explicit exclusion. Coordinator,
  members, dependencies, and manifest enqueue atomically. Rerun-with-existing-data references that
  manifest and shows hash/schema diffs; it never silently reparses a changed file or newer mapping.
- **D58 — Old-code closure is capability-inventoried, not workflow-counted.** Migrating all 16
  workflow directories does not prove `src` is deletable. Phase 0 records every legacy service,
  route family, dashboard surface, CLI/ops script, exporter, code generator, and maintenance tool
  with exactly one disposition: native milestone, temporary proxy with removal milestone,
  deliberate replacement, or evidence-backed retirement. A machine-readable inventory guard fails
  on unclassified additions and before deletion on any proxy/undecided entry. This closes the old
  plan's omission of capture, AI-assist, timecard, setup/export/maintenance, and long-tail routes.
- **D59 — Mobile capture is durable intake with one explicit network exception.** The operator
  dashboard/API remains loopback-only. Only while the operator opens a capture session may a
  separately scoped phone ingress/tunnel expose the token-gated capture asset/manifest/status/
  upload/replace/delete/reorder/finalize endpoints—never queue, settings, evidence, files, or commands. Capture sessions,
  photo order/digests, expiry, finalization command, and handoff state are strict SQLite authority;
  restart resumes them. A stable outbox converges bundle publication and one atomic authority
  transaction that records the artifact plus intake/OCR handoff, or records a retryable loud
  failure; it never returns final success then silently loses `onFinalize` work.
- **D60 — AI help is advisory and schema-bounded.** Shared provider/rate-limit infrastructure may
  serve OCR, contact normalization, and optional operator-requested triage/sanity/selector/run
  summaries. Every result is strict-schema, source/provenance-labelled, redacted before third-party
  submission, and explicitly `advisory-produced|unavailable|invalid-response`; it cannot change authority, resolve a gate,
  mark success, choose identity, invent a selector, or authorize a write. Deterministic receipts,
  scenarios, UI catalog, and validators remain authoritative when the pool is absent/exhausted.
- **D61 — Shared timecard logic is split at the right boundary.** Calendar/range/year resolution
  becomes Clock-injected pure domain code. Current/previous-period orchestration uses a semantic
  timecard-driver interface in `stores/common/`, while Old/New Kronos own their page-state/UI
  implementations. Raw `Page`, optional `new Date()` defaults, fixed sleeps, and `null`-as-navigation-
  failure do not port. The date-window and positive period-switch scenarios are shared once.
- **D62 — Parsed input is immutable but still validated on every authority read.** Enqueue applies
  ingress defaults/transforms exactly once, then stores canonical `z.output` plus its hash. Every
  later DB/resume read parses those bytes through a separate strict canonical-input schema that
  performs validation only; it never reapplies ingress defaults/transforms and never trusts a cast.
  Descriptor construction must prove ingress-output → canonical-schema round-trip. Changed
  canonical semantics require an explicit input-snapshot migration or a loud refusal.
- **D63 — Non-browser provider I/O is capability-injected and budgeted.** OCR/model/geocoder and
  other remote service calls may not hide behind imports in a service task. Contracts declare a
  closed provider-capability set; `ServiceTaskCtx` exposes only those injected clients. Calls are
  abortable, timeout/rate/concurrency-budgeted, redacted, and action-evidenced, with strict
  produced/unavailable/invalid outcomes. Direct SDK/network imports outside the registered infra
  adapters fail a guard. Provider budgets participate in scheduler admission even though they use
  no browser page.
- **D64 — A post-fence `absent` is not retry authority by itself.** A recovery probe's negative arm
  carries typed evidence and is accepted only by the commit contract's system-specific recovery-
  absence policy: a bounded propagation window plus the required number/source of consistent
  observations, or `operator-only` when safe negative proof cannot be earned. A bare/single early
  absence becomes `unknown` and parks; it never marks an intent retryable. The enforceable claim is
  **at most one unattended commit attempt per intent generation, with automatic convergence only
  when positive or stabilized negative evidence is valid**—not unconditional distributed
  exactly-once against systems that expose no idempotent API/authoritative negative read.
- **D65 — Every commit fences on a binding proof, including explicitly unscoped writes.** The
  write-bound proof is a strict union: a matched person/artifact subject proof, or an allowlisted
  `unscoped` proof containing the reviewed reason, exact page state, run/attempt/lease/task, and
  observation time. `subject.kind:"none"` does not fabricate expected/observed identities and is
  legal for a commit only when no stronger business subject exists. The mutation capability and
  ledger bind to the resulting `bindingProofDigest`.
- **D66 — Column mappings bind target fields, not canonical concepts.** A saved mapping keys each
  binding by the intake projection's stable target-field id/path and records the canonical field id
  it uses. This permits two target fields with the same canonical concept (for example home and
  mailing city), survives source-column reordering, and makes projection changes fingerprint-
  visible. Keying only by `CanonicalFieldId` is retired.
- **D67 — The command protocol is a family, not a run-action-shaped partial union.** One idempotent
  command envelope has strict target-specific arms for run controls/Edit Data/write resolution,
  typed gate resolution, notification lifecycle, and capture-session mutations. Each arm owns a
  version/CAS token and schema-parsed payload; adding a UI mutation without an arm fails coverage.
  Gate result payloads live in SQLite/checkpoints under their declared result schema; span events
  carry only a validated resolution key plus payload hash/ref, never a free-form string as control
  state.
- **D68 — Runtime dependency coverage is exhaustive, not illustrative.** Phase 1 inventories every
  browser system endpoint map, current secret/credential/provider key, optional feature dependency,
  and legacy env/config name. The config and secret registries cover both directions: every declared
  browser system/provider has the required endpoint/credential/preflight entries, and every runtime
  read is registered or explicitly retired/proxied in D58. Examples in doc 11 are excerpts, never
  permission to omit ServiceNow, SharePoint, Old Kronos, capture tooling, or provider credentials.

## Reconciliation round 7 (2026-07-22) — executable feasibility and real gate baseline

The completed whole-plan reread was followed by repository gates plus disposable compile/runtime/
SQLite spikes under the actual Node 26 + TypeScript 5.9 + Zod 4 toolchain. These decisions bind the
implementation plan to what the tools proved and close the failures the experiments exposed.

- **D69 — Every negative observation counted toward post-write settlement is post-propagation.**
  `now >= fencedAt + minSinceFenceMs` is not enough if an observation in the candidate sequence was
  captured earlier. The recovery scheduler sets the first eligible probe's `not_before` to the end
  of the propagation window; the settlement validator independently rejects every observation with
  `observedAt < fencedAt + minSinceFenceMs`. Only the configured 2–3 post-window, sufficiently
  separated, same-key/same-authoritative-state observations count. Pre-window evidence remains in
  diagnostics but contributes zero votes. This was a real failing adversarial spike, not a prose
  preference.
- **D70 — New-tree gates are zero-debt even while legacy lint debt is explicit and shrink-only.**
  The 2026-07-22 baseline passed typecheck, unit/serial tests, 137 architecture tests, and dashboard
  build, but `npm run lint` had 2 errors + 1 warning and `npm run lint:tests` had 1,325 errors + 2
  warnings. Phase 1 may not pretend those commands were green or weaken rules to make them green.
  Before the first `temp_src` production leaf, the small source-lint baseline is repaired without
  suppressions. New code/tests use non-vacuous `lint:rebuild`/`lint:rebuild-tests` commands with
  zero warnings from their first file. Pre-existing test lint diagnostics enter a reviewed,
  machine-generated shrink-only manifest keyed by file/rule/message/start+end-column/source-line
  hash; a new or
  replaced diagnostic fails even if the total count is unchanged. The manifest must reach zero as
  legacy tests are retired or corrected and is deleted before final cutover.
- **D71 — Phase-0 spikes prove feasibility, not correctness, and must become Phase-1 tests.** The
  disposable experiment compiled a 40-node typed chain plus effect overloads/provider narrowing/
  child-result negatives in 0.68s (`tsc --extendedDiagnostics`, about 212 MB), and runtime-tested
  canonical-input transforms, strict commands, mapping collisions, proof unions, and recovery
  settlement. It also proved permanent SQLite keys, atomic intent+outbox commit, foreign keys, and
  `node:sqlite` online backup/read-only integrity. These results remove obvious toolchain blockers
  but are not shipped code and do not satisfy Phase 1. Each positive and `@ts-expect-error` negative
  becomes a committed test beside the real API before that API lands; the representative real DAG
  remains the acceptance test because a simplified chain cannot prove the final builder.
- **D72 — The authority DB owner preserves native online-backup capability without leaking raw DB
  handles.** The current compatibility wrapper erases the `DatabaseSync` required by
  `node:sqlite.backup`; the rebuild does not copy that limitation. One infra-owned
  `AuthorityDatabase` retains the private native handle and exposes narrow transaction/query/
  `backupToTemp` operations. Consumers never receive `DatabaseSync`. Backup is single-flight and
  async. A singleton `authority_meta` generation increments exactly once in every committed outer
  authority-mutating transaction and not for projection-only work, with table-class coverage tests.
  Verification opens the completed backup read-only and derives its schema version,
  page count, `authority_generation`, and integrity result from the backup itself—not from a racy
  pre/post read of the live DB—before hashing/fsync/rename and writing the manifest. File-copy and
  `VACUUM INTO` fallbacks are forbidden while WAL writers are active.

## Reconciliation round 8 (2026-07-23 → 2026-07-26) — operator ratifications, folded

Answers given by the operator in the 2026-07-23 and 2026-07-24 review sessions (recorded in
`reviews/second-look-2026-07-22.md` §6.5/§6.6) plus the 2026-07-26 migration-order answer. They
had sat in the review file while docs 00/07/09 still specified the world they replaced; this round
records them and the same commit folds each into its owner. **One line each — read the owner.**

| # | Decision | Owner (normative text) |
|---|---|---|
| **D73** | **PAUSE-UNTIL-DONE.** Automation is paused for the rebuild; HR work is manual; `src` is a frozen reference from Phase-1 day one. Go-live/test/delete are operator commands, not calendar machinery. Reverses the charter's "old system keeps working throughout". | charter §Non-negotiables; doc 07 §4 |
| **D74** | **Phase 1 is a SPINE with a live exit test.** Cut to 1a–1f + the span/projection and queue-surface slices; person-lookup runs live as the exit. Trust tails, data services/capture/intake, and the explorer move behind that first live proof. | doc 07 §3 |
| **D75** | **Local-FIRST with multi-user seams** (amends D56). Four seams are load-bearing and never trimmed: actor attribution everywhere, one auth seam, credential-set-keyed sessions, per-actor inbox. RBAC/user-management/networking stay out of scope. | charter §Non-negotiables; doc 12 §7 |
| **D76** | **Build speed is the tie-breaker.** Between two correct, equally safe designs the sooner one wins; never overrides write-safety/identity/fail-loud. | charter §Non-negotiables; doc 07 §3.7 |
| **D77** | **Identity-approval gate = ALWAYS-GATE.** Manual approval on every separation, both separation types, no auto-approve-on-match. Was undesigned and deferred to order 8; now designed in Phase 0. | doc 09 §14 (gate mechanism: doc 02 §4) |
| **D78** | **Kuali `save-verify` RESOLVED — buildable** (live probe 2026-07-23, docs 4444/4453; save is UI-silent so reload read-back is mandatory). **OnBase `upload-verify` gated on the next real upload** — no probe target exists today. | doc 09 §13 |
| **D79** | **Ceremony trims ratified:** DSL graph-authoring mode trimmed; notification lifecycle slimmed to read/unread+snooze (inbox actor-keyed); commands keep version+actor wire fields everywhere but enforce CAS only where races exist; capture crash-proofing slimmed; ledger hash-chain deferred until multi-user (ledger + actor attribution stay); lightweight task tier adopted. | docs 12 §5, 03 §2.4/§2.6, 06 §5.1, 01 §2 |
| **D80** | **Versioning + archive-on-version-bump + version registry.** Version+fingerprint per descriptor, stamped per run with app version; a bump archives all prior-version runs as self-contained data (zero compat code); an app update bumps every workflow; ledger never archived; relaunch = fresh run; a bump cannot archive a non-terminal run. | charter §25; doc 03 |
| **D81** | **One projection owns every count** — Workflow Panel badges, Status Bar, Queue Panel from one server-side projection; a second count path is a guard failure. | charter §26; doc 03; guard doc 10 |
| **D82** | **Receipt acceptance test:** the operator can complete their double-check without opening UCPath (confirmation number + post-submit screenshot + identity observed at commit). | charter §27; docs 09/12 |
| **D83** | **Operator-assigned run display names** — any run is renamable; the label rides the row and the receipt, trace id preserved underneath. | doc 03 |
| **D84** | **Migration order optimizes TOTAL time-to-resume-all**, not per-workflow priority (operator 2026-07-26: every workflow costs real manual time, none dominates). Order is chosen for reuse leverage; onboarding/separations staying last is an explicit accepted trade. | doc 07 §3.3 |
| **D85** | **Testing standard:** scenario corpus as the everyday lane + structural dry-run + a typed `TestTargetRegistry` (test employees/files/sacrificial docs with usage rules) + `cli test workflow <id> --dry-run` through the real kernel + **positive no-write proof from an empty per-run write-intent ledger** (replaces screenshot-absence heuristics). Keepers from the old e2e ritual: "a workaround is a finding", double-entry ground truth, issue ledger — as kernel behavior. | doc 10 §7 |
| **D86** | **Notifications/retention/knowledge/demos:** failed·gate·parked·repeating·storage → Ping, verified-done → Inbox, pings silent; retention notes 30d / spans 30d / ledger forever / artifacts+checkpoints until purge; knowledge audits operator-triggered with a dated audit record; demos = activity report + live dry-run lane (synthetic demo mode removed). | docs 03/12 |

**Two separate D-series exist — do not confuse them.** This memo's `D1–D86` are cross-doc
reconciliation decisions. Doc 03 §9 carries a **row-model series** (`row-model D1–D20`: three row
types, eight statuses, containment, delegation shapes) ratified 2026-07-24/25. Doc 03 states the
distinction at its §9 header; always cite the row-model series with the `row-model` prefix.
