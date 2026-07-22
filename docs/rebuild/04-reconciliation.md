# Reconciliation memo — binding cross-doc decisions (2026-07-17)

Status: **binding revision 2026-07-21.** Earlier rounds remain as decision history; Round 4 below
supersedes their incompatible task effects, graph, recovery, ledger, migration, and spike claims.

Three adversarial reviews (`reviews/01-review.md`, `reviews/02-review.md`, `reviews/03-review.md`)
found that docs 01–03 describe divergent systems at their seams. This memo is the orchestrator's
binding resolution. **Every decision below overrides anything contradicting it in docs 01–03.**
Amendment agents rewrite each doc to comply; a doc may reference another doc's owned contract but
must never redefine it.

> **Implementation rule:** D1–D25 are historical rationale, not copyable current API/DDL. Apply
> D26–D45 first; where they amend an older decision, the Round-4 form is the only implementable one.
> Current contract shapes live in owning docs 01–03 and 09–11.

## D1 — Contract ownership matrix (one owner per concept, others reference)

| Concept | Owner |
|---|---|
| Task contract (`defineTask`), id grammar, error taxonomy, effect/dry-run mechanics, retry policy, decoration, stores, session providers, shared leaf-code homes | **Doc 01** |
| Workflow builder API (single API), descriptor shape, RunEnvelope, run-state machine incl. gates/parks, checkpoint/resume model | **Doc 02** |
| Span/event wire schema, notes stream, storage layout, lift adapter, SSE wire shapes, completion (fan-out/approval) union | **Doc 03** |

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
  Playwright. `defineTask(contract, impl)` binds them; the store is the only impl registry.
Descriptors and the dashboard import contracts only. E2e stubs derive their happy path from
`example` (schema-parsed); failure/cancel/parallel scenarios REMAIN hand-scripted in the stub lane
(examples cannot express them — review 02 #12).

## D4 — System-less work gets service stores
Service stores (`local` for pure compute like PDF extraction/roster matching, `ocr-llm` for the OCR
provider pipeline) use the same contract; `sessions: []` is legal ONLY for service stores; browser
stores stay type-constrained to their own system's sessions.

## D5 — Waits and operator gates are run-state, not task internals
Tasks remain run-to-completion with bounded duration. Long waits (OCR approval, child-signature
watching, external signals) are **gate nodes** declared in the descriptor and owned by doc 02's
run-state machine; doc 03's `gate.opened/resolved` events are their wire form. Kernel policy: a
parked run RELEASES its browser sessions; resume reacquires via the store session provider
(re-login is idempotent). Duo is cleared automatically by Duo Autopilot on EVERY login — production
included (operator directive 2026-07-17, charter §9): there is no phone-approval poll, pause, or
manual-MFA path anywhere in the new design. Login is always unattended and bounded.

## D6 — dryRun lives on the RunEnvelope (kernel-owned), never in workflow input. Doc 02's table is amended.

## D7 — Write-ness is derived, never re-declared
`TaskStep.write` is DELETED. All write gating (refuse-replay, crash-park, freshness) keys off the
contract's `effect: "mutate"`. `defineTask` uses per-effect overloads so a mutate contract without
dry-run handling fails to compile where possible, with the runtime factory check as backstop (docs
must say "compile-time where possible, runtime-enforced always" — not overclaim "type-level").

## D8 — Checkpoint freshness (closes the stale-read→live-write hole, review 02 #2)
Every checkpoint records `capturedAt`. Every read contract whose output may feed a write declares
`freshness.maxAgeMs` (mandatory field on ALL read contracts; `Infinity` must be written explicitly
and justified in a comment). At resume, the kernel walks the step bind graph: if any replayed
checkpoint feeds (directly or transitively via later mappings) a mutate task in this run and its
age exceeds `maxAgeMs`, the kernel REFUSES loudly — naming the checkpoint, its age, the limit, and
the consuming write task — and requires either `always-rerun` of the producing task or explicit
operator override. Crash-mid-write still parks `needs-operator`.

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
Parity gate covers queue rows + log panel + session cards + wfCounts only. Capture, workflow-
modifier, settings, AI-assist proxy to the old endpoints until their own migration milestones.
One-week legacy-dashboard fallback stays. (Review 03 sized wholesale flip at ~103 endpoints / ~122
components — an unacceptable pre-Phase-2 mega-milestone.)

## D14 — SQLite role
SQLite remains system-of-record for claims + checkpoint payloads (NOT rebuildable/deletable);
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

- **D17 — Crash recovery is PROBE-THEN-PARK, not always-park (amends D8 + doc 02).** On a crash
  during a real submit, recovery re-runs the idempotency probe FIRST: `present` → backfill +
  ledger + done (no second submit); `absent` → clear the intent, safe to retry;
  `ambiguous`/`unknown`/throw → PARK `needs-operator`. Rationale: always-park does NOT prevent a
  double-file, it only defers everything to manual; probe-then-park prevents the double-file AND
  auto-resolves the confident cases, while the fail-closed `unknown → park` still honors "be very
  sure." D8's "crash-mid-write still parks needs-operator" clause and doc 02 §5.5 / §5.6#2 / OQ2 /
  the line-364 statement are amended to this. Doc 02's mutate step node gains a **required
  `probePolicy`** (`"always" | "retries-and-recovery-only"`, no default — the §b migration
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
- **D22 — Contract-shape + guards owner split.** Doc 09 owns the mutate contract's `writeSafety`
  shape: `completion` is a UNION (`receipt | save-verify | upload-verify`) + `idempotency`. Doc 10's
  `write-safety-contract` guard must walk that union — it must NOT demand a flat `receipt` schema
  from Kuali/OnBase (which use save-verify/upload-verify per charter §13). Doc 10 adds ratchets:
  `unverifiableByPage` requires an allowlist+reason entry, and every `effect:"mutate"` impl must
  route its transaction click through the `stores/common/mutation.ts` fence primitive (no raw
  `page.click` submit). Port fix: the "outcome unknown, refusing success" throw is in
  `clickSaveAndSubmit` (`transaction.ts:855-859`), not `waitForTransactionOutcome`.
  Doc 01 amendment (so the attachment isn't orphaned inside doc 09): doc 01 §2.2's
  `MutateTaskContract` carries the **reference-stub field** `writeSafety?: WriteSafety<In, Out>`
  (guard-required on every mutate contract) whose *shape* resolves to doc 09 §2.1 — doc 01
  references it, doc 09 owns it. Doc 01's header records this D22 amendment.

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
