# 07 — Master Plan: the single phased build order for `temp_src`

Status: **Phase 0 whole-plan revision complete, 2026-07-22. No `temp_src` implementation exists.**
This is the ONE plan the charter demands (§"One master plan"): every design doc converges here,
and there must never be a competing plan. It awaits operator approval before Phase 1 begins.

**What this doc is.** It *sequences* and *indexes* the build. It states the order phases run in, the
dependencies between them, and the hard exit criteria for each. For every work item it names the
**owning doc** — the binding detail lives there, and this plan never redefines it.

**What this doc is NOT.** It is not a design doc. It owns no contract. If this plan and an owning doc
disagree on a contract's shape, the owning doc wins and this plan is stale (and must be corrected —
see governance §0.3).

---

## 0. Program overview + governance

### 0.1 The one-plan rule

Per charter §"One master plan": the design docs (01–12) are the binding detail; THIS doc is the
authoritative build order. No second plan, no per-workflow "alt plan," no execution doc that
re-sequences phases. Per-workflow *migration plan docs* (Phase 3+) are **children** of this plan —
they answer the §b questionnaire (§3.4) and record what a workflow reuses/adds; they never re-order
the program.

### 0.2 D1 ownership map — the quick index (concept → owning doc)

Every concept has exactly one owner (reconciliation `04` D1). Reference the owner; never redefine.

| Concept | Owner |
|---|---|
| Task contract (`defineTaskContract`/`defineTask`), contract/impl split (D3), task-namespace grammar + closed `SystemId` union (D2), error taxonomy, three effects/dry-run mechanics, retry, decoration, system/service stores + pure workflow mini-stores, session providers + login signature, `stores/common/` leaf homes | **Doc 01** |
| Workflow builder API (single), descriptor shape, `RunEnvelope`, run-state machine incl. gates/parks (D5), checkpoint/resume + freshness walk (D8), label precedence (D16) | **Doc 02** |
| Span/event wire schema (D10), notes stream, storage layout, SQLite projection role (D14), SSE wire shapes, lift adapter + flip plan (D12/D13), completion (fan-out/approval) union (D11) | **Doc 03** |
| Binding cross-doc reconciliation (D1–D72, including 2026-07-22 Round 7) | **Doc 04** |
| Scheduler/lanes/fairness/backpressure, session pool + driver leases, executor process model, speed/sleep-tax contract, page/subject-isolation invariant | **Doc 05** |
| Data-service systems: CSV/PDF extraction, typed contact/address normalization, roster matching, durable mobile capture, operator column mapping, immutable intake manifest/rerun, Edit Data checkpoint UI | **Doc 06** |
| Cross-cutting gap findings memo (owns nothing — a design input) | **Doc 08** |
| Write-safety contract, permanent-key intents, typed proof, atomic outboxes/recovery, serialized anchored ledger | **Doc 09** |
| Guard/test architecture suite: ratchet port map, safety guards, descriptor-coverage crosswalk, guard-of-guards manifest, TDD tiers, stub + live lanes | **Doc 10** |
| The Clock (sole time source), config resolver (env>settings>default), per-run prod/test instance (D6-adjacent), fiscal-year rollover, secrets accessor, environment/preflight registry | **Doc 11** |
| Semantic UI vocabulary + typed drivers, failures/diagnostic bundles/evidence receipts, scenario corpus, structured knowledge/fix history, durable trust/explain surfaces, workflow explorer/editor, local-only scope, base capability inventory | **Doc 12** |

### 0.3 Standing rule — each completed phase documents itself

Charter §"One master plan": *the foundation's documentation is part of the foundation.* When a phase
completes, its owning docs are updated to describe **as-built** reality (not just design intent), and
this plan's phase table is checked off. A phase is not "done" until its doc delta is written. New
sub-systems get new docs or amend existing ones; stale prose is corrected, never layered.

---

## 1. Dependency graph of the base

The base/kernel is built along one critical path. Guard plumbing lands before the tree; the first
real `temp_src` leaf and every applicable type/lint/architecture arm activate in the same commit
(charter: "same quality umbrella from day one").

```
  guard scaffold
        │
        ▼
  domain + canonical-input validation + clock/config/runtime-dependency snapshot
        │
        ▼
  authority DB + backup/restore + command/write TYPE SHELL
        │                    (owned now; no later forward reference)
        ▼
  semantic UI registry + typed drivers + task/provider contracts/stores/sessions
        │
        ▼
  complete typed workflow DAG + results/delegation/completion/gates/scenarios
        │
        ├────────► core composition-root registry
        │                         │
        ▼                         ▼
  spans/lift/projections ◄── executor/checkpoints/commands/write sequencer
        │                         │
        └────────────┬────────────┘
                     ▼
  evidence/failures/notifications/knowledge + dashboard/intake/explorer UI
```

**Critical path: guard → strict domain/config → authority/recovery → semantic driver/task store →
workflow graph/delegation → registry/executor/commands/events → trust services/dashboard.**
Justification:

- **11 (clock/config/secrets) is the root.** Every timestamp (spans, checkpoints, trace ids, fence),
  every URL/timeout/fiscal date, and every credential reads through it. Building 01+ on raw
  `new Date()`/`process.env` would require re-threading later; the `clock-single-source` and
  `secrets-single-source` guards must be green from the first `temp_src` file.
- **Write-safety types/storage precede commit task contracts.** `CommitTaskContract` cannot refer to
  a later-owned placeholder. The dependency-free `WriteSafety`/proof types and SQLite authority/
  outbox schema land first; sequencing behavior lands with the executor later.
- **Authority recovery precedes authority use.** Claims/checkpoints/dependencies/write intents are
  not rebuildable; creating them before backup/doctor/degraded-mode contracts would make Phase 1
  green on a database it cannot safely recover.
- **Semantic UI ids and typed drivers precede browser tasks.** Tasks must be authored against one
  canonical element/page-state/observation vocabulary from their first line; raw Page/selector debt
  is not ported into task implementations and “cleaned up later.”
- **01 before 02** — the descriptor (02) composes task contracts; the
  builder's `Steps` type map (D15) is typed against contracts.
- **The 02/03 completion seam lands together in 1e.** Doc 03 owns the bundle-safe completion-program
  union while doc 02 owns the descriptor/gate graph that contains it; both domain types land in the
  same work item. Doc 03's event/storage/projection implementation waits until 1g, so neither side
  forward-declares a later contract.
- **Registry is above workflows.** `core/workflow-registry.ts` imports descriptors/stores; domain
  never imports workflows. The dashboard receives generated/server projections, never workflow modules.
- **Executor, command service, and events co-evolve after the graph.** The executor emits events and
  owns transaction sequencing; the command service owns every queue mutation/dependency target;
  durable authority/outbox contracts already exist, so no layer forward-declares another.
- **Trust records are base data, not dashboard decoration.** Failure/evidence/scenario/notification/
  knowledge schemas land before the UI that projects them. The read-only Workflow Explorer is a
  descriptor projection and lands in Phase 1; constrained editing waits until the compiler/runtime
  contracts are proven in Phase 2.
- **10 is orthogonal, not sequential** — it is built alongside every step (guards land as their
  target concepts appear), never "at the end." Its own meta-guard (`guard-manifest`) is what stops
  the umbrella silently shrinking.

The **data-service stores** (doc 06's `extraction`/`normalization`/`ocr`/`roster` contract+impl, D4)
are built as ordinary stores in Phase 1h after strict task/scenario/evidence contracts exist. Their
column-mapping, durable mobile-capture, intake-manifest/rerun, and Edit-Data UI lands in 1h/1i over
synthetic fixtures, so Phase 3 workflows consume an already-proven base instead of inventing ingest
semantics mid-migration.

---

## 2. Phase table (at a glance)

| Phase | Headline deliverable | Gate to exit |
|---|---|---|
| **0** | Corrected foundation design approved; empty rebuild tree | Round-7 decisions reconciled across 00–12; executable feasibility + honest gate baseline recorded |
| **1** | Complete base/kernel + trust/authoring foundation in `temp_src` | full gates green; strict/subject/control/delegation/recovery/scenario/evidence/notification fixtures pinned; read-only explorer works on synthetic state |
| **2** | Read slice + transactional safety + constrained-editor proof | person-lookup live; subject-bound dry-run and controlled commit/crash recovery/outbox/ledger proof green; editor compile/diff/apply proven only for safe closed fields |
| **3+** | Per-workflow migration, one at a time (order §3.3), plus explicit non-workflow capability closure (§3.6) | each: §b questionnaire answered; live dry-run + controlled write evidence where applicable; migrated leaves removed or explicitly retained for named legacy consumers; every capability inventory entry advances to native/replaced/retired; docs updated |

---

## 3. Phased plan (detail)

### Phase 0 — foundation design

**Goal.** Every foundational contract is designed, adversarially reviewed, and operator-approved
before any `temp_src` code is built (charter §Process: nothing is built before its design part is
approved).

**Status (2026-07-22 revision).** Docs 00–12 have been reconciled through Round 7 (D46–D72) after
the entire design and relevant legacy code were reread. The abandoned skeleton and spike remain
deleted; Phase 1 has not started. This corrected design now awaits operator approval as one set.

**What remains.** Operator approval of this revised document set and explicit acceptance that the
system-specific questions below block only their named migrations, not Phase 1. No foundational
design document remains unwritten.

**Deferred decisions (logged, resolved at the named point).** Kuali `save-verify` and OnBase
`upload-verify` vs always-park (doc 09 OQ1/OQ2—before their first migration); per-workflow prewrite
probe policy/elapsed budget and pending-termination sweep modeling (09 OQ4/OQ5—each §b questionnaire).
Canonical EID is now settled as `/^10\d{6}$/` with a legacy-fixture audit; roster-match freshness is
settled at a 24h base maximum over immutable artifact observation time (doc 06 §1/§4). Checkpoint
retention is settled by D14—logical-item deletion only, never JSONL age. Ledger altitude, config
snapshots, four lanes, and context-exclusive transactions are also settled defaults, not open
Phase-1 dependencies.

**Executable feasibility evidence (not implementation).** Disposable files outside the repository
were compiled/run with the project's actual Node 26, TypeScript 5.9, and Zod 4 dependencies. The
spike proved effect-specific contract overloads and negative type controls, provider-client
narrowing, canonical-input transform-once/revalidate-many behavior, strict command arms, target-
field mappings, typed child results, proof unions, a 40-node typed chain, post-write settlement,
SQLite permanent-key/atomic-outbox behavior, and native online backup/read-only verification. The
40-node compile completed in 0.68s at about 212 MB. This establishes feasibility only: D71 requires
the same controls against the real API as committed Phase-1 tests. One adversarial case initially
failed—pre-propagation negative evidence could contribute a vote—and is now closed by D69.

**Measured existing gate baseline.** `typecheck:all`, unit+serial tests, all 137 architecture tests,
and dashboard build pass. Source lint currently has 2 errors + 1 warning; test lint has 1,325 errors
+ 2 warnings. D70/doc 10 §1.1 makes this explicit: source lint is repaired before 1b; new rebuild
source/tests are zero-warning from their first file; legacy test diagnostics are fingerprinted,
shrink-only coexistence debt and must reach zero before final cutover. No plan milestone may report
`npm run lint:tests` green until it actually is.

**Exit criteria.** Docs 00–12 and this build order approved; every deferred question has an owner,
evidence needed, and resolution point. No `temp_src` code before this gate.

---

### Phase 1 — the base/kernel

**Goal.** Build the dependency graph (§1) as `temp_src`, inside the same tsconfig project + unit
tests + `test:architecture` ratchets extended to cover it (charter non-negotiable: no ungated
parallel tree). The base is proven by tests + fixtures, not by a live workflow (that is Phase 2).

**Ordered work items** (each cites its owning doc; each lands with its guards):

| # | Work item | Owner | Key guards that must be green at this step |
|---|---|---|---|
| 1a | **Pre-tree guard plumbing + honest legacy baselines.** With `temp_src` still absent, first extract shared walk/allowlist helpers as a zero-count-change commit; add the reviewed guard inventory, D58 capability baseline, and exact path-exemption tests; repair the 2-error/1-warning source-lint baseline without suppressions; generate D70's diagnostic-fingerprinted shrink-only legacy-test lint manifest and zero-debt/non-vacuous rebuild lint commands. Do not add unmatched CLI globs or pretend an absent tree was scanned | **Docs 07/10** | helper-refactor preserves measured architecture file/test count; `npm run lint` green before 1b; legacy diagnostic fingerprints reproduce exactly then only shrink; new-tree lint commands reject warnings and unmatched paths; guard/capability inventories self-validate; every workflow/service/route/UI/CLI/tool family classified; nested-`scripts` fixture |
| 1b | **First strict domain leaf + full coverage activation, atomically.** Add closed/branded ids, canonical JSON/absence/error types, Clock/config/secrets/redaction classifications, exhaustive runtime-dependency + environment/preflight registries, and base failure/evidence/scenario/knowledge schemas; activate `temp_src` typecheck, ESLint CLI+config, whole-tree ratchets, and layer matrix in the same commit | **Docs 01/10/11/12** | strict-boundary schema inventory; typecheck/lint non-vacuity; clock/secrets/config/preflight/redaction canaries; defaults parse; resolver return types; bidirectional system/provider/endpoint/secret prerequisite coverage; no open decision maps |
| 1c | **Authority storage + recovery + command/write type shell.** Create the infra-owned native authority adapter, versioned authority/projection table classes, self-describing `node:sqlite` online-backup manifest/doctor/degraded-mode/restore APIs, full command-family types, `ProbeVerdict`/negative-settlement policy, typed write-binding proof union, permanent intent/attempt, dependency/manifest, gate-result, notification, outbox and ledger-head schemas before consumers refer to them | **Docs 03/09/11** | DDL/invariants; raw `DatabaseSync` private; authority vs projection enumeration; boot corruption fixture; native backup opens/read-checks its own generation + follow-up trigger; restore skeleton; committed key cannot reinsert; pre-window/single negative cannot unlock retry; no untyped command/proof/gate/notification arm |
| 1d | **Semantic UI registry, typed drivers, task + provider contracts and stores/sessions.** Inventory legacy selector keys into one canonical id/alias migration map; implement the server-only recipe registry, safe generated `UI-CATALOG.md` projection, driver boundary, then read/prepare/commit overloads, subject specs, mutation capability, freshness/provenance, artifact writer, declared provider capabilities with narrowed injected clients, store/session providers and exclusivity. Fully typed recipes populate as tasks migrate; no task may port first and bypass this step | **Docs 01/05/12** | semantic-id uniqueness/dependencies/catalog; catalog omits recipes; commit UI actions require mutation capability; raw Page/Locator absent outside driver/session internals; remote I/O requires provider declaration and infra adapter; effect/capability/subject/contract/impl/example/error/store/no-any/artifact/OnBase guards; every new observation/recipe has fixture plus live/read-only verification evidence |
| 1e | **Complete workflow DAG + result/delegation/scenario descriptor.** Real-scale type spike first; then ingress parser plus transform-free canonical-input validator, read/transaction/branch/fork-join/typed child result/gate nodes, complete delegation policies/manifests, enqueue/actions, completion, fingerprints, checkpoints/migrations and registered scenarios | **Docs 02/03/12** | realistic graph type suite; ingress→canonical round-trip and corrupted-authority rejection; strict terminal/gate result; delegation matrix; transaction pairing; descriptor projection matrix; no erased target; every branch/gate/policy has an executable scenario |
| 1f | **Core registry + executor/checkpoints/command service/write sequencer.** Composition root above workflows; claims/lanes/provider budgets; standard run/gate/notification/capture commands; authority-only target resolution; context-exclusive transactions; probe→prepare→binding proof→fence→commit→proof→atomic outbox; evidence-qualified negative recovery and parked-intent resolution | **Docs 02/03/05/09** | command idempotency/CAS; lookup failure creates no duplicate; no visible-root fallback; dry-run commit-free; binding mismatch/unknown creates zero fence/click; a bare/early negative cannot retry; provider admission, probe-age/settlement/CAS/dedupe/crash/context tests |
| 1g | **Events/tracker/lift/projections + ledger/evidence/notification services.** Strict spans/notes, structured failures, diagnostic bundles, run receipts/explain, durable notification inbox/delivery, unified projection, per-run migration authority, serialized ledger + tail verification, compatibility API | **Docs 03/09/11/12** | boundary corruption; redaction canaries; evidence completeness/confidence; notification delivery-failure durability; real-day lift/generation; atomic projection/ledger/tail-loss tests |
| 1h | **Data-service/intake foundation.** extraction/normalization/ocr/roster stores; shared AI-provider admission infra; generic/duplicate-safe mapping; strict validation/rejection; immutable manifests/rerun diff; durable capture sessions/photo artifacts/finalize outbox; Edit Data core; stable-keyed local artifact projector | **Docs 01/03/06/12** | novel/duplicate headers; explicit normalization unavailable/ambiguous outcomes; no auto mapping/default; atomic intake/member counts; capture restart/idempotency/bundle-crash/handoff; rerun hash drift; edit CAS/provenance; workbook retry/concurrent-edit/blocking ack |
| 1i | **Dashboard + operator/authoring foundation.** Four parity surfaces, evidence/failure/notification/run-explain views, storage health/backups, Edit Data/intake/capture, generated UI catalog/reference, optional read-only AI advisories, and Phase-A read-only Workflow Explorer/timeline over tasks/mini-tasks/delegation/scenarios/source links | **Docs 03/06/12** | golden payloads; client renders finished wires only; no workflow-id maps; evidence/notification/storage/capture states visible; AI has no command/authority edge and unavailable is visible; explorer graph round-trips descriptor projection; headless a11y + screenshots |
| 1j | **Base integration/restore/soak and documentation gate.** Execute the full scenario corpus, corruption→restore drill, dependency/control/capture concurrency matrix, executor teardown/parallel soak, evidence/notification/AI redaction scan, validate the legacy capability inventory, then update every owning doc to as-built before Phase 2 | **Docs 03/05/10/12 + this plan** | all commands below green; zero orphan scenarios/guards/unclassified capabilities; restored authority hashes/invariants match including capture; no unresolved doc ownership drift |

**Item 1e begins with a new real-scale type-inference proof.** The deleted spike covered only two
effects and three linear steps. The replacement must compile a representative 15–25-node graph with
read/prepare/commit, transaction pairing, output-dependent branch, fork/join, typed child runs,
external/children gates, heterogeneous completion stages, decorations, errors, and schema changes
that deliberately fail their consumers. No production builder or skeleton lands until the positive
and negative controls pass under the real toolchain with no `any`/`unknown` target erasure.
The D71 disposable 40-node simplified chain is a feasibility floor, not a substitute. The real
suite records `tsc --extendedDiagnostics` and fails if the representative file exceeds 5 seconds or
1 GiB on the same baseline machine; a regression outside that budget stops builder work for type-
shape simplification rather than being normalized as editor lag.

**Hard exit criteria (Phase 1).**
- `npm run typecheck:all` (both tsc programs), `npm run lint`, `npm run lint:rebuild`,
  `npm run lint:rebuild-tests`, `npm run lint:legacy-tests-ratchet`, `npm run test`, and
  `npm run test:architecture` are **all green**, with every guard inventoried and covering
  `temp_src`. During coexistence the fingerprinted legacy-test ratchet is the honest gate;
  `npm run lint:tests` becomes mandatory once its D70 manifest reaches zero and is deleted.
- Write-safety fixtures pin simultaneous and later sequential same-key dedupe, proof validation for
  every completion arm, fresh subject binding, crash injection across atomic commit, and ledger
  projector concurrency/tail loss. Alternating-EID/file-digest mismatch produces zero fence/click.
- Command/delegation fixtures prove transactional enqueue policies, CAS/idempotent actions,
  authority-only cancel targets, zero/one/many/partial/cancel/retry/replay/multi-edge child behavior,
  and no duplicate active runs when authority lookup fails.
- Strict schema mutation tests cover every durable/wire/config/intake/evidence boundary recursively;
  raw Page/Locator/selector access exists only in driver/session internals; generated UI catalog has
  no duplicate ids/aliases or unresolved dependencies.
- A real-shaped copied authority DB passes corruption detection → read-only degraded mode → newest
  checksummed-backup restore → projection rebuild, preserving commands/dependencies/checkpoints/
  write intents/outboxes. Backup age/health is visible.
- Every task/workflow/UI dependency references executed scenarios. Every terminal fixture emits a
  complete evidence receipt/confidence or structured failure+redacted diagnostic bundle. Failed OS
  notification delivery still leaves a durable unread inbox item.
- Capture fixtures prove open/finalizing sessions survive restart; duplicate/reordered requests do
  not duplicate photos or handoffs; bundle/enqueue crash points converge; and the phone origin
  cannot reach a non-capture route. Optional AI-advisory fixtures prove redaction, strict output,
  explicit provider exhaustion, and zero command/completion/registry-write authority.
- The `real-tracker-day zero-quarantine` lift replay passes on real `.tracker` days (D12).
- Legacy row/log/session wire schemas have an explicit version, `v0` fixtures for pre-version data,
  and a source-schema guard requiring version bump+adapter+goldens for every later shape change.
- Zero new-code allowlist entries in any extended ratchet (ported leaves shrink-only, argued).
- Every activated guard arm resolves a non-empty file set; ESLint's CLI target and typed config block
  both cover `temp_src`. Missing paths and unmatched patterns are failures, not skips.
- **No external HR write involved yet.** The base is unit/fixture/headless-dashboard proven. Existing
  selector knowledge maps from the legacy registry; newly introduced page-state/observation recipes
  receive read-only live verification as they enter the catalog. End-to-end workflow driver proof and
  all external-write proof begin in Phase 2/per-workflow migration.

**Program invariant Phase 1 establishes—versioned legacy compatibility, not a production freeze.**
The old `src` remains maintainable. Central emitters stamp a row/log/session schema version; old
unstamped data is `v0`; the lift has one checked adapter per supported version. A source-schema
snapshot guard requires any legacy wire change to bump the version and land adapter+golden fixtures
in the same commit. Unknown versions/shapes quarantine visibly and cannot be mis-lifted through a
default arm. **Dual-maintenance honesty:** UCPath/CRM windows are program-length because almost every
workflow consumes them; single-consumer systems should be shorter. All windows are explicit and end
when the final consumer migrates.

---

### Phase 2 — read spine, subject-bound transaction, and constrained-editor proofs

**Goal.** Before any bulk migration, prove both halves the foundation claims: the read/projection
spine and a page-scoped external-write transaction with recovery/durability.

**Why person-lookup.** UCPath+CRM reads only, so it exercises no commit boundary or irreversible
risk, yet it covers the spine: descriptor → contracts → executor → session
pool (the proven 4-tab shared context) → spans → dashboard projection. Its worked example is already
written in doc 02 §8.

**Read work items.** Author `person-lookup` descriptor + UCPath/CRM read tasks (port
`person-org-summary` + CRM match leaves, wrapped); wire the scoped dashboard flip (§4) for queue/log/
session/wfCounts; register real ambiguous/not-found/retry scenarios; run the live dry-run and inspect
its evidence receipt/`explain run` output.

**Transactional work items.** Choose the smallest controlled test-instance or sacrificial test
record whose prepare and commit paths are real and whose outcome is independently queryable. Build
its transaction pair. First run dry-run and prove staged preview plus subject observation capability
with zero intent/commit. Inject a wrong displayed subject and prove zero fence/click. Then, only
under the explicit Phase-2 test protocol, perform one controlled commit, inject process crashes at
the supported seams in repeatable fixtures, and prove permanent-key dedupe, typed recovery proof,
atomic outboxes, serialized ledger projection, and context cleanup. The crash matrix includes an
early `absent`, repeated but not-yet-aged absence, conflicting observations, stabilized absence,
positive proof, malformed proof, and unavailable target; only the policy-qualified stabilized arm
may create a new intent generation, while every indeterminate arm parks. If no safe independently
verifiable target exists, Phase 2 is blocked; write-heavy workflow migration may not begin.

**Workflow editor proof.** Phase A's read-only explorer is already base. Phase 2 implements only the
safe Phase-B subset from doc 12. Presentation overrides hot-apply through their strict atomic file.
For graph/policy edits, source-authored workflows produce reviewed patch scaffolds only; a synthetic
or deliberately converted low-risk workflow proves the DSL-authored path, where one strict
`workflow.definition.json` is sole graph authority and TypeScript/client projections are generated.
The proof validates scenarios and graph/result types, increments version/fingerprint, writes
DSL+generated artifacts atomically, requires restart, and rolls back to the prior exact hash.
Selectors, driver operations, schemas, arbitrary bind functions, and write-proof/subject rules
remain code-only. If the closed compiler cannot express an edit, it refuses and generates a
code-change brief rather than emitting partial config or a second authority.

**Hard exit criteria (Phase 2).**
- Live dry-run reads real UCPath + CRM (Duo cleared hands-off by Autopilot, charter §9) and produces
  a correct person-lookup result on the new executor.
- `descriptor-coverage` green for person-lookup; every projected surface (queue row, log panel,
  session/executor card, wfCounts) renders from the descriptor — verified headless via the
  `playwright-cli` seed→boot→assert loop (root CLAUDE.md).
- The **D13 parity gate** passes for the scoped surfaces (queue rows + log panel + session cards +
  wfCounts) against the old dashboard's golden payloads.
- Speed sanity: sleep-tax measured (`sleepMs` per task span); person-org read path materially below
  the old ~24s sleep budget (doc 05 §4.1 target), recorded.
- Docs updated: doc 02 §8 marked as-built; any contract flaw found is fixed in the owning doc first.
- Transaction dry-run shows prepare preview and zero commit span/intent. Controlled write proof
  records a fresh matching subject proof; the forced mismatch/unknown variants produce no intent or
  click. The controlled match yields one external transaction, one committed intent, one typed transaction-output checkpoint
  plus validated proof, one ledger entry,
  one terminal span; a later fresh same-key run performs no second click.
- Crash/outbox/projector fixtures and context-exclusive UCPath/OnBase lease tests remain green under
  multiple executors. Recovery demonstrates that one `absent` observation cannot retry, durable
  `not_before` scheduling occupies no execution lane, and only contract-qualified negative
  settlement may increment the generation.
- Read-only explorer accurately renders the as-built person-lookup graph/task/UI/scenario/result
  dependencies and exact source links. Every supported constrained edit passes compile+scenario+
  diff+version+restart-gated atomic apply+rollback in its declared authoring mode; every prohibited
  code/selector/proof edit refuses loudly and no workflow has two graph authorities.

**What Phase 2 still does not prove.** Workflow-specific gates and each production system's receipt/
verify quality remain migration-specific. The foundation write sequence itself is no longer deferred
to order 6. One later checkpoint remains:
- **First-gate live checkpoint — order 4** (oath-signature/emergency-contact): the first live exercise
  of the completion union + an approval gate (park/resolve) end to end on the new base.
- **First workflow-specific production write checkpoint — order 6** validates that workflow's
  receipt/probe policy on top of the already-proven transaction kernel.

---

### Phase 3+ — per-workflow migration (one at a time)

**Goal.** Migrate the remaining workflows onto the new base, **one at a time**, slowly populating the
task stores with what each needs. Every workflow gets its own migration plan doc (a child of this
plan) answering the §b questionnaire and recording its reuse/additions. Per-system old code is
deleted the moment that system's workflows are fully migrated (charter §Migration).

#### 3.1 Migration loop (per workflow)

1. **§b operator questionnaire** (§3.4) — asked and answered BEFORE building (charter §b: "cover
   everything for each workflow as we migrate").
2. **Author** — reuse store tasks (peer-to-peer, charter §1); add new tasks as reusable bases +
   name the workflow-specific customization (charter §3/§8); reuse/add canonical UI ids and driver
   operations first; write strict contracts + scenarios → impls → pure-logic unit tests (`fakeCtx`)
   → descriptor/result/delegation policies (doc 10 §6 red→green order).
3. **Safety guards fire** — strict schemas, driver boundary, scenario coverage, transaction pairing,
   subject-before-fence, dry-run commit-free, write safety/capability, permanent-key dedupe,
   command/delegation, provenance, graph/result typing, evidence, and stable identity all green.
4. **Live dry-run** reads the real path and asserts prepare previews exist while commit spans,
   write intents, and mutation helpers are absent.
5. **Controlled commit proof for write workflows.** Exercise each new commit/probe/verify against a
   configured test instance or a deliberately harmless, operator-approved canary. If neither exists,
   cutover is blocked—dry-run alone cannot prove landing, recovery, or dedupe. The §b questionnaire
   records target, cleanup/reversibility, expected proof, and stop condition before this test.
6. **Generation cutover.** Stop new legacy enqueues, atomically increment generation and enumerate
   existing legacy runs as the authorized drain set, then route new runs native. Parked legacy runs
   may finish on the old path and remain visible. Hand-migrate only when explicitly chosen and
   checkpoint fingerprints/provenance validate; never require the entire old set to drain before
   native work begins and never assign authority by event timestamp.
7. **Close the learning loop.** Any failure discovered produces a regression scenario + structured
   knowledge/fix record; stale knowledge is superseded rather than appended beside the correction.
   Update affected D58 capability entries, delete old code only when every named consumer is gone,
   and update the nearest CLAUDE.md + owning docs.

#### 3.2 Exit criteria (per workflow)

- §b questionnaire answered + recorded in the workflow's migration doc.
- `typecheck:all` + `lint` + `test` + `test:architecture` green; the workflow's descriptor passes
  `descriptor-coverage`; every commit contract passes `write-safety-contract` (its completion arm +
  probe + probe-policy) and transaction pairing.
- Workflow/task inputs, outputs, results, commands, details, and evidence parse strict; every UI id,
  scenario id, child result/policy, and subject observation resolves. No raw Page/Locator/selector
  appears outside the system driver.
- **Live dry-run** green against every real system it touches (submit-free).
- Every commit/probe/verify has controlled live evidence on the configured target; unavailable safe
  evidence blocks cutover rather than converting dry-run success into a write-safety claim.
- Old per-system `src` code deleted once that system has no remaining un-migrated consumer; a
  system's dual-maintenance window is bounded and explicit; shared UCPath/CRM may remain until their
  last consumer, while single-consumer stores should close promptly.
- Every old service/route/dashboard/CLI/tool capability touched by the workflow has an updated D58
  disposition; no new proxy is implicit and every removed source path has zero remaining imports.

#### 3.3 Recommended migration order (by risk / complexity / reuse)

Read-only and simple first (populate the read stores, low blast radius); OCR/approval flows next
(exercise the completion union + gates); write-heavy last (the write-safety contract's real test),
with the two **incident** workflows (onboarding duplicate-person, separations wrong-person) dead
last as the highest-stakes proofs.

| Order | Workflow(s) | Class | One-line justification |
|---|---|---|---|
| 0 | **person-lookup** | read | Phase 2 slice; will prove the spine before any migration |
| 1 | **person-match**, **i9-lookup** | read | Pure UCPath reads; reuse person-lookup's store tasks almost wholesale — fastest reuse proof |
| 2 | **crm-doc-download**, **sharepoint-download**, **old-kronos-reports** | read/download | Single-system reads/downloads; stand up crm/sharepoint/old-kronos stores at low risk |
| 3 | **ocr** pipeline workflow (consumes the Phase-1h service stores) | service | No browser, no submit; the `extraction`/`normalization`/`ocr`/`roster` service stores are already built in **Phase 1h** (§3.5) — this order migrates the pipeline *workflow* on top of them, unblocking every OCR/contact/roster-dependent workflow below |
| 4 | **oath-signature**, **emergency-contact** | OCR fan-out + light write | Exercise the completion union (D11) + approval gates (D5) + operation-member fan-out; the write is a bounded UCPath enter/fill |
| 5 | **i9-check** | UCPath read + durable roster projection | Operation coordinator + member enqueue + display-only rows, but **no external submit**; its stable-keyed SQLite outbox + serialized workbook projector must prove retry-safe local materialization |
| 6 | **work-study**, **kronos-pay-rule** | single write | First workflow-specific production commits—small, isolated; validate receipt/save proof on the proven transaction kernel |
| 7 | **oath-upload**, **onbase** | write-heavy (ServiceNow + OnBase) | ServiceNow `receipt` + OnBase `upload-verify`/`unverifiableByPage`; oath-upload ports the born-at-upload fence (the write-ahead pattern the kernel generalizes); resolve OQ1/OQ2 here |
| 8 | **separations** | write-heavy (UCPath term + Kuali) | Wrong-person incident (`T002173685`); needs UCPath `receipt` probe + pending-sweep + Kuali `save-verify` + identity-approval gate — the deepest write-safety proof |
| 9 | **onboarding** | write-heavy (UCPath hire) | Duplicate-person incident; the hire probe (no-EID key, `ProbeVerdict`-widened) + roster ingest — last, highest-stakes, most reuse of everything below it |

**OCR review UI flips WITH the OCR workflow (orders 3–4), not as a proxied surface.** Per doc 03
§5.4, the OCR review/approve mutation routes are excluded from the scoped-flip proxied long tail;
they belong to the OCR workflow's own surface set and migrate native together with the OCR pipeline
(order 3) and its first approval consumers (order 4) — so the completion union + approval gates are
exercised by the native review UI, never left reading legacy rows via `/api/ocr/approve-batch`.

**Order-8 prerequisite — the separations identity-approval GATE-NODE has no design yet.** Before the
separations migration, an explicit gate-node **design task** must land: the identity-approval gate's
**resolver** (what the operator confirms), its **park/resume** lifecycle (doc 02 run-state gate), and
its **EID-mismatch surfacing** (how a wrong-person candidate is shown and blocked). This gate — not
the write-safety probe — is the actual defense against the `T002173685` **wrong-person** incident
(the probe prevents a double-**file**, never a wrong-**person**; risk #4). It is currently undesigned,
so it is called out as a named order-8 predecessor task, not assumed to fall out of the write path.

**Order-6 canonical-EID audit gate.** The base decision is already made: `Eid` is
`/^10\d{6}$/`; there is no `legacyEid`. Before work-study/separations cutover, replay their real
stored/fixture inputs through the canonical schema and surface every rejection. If evidence reveals
a genuinely different source identifier, model it under a specific domain name/brand with an
explicit verified conversion to `Eid`; do not widen the canonical type. This is an evidence gate,
not an unresolved architecture choice.

#### 3.4 The §b migration questionnaire (reusable template)

Embed in **every** workflow's migration plan doc; answer with the operator BEFORE building
(charter §b). Grounded in docs 09 (write-safety) + 11 (freshness/instance) + 02 (gates).

1. **Real commits** — which actions mutate the external system? For each, define a prepare contract,
   commit contract, one transaction lease scope, stable idempotency key, expected subject,
   post-prepare semantic observation, normalizer/matcher, and mismatch/unknown evidence.
2. **Completion check per submit** — receipt (UCPath/ServiceNow: source of the confirmation/ticket
   number + its schema) | save-verify (Kuali: the read-back task) | upload-verify (OnBase: the
   positive read-back, OR an argued `unverifiableByPage`→always-park)? (Doc 09 §2.)
3. **Double-submit probe policy and age budget per transaction** — `"always"` or
   `"retries-and-recovery-only"` (may miss only an older external write on an unseen durable key)? Required, no default
   (doc 09 §5 / D17). What justified `probeToFenceMaxMs` bounds preparation after the live probe?
4. **Dry-run preview** — confirm what prepare evidence is shown and whether the run stops there;
   commit is structurally absent.
5. **Freshness maxAges — justify the *value*, not just its presence.** For each read whose output
   feeds a write, state default/field freshness limits, whether each non-identity field is
   `forbidden|audited` for override, and **why each is right**
   for this data's staleness risk — the guard only checks the field is *present*, never that the
   value is *correct*, so the operator owns justifying it (a too-large window silently reuses stale
   data into a live write). Identity, match/item, idempotency, and proof fields are never overridable;
   `Infinity` must be argued in a comment.
6. **Workflow-specific gates/data** — identity-approval gate? OCR approval gate? EID re-match?
   roster column mapping/intake manifest, mobile capture, or normalization approval (doc 06)?
   per-run test/prod instance need (doc 11 §4)?
7. **Reuse map** — which store tasks reused (peer-to-peer), which new, and for each new task: its
   reusable-base design + the workflow-specific customization (charter §3/§8). Which canonical
   UI element/page-state/observation ids and typed driver methods are reused or added? Are any names
   aliases/migrations rather than new concepts?
8. **Local artifact effects** — does a read download immutable bytes (content-addressed writer), or
   does the workflow update a mutable local file? Mutable targets require a stable-keyed blocking
   outbox projection, idempotent upsert semantics, and concurrent-edit/head-hash policy—not a task
   append.
9. **Scenario inventory** — enumerate happy, no-match/empty, ambiguous, schema error, transient,
   permanent, every branch/gate/delegation/control path, subject mismatch, proof unknown, crash,
   retry, and discovered real-world variants that apply. Name truly impossible variants and why.
10. **Delegation and queue policy** — enqueue policy; standard actions; for every child edge: stable
    item id, typed result, cardinality/join, child failure, cancel, child retry/parent resume, and
    visibility. Include two-edge behavior when the workflow delegates more than once.
11. **Trust contract** — what evidence makes each terminal outcome `verified|partial|unknown`? What
    artifacts/screenshots/proofs are required, what is redacted, which failures/notifications fire,
    and how does `explain run` answer “what happened?”
12. **Authoring mode** — does this workflow remain source-authored (normal for complex/custom bind
    logic) or is its entire graph representable in the closed DSL and deliberately converted? Never
    retain handwritten and DSL graph authorities together. Which routine edits should the explorer
    expose directly versus generate as a code-change brief?

#### 3.5 Where the data systems slot

- **Service stores** (`extraction`/`normalization`/`ocr`/`roster` contract+impl) — **Phase 1h** (they need 01+11+12)
  so they exist before consumers; the **ocr pipeline workflow** migrates at **order 3** (before its
  OCR/roster consumers at orders 4–5, 9).
- **Provider infrastructure + advisory AI.** Shared model/key/rate-limit clients land in 1h for OCR
  and normalization. Operator triage/sanity/selector/summary adapters land in 1i against redacted
  structured evidence but stay disabled for authority and cut over after Phase 2 proves the receipt/
  failure surfaces. Provider absence is an explicit advisory-unavailable result.
- **Column mapping + intake manifest + Edit-Data UI** (doc 06) — land in **Phase 1h/1i** as base
  capabilities over synthetic fixtures, even though their first production workflow consumer is
  work-study (order 6). This avoids inventing data/rerun/edit contracts during a high-risk write
  migration. Note **i9-check (order 5) does not exercise operator mapping**—it matches against a
  fixed retention roster—but it does exercise the same stable artifact/outbox/evidence machinery.
  Work-study and onboarding therefore validate an already-built mapping surface rather than owning it.
- **Mobile capture** backend/session recovery/bundle outbox lands in **1h** and its dashboard/phone UI
  in **1i** over synthetic handoffs. It remains legacy-proxied until the native OCR workflow cutover
  at order 3, then flips with OCR so finalized PDFs cannot cross old/new authority implicitly.

#### 3.6 Non-workflow capability closure inventory (D58)

Workflow directories are only part of the old program. `config/rebuild/legacy-capabilities.json`
is created in 1a from a source inventory and maintained through deletion. Every entry has a stable
capability id, non-empty source paths, kind (`service|route|dashboard|cli|export|codegen|maintenance|
dev-tool`), known consumers, one strict disposition, owner milestone, verification evidence, and
status. Dispositions are a discriminated union:

- `native { milestone, targetIds }` — equivalent/improved native capability exists;
- `replaced { milestone, replacement, differencesAccepted }` — intentionally solved another way;
- `retired { milestone, evidence, reason }` — proven unused/unwanted; “seems dead” is insufficient;
- `proxy { removeBy, nativeDisposition }` — temporary only, with the closing milestone embedded.

The initial grouped decisions are:

| Legacy capability family | Binding disposition and milestone |
|---|---|
| `services/capture` + capture routes/components/ngrok | native durable capture foundation in 1h/1i; proxy only until OCR order 3, then remove old route/service/UI together |
| `services/address` + `llm/normalize-contact` | replaced by `normalization` service contracts in 1h; OCR order 3 proves real contact normalization/approval parity |
| OCR vision provider pool/rate limits/key status | native shared provider infra + OCR store in 1h; OCR workflow/order 3 closes legacy provider consumers |
| LLM triage/sanity/selector/summarize routes + ops scripts | native optional advisory adapters in 1i, cut over after Phase 2 trust surfaces; deterministic explain/rules/catalog remain primary; no authority edge |
| `services/matching` | roster/domain identity contracts in 1h; each real consumer closes during orders 3–9; no hardcoded header matcher survives |
| `services/timecard` | pure Clock-injected domain range logic + semantic common driver helper in 1d; Old Kronos adapter closes at order 2, New Kronos at order 8 after its last separations consumer |
| queue/task/dependency/worker/browser/daemon control routes | native command/executor/session protocol in 1f and operator UI in 1i; workflow-specific aliases disappear as each workflow cuts over |
| files, screenshots, search/failures, SSE/projection routes | native artifact/evidence/query/projection services in 1g/1i; compatibility aliases removed with the last legacy UI consumer |
| settings, preflight, credentials reference | native strict config/secrets/storage-health UI in 1b/1i; legacy settings proxy removed after Phase 2 UI verification |
| workflow presentation/design/data-bank/modifier | read-only explorer in 1i; constrained editor/replacement in Phase 2; old generated design briefs are migrated as history or retired, never runtime authority |
| OCR review/approve/retry/research/discard routes | native OCR workflow/gates/commands at orders 3–4; no compatibility mutation route remains afterward |
| oath-upload/sharepoint and other workflow-special routes | absorbed into descriptor start surfaces and standard commands at that workflow's migration; route removal is part of its exit gate |
| export to xlsx, setup, test-login, tracker clean/compact, schema/catalog/search codegen | native CLI/maintenance work items attached to 1b/1d/1g/1i as appropriate; behavioral CLI fixtures and help output required before alias removal |
| one-off debug/dev helpers (for example Kronos debug and dashboard dev components) | port only if a named supported diagnostic remains; otherwise retire with zero-consumer search plus accepted replacement/evidence |
| general `utils`/infra helpers | no bulk copy; each consumer-driven port maps to domain/infra/store ownership, and the capability guard blocks an orphan at final deletion |

At every workflow cutover, the migration commit updates affected capability entries and proves no
remaining legacy path imports a removed source. Before deleting `src`, the guard requires: zero
`proxy`, zero undecided/missing entries, every `retired` entry has evidence, every native/replaced
target resolves, every old route/service/script/component path is covered exactly once, and the
final operator CLI/help and dashboard navigation inventories match the accepted replacement set.

---

## 4. Coexistence / migration mechanics

Old `src` and new `temp_src` run **side by side** throughout Phase 3 (charter: old system keeps
working). Three mechanisms make that safe; the compat layer is deleted at the end.

- **Lift adapter (doc 03 §5 / D12).** One-direction, one-place, version-keyed decoder from the old terminal contract
  (`tracked-workflow.ts` outcomes — `done`/`failed`-with-step/`skipped`/`interrupted`/`superseded`/
  the `<step>:failed:<err>` pseudo-step) into the new span model. It quarantines invalid shapes,
  never throws; it reads the visible-entries
  layer (deletion tombstones respected). Every supported legacy wire version has real/golden fixtures
  asserting **zero quarantines**; source changes require version bump+adapter+fixtures in one commit.
- **Scoped dashboard flip (doc 03 §5.4 / D13).** The flip is **not wholesale** (review 03 sized that
  at ~103 endpoints / ~122 components — an unacceptable pre-Phase-2 mega-milestone). The **parity
  gate covers only queue rows + log panel + session cards + wfCounts.** Legacy workflow-modifier
  writes, settings, mobile capture, and AI-assist **proxy to the old
  endpoints** only until their explicit §3.6 milestones. The new read-only Workflow Explorer is native in Phase 1 because it is a pure
  descriptor/task/UI/scenario projection; the safe constrained editor subset becomes native after
  its Phase-2 compiler/diff/apply proof. A
  **one-week legacy-SPA fallback** stays after the flip but reads a compatibility API from the
  unified projection, so native runs remain visible. **OCR's review/approve mutation
  routes are the one exception to the proxied long tail:** they are not proxied but migrate native
  *with* the OCR workflow at order 3–4 (§3.3), so the completion union + approval gates run against
  the native review UI rather than the old `/api/ocr/approve-batch`.
- **The parity gate.** For the scoped surfaces, the new server's projections must match the old
  dashboard's **golden payloads** byte-for-relevant-field (D13 golden-payload parity test). This gate
  is first met in **Phase 2** (person-lookup) and re-checked as each workflow migrates.
- **Source authority (doc 03 §5.3).** Authority is immutable per run via engine+generation. One
  workflow may have native generation-N+1 runs while its enumerated generation-N legacy drain set
  finishes; one run may never have two authorities.
- **In-flight drain.** Cutover rejects new legacy enqueues and records existing legacy run ids.
  They complete visibly on legacy without blocking native starts. A hand migration is exceptional,
  typed, fingerprint-validated, and audited—not a prerequisite for cutover.
- **Compat-layer deletion.** After the LAST workflow migrates **and** D58 final-delete mode reports
  zero proxies/undecided capabilities, the lift adapter, golden-payload parity harness, legacy-
  dashboard fallback, and old `src` tree are deleted together—the program's definition of done (§6).

---

## 5. Risk register (top sequencing risks)

| # | Risk | Why it bites | Mitigation |
|---|---|---|---|
| 1 | **A contract flaw surfaces late** | read-only proof would miss transaction failures | Phase 2 has separate read and controlled transaction proofs, including crash/outbox/dedupe evidence |
| 2 | **The dashboard-flip parity milestone slips** (scope creep back to wholesale) | 103 endpoints/122 components is a mega-milestone that could swallow the schedule | D13 keeps the flip **scoped** (4 surfaces); everything else proxies; the parity gate is a concrete golden-payload test, not "looks right"; the one-week fallback de-risks the cutover |
| 3 | **Dual-maintenance or legacy-wire drift** during Phase 3 | Old + new coexist; a selector fixed in one tree can rot the other, or an active-production tracker change can mis-lift | The canonical driver registry maps to the live legacy selector authority without copying during coexistence (UCPath uses a guarded pure re-export; other stores choose move vs re-export by churn), while tasks depend only on stable semantic ids. Legacy wire schemas are versioned with per-version adapters/goldens; each system window is explicit and ends at its last consumer |
| 4 | **A target can make settlement unknowable** (write-safety residual) | UI-only systems may expose neither an idempotent API nor a trustworthy immediate negative read after a click; early absence can be eventual-consistency lag, and a positive match can still be for the wrong subject | D48/D64/D69/doc 09: permanent key fence; fresh binding proof; typed positive proof; every counted negative observation must occur after the target-specific propagation window and repeated authoritative checks must agree; unsettled/ambiguous evidence parks; per-probe live verification at migration. The guarantee is at most one unattended commit attempt per intent generation plus verified convergence—not unconditional distributed exactly-once |
| 5 | **Build context + operator-attention limits** | The program is long (16 workflow directories across 10 migration orders, plus shared capability closure); high WIP and oversized sessions cause ownership drift | One-at-a-time Phase 3, coherent local commits, explicit handoffs/checkpoints when needed, Phase-2 gates before scale, machine inventories/guards so review concentrates on live evidence |
| 6 | **Canonical UI registry becomes a second stale selector list** | Drivers change selectors but forget ids/catalog/scenarios, or aliases multiply | registry is driver authority, generated catalog only, same-system dependency guard, selector verification metadata, alias uniqueness/supersession, migration scenario before removal |
| 7 | **Authority backup exists but has never been restored** | Corruption is discovered during a real run and the “backup” is unusable | Phase-1 automated corruption/restore drill and recurring doctor/backup-health surface; degraded mode blocks mutations instead of creating an empty DB |
| 8 | **Evidence volume recreates an unreadable log pile** | screenshots/notes/bundles consume disk and hide the decisive facts | structured failure/receipt index, confidence and required-evidence rules, on-demand bundles, 7d notes/30d spans, content-addressed dedupe, explicit missing capture, disk warnings/redaction |
| 9 | **Constrained editor expands into unsafe code generation or dual graph authority** | a UI edit changes bind/selector/proof semantics without review, or handwritten and DSL graphs diverge | per-workflow source-vs-DSL authoring mode is exclusive; closed editable union, deterministic codegen, compile+scenario+diff+version+restart-gated atomic apply/rollback; prohibited fields generate a code-change brief, with no arbitrary TypeScript/selector/proof edits |
| 10 | **All workflows migrate but a shared old capability is forgotten** | capture, AI assist, exports, settings, maintenance, or a special route remains an undeclared dependency and blocks/degrades final deletion | D58 machine-readable capability inventory covers old services/routes/UI/CLI/tools exactly once; proxies have removal milestones; final-delete mode rejects proxy/undecided/unproven retirement entries |

### 5.1 Program stop-loss / abort gate

The migration is reversible until the old `src` is deleted (§6). Rather than sink cost into a base
that is not holding, the program has **objective STOP-AND-REASSESS triggers**. Hitting any one
freezes migration — no new workflow flips — and the reassessment happens before proceeding:

- **(a) Parity gate fails twice.** The Phase-2 (or any per-workflow) golden-payload parity gate
  fails, is fixed, and fails again — the read spine is not actually stable.
- **(b) A base contract needs a breaking change after 2+ migrations.** The task/span/write contract
  has to change shape once ≥2 workflows already depend on it — the "coupled by contract" thesis is
  not holding and the churn will compound downstream.
- **(c) The coexistence window blows its budget.** Old+new dual-maintenance (§4) runs longer than the
  operator's pre-set calendar budget — drift risk (risk #3) now outweighs the migration's remaining
  value.

**Defined fallback when a trigger fires:** freeze the migration in place, keep **old `src`
authoritative** (it never stopped working — charter), and reassess scope/contract before any further
flip. The lift adapter + one-week fallback (§4) mean a freeze strands nothing.

The first two thresholds above are fixed. The coexistence calendar budget defaults to **60 days from
the first native workflow cutover**; the operator may deliberately change it during plan approval,
but omission no longer leaves the stop-loss undefined.

---

## 6. Definition of done (whole program)

The rebuild is complete when **all** hold:

1. **Every workflow migrated** (§3.3 orders 0–9) and **live-verified** by a submit-free dry-run
   against every real system it touches; every commit/probe/verification path also has the controlled
   live evidence required by its migration exit gate.
2. **Old `src` deleted** — no per-system legacy code remains; every system's dual-maintenance window
   is closed, and the D58 capability inventory has zero proxy/undecided entries with every old
   workflow/service/route/dashboard/CLI/tool path covered exactly once.
3. **Compat layer gone** — the lift adapter (D12), the golden-payload parity harness, and the
   one-week legacy-dashboard fallback are removed; the dashboard serves entirely from the new
   descriptor + span contract (all surfaces flipped, not just the scoped four).
4. **All guards green with no inherited debt** — guard inventory shows every applicable guard
   covering `temp_src`; `lint:rebuild`, `lint:rebuild-tests`, ordinary source lint, full
   `lint:tests`, typecheck, and tests pass; D70's legacy-test diagnostic manifest has reached zero
   and is deleted; retired parity guards are gone; graph/transaction/write/outbox/provenance
   fixtures pass; ratchet allowlists hold no new-code entries.
5. **The docs match what is built** — every owning doc updated to as-built (charter: the foundation's
   documentation is part of the foundation), and this master plan's phase table fully checked off.
6. **The immutable ledger is live** — every real commit writes an atomic outbox projected into one
   never-pruned serialized hash chain; DB tail-anchor verification passes, including truncation tests.
7. **Authority is recoverable** — current backup health is green; a restore drill has recovered the
   as-built DB schema while preserving claims/dependencies/checkpoints/commands/write intents/
   outboxes/capture handoffs; projection rebuild and unknown-post-backup handling pass.
8. **Runs are explainable and trustworthy** — every terminal run has a schema-valid evidence receipt
   with honest confidence; every failure has a structured redacted diagnostic bundle; durable
   notifications remain visible when desktop delivery fails; `explain run` needs no tracker-blob
   archaeology.
9. **Workflow knowledge is canonical** — UI ids/catalog, task/workflow results, scenario corpus,
   knowledge records, and fix records have no unresolved duplicates/orphans/stale references. Every
   migrated production bug has a regression scenario and supersedes conflicting lessons.
10. **Authoring tools respect their boundary** — the explorer renders the exact as-built graph and
    source links; constrained edits compile/diff/version/restart/apply/rollback in one declared
    source-authored or DSL-authored mode; code-only selector/schema/subject/proof changes cannot be
    emitted by the editor, and no workflow has dual graph authority.
11. **Local-only scope remains true** — the operator server binds loopback, contains no dormant
    RBAC/LAN mode, and diagnostic/backup/evidence permissions + redaction tests pass; the only remote
    listener is a live-session-scoped mobile-capture ingress whose deny-by-default route tests pass.
