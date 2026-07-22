# 07 — Master Plan: the single phased build order for `temp_src`

Status: **Phase 0 reset — revised build plan, 2026-07-21. No `temp_src` implementation exists.** This is the ONE plan the charter demands
(§"One master plan"): every design doc converges here, and there must never be a competing plan.

**What this doc is.** It *sequences* and *indexes* the build. It states the order phases run in, the
dependencies between them, and the hard exit criteria for each. For every work item it names the
**owning doc** — the binding detail lives there, and this plan never redefines it.

**What this doc is NOT.** It is not a design doc. It owns no contract. If this plan and an owning doc
disagree on a contract's shape, the owning doc wins and this plan is stale (and must be corrected —
see governance §0.3).

---

## 0. Program overview + governance

### 0.1 The one-plan rule

Per charter §"One master plan": the design docs (01–11) are the binding detail; THIS doc is the
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
| Binding cross-doc reconciliation (D1–D45, including 2026-07-21 Round 4) | **Doc 04** |
| Scheduler/lanes/fairness/backpressure, session pool + page leases, executor process model, speed/sleep-tax contract, page-isolation invariant | **Doc 05** |
| Data-service systems: CSV/PDF extraction + roster matching stores, operator column mapping, Edit Data checkpoint UI | **Doc 06 (written, pending approval)** |
| Cross-cutting gap findings memo (owns nothing — a design input) | **Doc 08** |
| Write-safety contract, permanent-key intents, typed proof, atomic outboxes/recovery, serialized anchored ledger | **Doc 09** |
| Guard/test architecture suite: ratchet port map, safety guards, descriptor-coverage crosswalk, guard-of-guards manifest, TDD tiers, stub + live lanes | **Doc 10** |
| The Clock (sole time source), config resolver (env>settings>default), per-run prod/test instance (D6-adjacent), fiscal-year rollover, secrets accessor | **Doc 11** |

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
  domain + clock/config snapshot
        │
        ▼
  write-safety TYPE SHELL + state/outbox/ledger-head schema
        │                    (owned now; no later forward reference)
        ▼
  task contracts/stores/sessions (read · prepare · commit)
        │
        ▼
  complete typed workflow DAG + descriptor + completion/gate types
        │
        ├────────► core composition-root registry
        │                         │
        ▼                         ▼
  spans/lift/projections ◄── executor/checkpoints/write sequencer
        │                         │
        └────────────┬────────────┘
                     ▼
          dashboard/client projection + intake UI
```

**Critical path: guard → domain/config → write types/storage → task/store → workflow graph →
registry/executor/events → dashboard.** Justification:

- **11 (clock/config/secrets) is the root.** Every timestamp (spans, checkpoints, trace ids, fence),
  every URL/timeout/fiscal date, and every credential reads through it. Building 01+ on raw
  `new Date()`/`process.env` would require re-threading later; the `clock-single-source` and
  `secrets-single-source` guards must be green from the first `temp_src` file.
- **Write-safety types/storage precede commit task contracts.** `CommitTaskContract` cannot refer to
  a later-owned placeholder. The dependency-free `WriteSafety`/proof types and SQLite authority/
  outbox schema land first; sequencing behavior lands with the executor later.
- **01 before 02** — the descriptor (02) composes task contracts; the
  builder's `Steps` type map (D15) is typed against contracts.
- **The 02/03 completion seam lands together in 1e.** Doc 03 owns the bundle-safe completion-program
  union while doc 02 owns the descriptor/gate graph that contains it; both domain types land in the
  same work item. Doc 03's event/storage/projection implementation waits until 1g, so neither side
  forward-declares a later contract.
- **Registry is above workflows.** `core/workflow-registry.ts` imports descriptors/stores; domain
  never imports workflows. The dashboard receives generated/server projections, never workflow modules.
- **Executor and events co-evolve after the graph.** The executor emits events and owns transaction
  sequencing; durable outbox contracts already exist, so neither layer forward-declares the other.
- **10 is orthogonal, not sequential** — it is built alongside every step (guards land as their
  target concepts appear), never "at the end." Its own meta-guard (`guard-manifest`) is what stops
  the umbrella silently shrinking.

The **data-service stores** (doc 06's `extraction`/`ocr`/`roster` contract+impl, D4) are built as
ordinary stores under doc 01's model — slotted at the **end of Phase 1** (they need only 01+11), so
Phase 3 workflows that depend on them find them ready. Their **column-mapping + Edit-Data UI** is a
dashboard concern that lands later (doc 06, when the flip reaches it — §3.5).

---

## 2. Phase table (at a glance)

| Phase | Headline deliverable | Gate to exit |
|---|---|---|
| **0** | Corrected foundation design approved; empty rebuild tree | Round-4 decisions reconciled across 00–11; dependency/type proof spec approved |
| **1** | The base/kernel in `temp_src` under the full guard umbrella | `typecheck:all` + `lint` + `test` + `test:architecture` green incl. all new guards; write-safety fixtures pinned |
| **2** | read slice + transactional safety slice | person-lookup live; page-scoped dry-run and controlled commit/crash recovery/outbox/ledger proof green |
| **3+** | Per-workflow migration, one at a time (order §3.3) | each: §b questionnaire answered; live dry-run + controlled write evidence where applicable; migrated leaves removed or explicitly retained for named legacy consumers; docs updated |

---

## 3. Phased plan (detail)

### Phase 0 — foundation design

**Goal.** Every foundational contract is designed, adversarially reviewed, and operator-approved
before any `temp_src` code is built (charter §Process: nothing is built before its design part is
approved).

**Status (2026-07-21 reset).** Docs 00–11 have been reconciled to external-review Round 4
(D26–D45). The abandoned skeleton and spike are deleted; Phase 1 has not started. This corrected
design now awaits operator approval as one set.

**What remains.**
1. **Doc 06 — data-intake & Edit Data.** Corrected, pending approval with this document set. Scope from charter §11
   (first-class `extraction`/`ocr`/`roster` service systems + **operator-defined column mapping** →
   workflow zod input) + §12 (Edit Data over checkpoints — checkpoint state always live-visible +
   editable, schema-validated on save) + gap-audit `08`. It specifies: the column-mapping model
   (source-column-title → canonical field, feeding the zod input), the service-store task shapes
   (already constrained by doc 01 §3.4 / D4), and the Edit-Data tab wired to doc 02's checkpoint
   store (§5.7). **This plan does NOT block on doc 06** — the service *stores* are buildable under
   doc 01 in Phase 1; only the mapping + Edit-Data *UI* wait for doc 06, and they land in the
   dashboard-flip window (§3.5), not on the critical path.
2. **This revised master plan**—operator approval of the corrected build order and explicit
   acceptance that the system-specific questions below block their named migrations, not Phase 1.

**Deferred decisions (logged, resolved at the named point).** Kuali `save-verify` and OnBase
`upload-verify` vs always-park (doc 09 OQ1/OQ2—before their first migration); per-workflow prewrite
probe policy/elapsed budget and pending-termination sweep modeling (09 OQ4/OQ5—each §b questionnaire); canonical
EID width and roster freshness budget (06 OQ1/OQ3—work-study/roster migration). Checkpoint retention
is otherwise settled by D14—logical-item deletion only, never JSONL age—and needs plan-approval
confirmation. Ledger altitude, config snapshots, four lanes, and context-exclusive transactions are
already settled defaults, not open Phase-1 dependencies.

**Exit criteria.** Doc 06 approved; this plan approved; the deferred-OQ list has an owner+resolution
point each. No `temp_src` code before this gate.

---

### Phase 1 — the base/kernel

**Goal.** Build the dependency graph (§1) as `temp_src`, inside the same tsconfig project + unit
tests + `test:architecture` ratchets extended to cover it (charter non-negotiable: no ungated
parallel tree). The base is proven by tests + fixtures, not by a live workflow (that is Phase 2).

**Ordered work items** (each cites its owning doc; each lands with its guards):

| # | Work item | Owner | Key guards that must be green at this step |
|---|---|---|---|
| 1a | **Pre-tree guard plumbing.** With `temp_src` still absent, first extract shared walk/allowlist helpers as a zero-count-change commit; then add the reviewed inventory format and exact path-exemption tests. Do not add unmatched CLI globs or pretend an absent tree was scanned | **Doc 10** | helper-refactor commit preserves the measured architecture file/test count exactly; later intentional test additions are enumerated; inventory self-validation; nested-`scripts` fixture |
| 1b | **First domain leaf + full coverage activation, atomically.** Add closed ids/base schemas and clock/config/secrets/run-snapshot types; in the same commit activate `temp_src` typecheck, full ESLint config+CLI coverage, whole-tree ratchets, and layer matrix. Each active scan resolves ≥1 file; `--no-error-on-unmatched-pattern` is banned | **Docs 01/10/11** | typecheck/lint/gate coverage; non-vacuity; clock/secrets/config; schema defaults parse from `{}`; resolver return-type tests |
| 1c | **Write-safety type/storage shell.** `ProbeVerdict`, typed proof union, permanent-key intent/attempt tables, durable outbox and ledger-head schemas—dependency-free, before commit contracts refer to them | **Doc 09** | schema/DDL invariants; committed key cannot be reinserted; no untyped proof arm |
| 1d | **Task contracts + stores/sessions.** read/prepare/commit overloads, mutation capability, freshness+provenance metadata, content-addressed artifact writer, store/session providers, context-lifetime exclusivity; selector re-exports | **Doc 01** | effect/capability, contract/impl, example, error-code, store reachability, no-`any`, artifact boundary, OnBase lifetime |
| 1e | **Complete workflow DAG + descriptor.** Real-scale type spike first, then read/transaction/branch/fork-join/child-run/gate nodes, exhaustive descriptor, completion types, fingerprints, checkpoint provenance/migrations | **Docs 02/03 contract seam** | graph type suite at realistic scale; transaction pairing; descriptor projection matrix; no `WorkflowRef<unknown>`; no layer cycles |
| 1f | **Core registry + executor/checkpoints/write sequencer.** Composition-root registry above workflows; claims/lanes; context-exclusive UCPath transactions; separate preflight read lease; permanent-key lookup/prepare/fence/commit/recovery; typed parked-intent resolution; atomic commit outbox | **Docs 02/05/09** | dry-run commit-free plan; probe cannot touch staged page; probe-age/CAS loss cause zero clicks; sequential+concurrent dedupe; crash injection; stale manual action; context-interference and lease-lifetime tests |
| 1g | **Events/tracker/lift/projections + ledger projector.** spans/notes, unified projection, per-run migration authority, client projection API, serialized ledger projector + tail verification, legacy compatibility API | **Docs 03/09** | real-day lift; generation authority; atomic outbox projection; concurrent ledger chain; tail truncation/missing-file detection |
| 1h | **Dashboard/intake foundation.** four parity surfaces, legacy-SPA compatibility API, extraction/ocr/roster stores, generic header selection, duplicate-safe mapping core, Edit Data provenance API, stable-keyed local artifact outbox/projector | **Docs 03/06** | parity payloads; novel/duplicate header fixtures; edit-does-not-refresh facts; workbook retry/concurrent-edit fixtures; headless dashboard verification |

**Item 1e begins with a new real-scale type-inference proof.** The deleted spike covered only two
effects and three linear steps. The replacement must compile a representative 15–25-node graph with
read/prepare/commit, transaction pairing, output-dependent branch, fork/join, typed child runs,
external/children gates, heterogeneous completion stages, decorations, errors, and schema changes
that deliberately fail their consumers. No production builder or skeleton lands until the positive
and negative controls pass under the real toolchain with no `any`/`unknown` target erasure.

**Hard exit criteria (Phase 1).**
- `npm run typecheck:all` (both tsc programs), `npm run lint`, `npm run test`, and
  `npm run test:architecture` **all
  green**, with every guard inventoried and covering `temp_src`.
- Write-safety fixtures pin simultaneous and later sequential same-key dedupe, proof validation for
  every completion arm, crash injection across atomic commit, and ledger projector concurrency/tail loss.
- The `real-tracker-day zero-quarantine` lift replay passes on real `.tracker` days (D12).
- Legacy row/log/session wire schemas have an explicit version, `v0` fixtures for pre-version data,
  and a source-schema guard requiring version bump+adapter+goldens for every later shape change.
- Zero new-code allowlist entries in any extended ratchet (ported leaves shrink-only, argued).
- Every activated guard arm resolves a non-empty file set; ESLint's CLI target and typed config block
  both cover `temp_src`. Missing paths and unmatched patterns are failures, not skips.
- **No live system involved yet** — the base is unit/fixture-proven; the live proof is Phase 2.

**Program invariant Phase 1 establishes—versioned legacy compatibility, not a production freeze.**
The old `src` remains maintainable. Central emitters stamp a row/log/session schema version; old
unstamped data is `v0`; the lift has one checked adapter per supported version. A source-schema
snapshot guard requires any legacy wire change to bump the version and land adapter+golden fixtures
in the same commit. Unknown versions/shapes quarantine visibly and cannot be mis-lifted through a
default arm. **Dual-maintenance honesty:** UCPath/CRM windows are program-length because almost every
workflow consumes them; single-consumer systems should be shorter. All windows are explicit and end
when the final consumer migrates.

---

### Phase 2 — two vertical proofs: read spine and transactional safety

**Goal.** Before any bulk migration, prove both halves the foundation claims: the read/projection
spine and a page-scoped external-write transaction with recovery/durability.

**Why person-lookup.** UCPath+CRM reads only, so it exercises no commit boundary or irreversible
risk, yet it covers the spine: descriptor → contracts → executor → session
pool (the proven 4-tab shared context) → spans → dashboard projection. Its worked example is already
written in doc 02 §8.

**Read work items.** Author `person-lookup` descriptor + UCPath/CRM read tasks (port
`person-org-summary` + CRM match leaves, wrapped); wire the scoped dashboard flip (§4) for queue/log/
session/wfCounts; run the live dry-run.

**Transactional work items.** Choose the smallest controlled test-instance or sacrificial test
record whose prepare and commit paths are real and whose outcome is independently queryable. Build
its transaction pair. First run dry-run and prove staged preview with zero intent/commit. Then, only
under the explicit Phase-2 test protocol, perform one controlled commit, inject process crashes at
the supported seams in repeatable fixtures, and prove permanent-key dedupe, typed recovery proof,
atomic outboxes, serialized ledger projection, and context cleanup. If no safe independently
verifiable target exists, Phase 2 is blocked; write-heavy workflow migration may not begin.

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
  yields one external transaction, one committed intent, one typed transaction-output checkpoint
  plus validated proof, one ledger entry,
  one terminal span; a later fresh same-key run performs no second click.
- Crash/outbox/projector fixtures and context-exclusive UCPath/OnBase lease tests remain green under
  multiple executors.

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
   name the workflow-specific customization (charter §3/§8); write contracts → impls → pure-logic
   unit tests (`fakeCtx`) → descriptor (doc 10 §6 red→green order).
3. **Safety guards fire** — transaction pairing, dry-run commit-free, write safety/capability,
   permanent-key dedupe, provenance, graph target typing, and stable identity all green.
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
7. **Delete old code** for any system now fully migrated; update the nearest CLAUDE.md + owning docs.

#### 3.2 Exit criteria (per workflow)

- §b questionnaire answered + recorded in the workflow's migration doc.
- `typecheck:all` + `lint` + `test` + `test:architecture` green; the workflow's descriptor passes
  `descriptor-coverage`; every commit contract passes `write-safety-contract` (its completion arm +
  probe + probe-policy) and transaction pairing.
- **Live dry-run** green against every real system it touches (submit-free).
- Every commit/probe/verify has controlled live evidence on the configured target; unavailable safe
  evidence blocks cutover rather than converting dry-run success into a write-safety claim.
- Old per-system `src` code deleted once that system has no remaining un-migrated consumer; a
  system's dual-maintenance window is bounded and explicit; shared UCPath/CRM may remain until their
  last consumer, while single-consumer stores should close promptly.

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
| 3 | **ocr** pipeline workflow (consumes the Phase-1h service stores) | service | No browser, no submit; the `extraction`/`ocr`/`roster` service stores are already built in **Phase 1h** (§3.5) — this order migrates the pipeline *workflow* on top of them, unblocking every OCR/roster-dependent workflow below |
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

**Order-6 explicit decision — the EID-width reconciliation.** work-study's §b checklist must
resolve the canonical-field divergence doc 06 §1 flags (open, doc 06 §9): today `work-study`/
`separations` accept a looser EID `/^\d{5,}$/` (verified live) than the canonical
`/^10\d{6}$/`. At order 6 the operator decides — **adopt the canonical `eid` field**, or **declare a
distinct `legacyEid` field with its own schema** — and it is **never** resolved by widening the
canonical field (that would weaken every downstream consumer). Recorded here so the decision can't
slip past the first real-write migration.

#### 3.4 The §b migration questionnaire (reusable template)

Embed in **every** workflow's migration plan doc; answer with the operator BEFORE building
(charter §b). Grounded in docs 09 (write-safety) + 11 (freshness/instance) + 02 (gates).

1. **Real commits** — which actions mutate the external system? For each, define a prepare contract,
   commit contract, one transaction lease scope, and stable idempotency key.
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
   roster column mapping (doc 06)? per-run test/prod instance need (doc 11 §4)?
7. **Reuse map** — which store tasks reused (peer-to-peer), which new, and for each new task: its
   reusable-base design + the workflow-specific customization (charter §3/§8).
8. **Local artifact effects** — does a read download immutable bytes (content-addressed writer), or
   does the workflow update a mutable local file? Mutable targets require a stable-keyed blocking
   outbox projection, idempotent upsert semantics, and concurrent-edit/head-hash policy—not a task
   append.

#### 3.5 Where the data systems slot

- **Service stores** (`extraction`/`ocr`/`roster` contract+impl) — **Phase 1h** (they need only 01+11)
  so they exist before consumers; the **ocr pipeline workflow** migrates at **order 3** (before its
  OCR/roster consumers at orders 4–5, 9).
- **Column mapping + Edit-Data UI** (doc 06) — a **dashboard** concern. It lands **when the scoped
  flip (§4) reaches ingest/checkpoint surfaces** — practically alongside the first spreadsheet-ingest
  migration that needs **operator** column mapping (**work-study, order 6** — doc 06 §8's own worked
  example) and the first parked run that needs Edit Data. Note **i9-check (order 5) does NOT exercise
  operator mapping** — it matches against a fixed code-constant retention roster, not an
  operator-defined column map — so onboarding (order 9) is the next mapping consumer after work-study.
  It is NOT on the base critical path; until it flips, ingest uses the ported path and Edit Data
  proxies to the old endpoint (D13).

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
  gate covers only queue rows + log panel + session cards + wfCounts.** Capture, workflow-modifier,
  settings, AI-assist **proxy to the old endpoints** until their own later migration milestones. A
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
- **Compat-layer deletion.** When the LAST workflow migrates, the lift adapter, the golden-payload
  parity harness, the legacy-dashboard fallback, and the old `src` tree are deleted together — the
  program's definition of done (§6).

---

## 5. Risk register (top sequencing risks)

| # | Risk | Why it bites | Mitigation |
|---|---|---|---|
| 1 | **A contract flaw surfaces late** | read-only proof would miss transaction failures | Phase 2 has separate read and controlled transaction proofs, including crash/outbox/dedupe evidence |
| 2 | **The dashboard-flip parity milestone slips** (scope creep back to wholesale) | 103 endpoints/122 components is a mega-milestone that could swallow the schedule | D13 keeps the flip **scoped** (4 surfaces); everything else proxies; the parity gate is a concrete golden-payload test, not "looks right"; the one-week fallback de-risks the cutover |
| 3 | **Dual-maintenance or legacy-wire drift** during Phase 3 | Old + new coexist; a selector fixed in one tree can rot the other, or an active-production tracker change can mis-lift | Selectors remain **re-exports** of `src/systems/*` (D15) until deletion; legacy wire schemas are versioned and guarded with per-version adapters/goldens; each system window is explicit and ends at its last consumer (UCPath/CRM are honestly program-length) |
| 4 | **The probe can still lie** (write-safety residual) | A too-early racy read (duplicate-person root cause) can report `absent` on a still-rendering page — a mechanical guard cannot catch it | Disclosed residual (D20 / doc 09 §11): `ProbeVerdict` fail-closed (`unknown`/`ambiguous`→park), always-live probe on a separate read lease, required probe-to-fence elapsed budget, stable-key exact match, and **per-probe live verification at migration** (the race-classifiers port into the probe impls); exactly-once = no double-**file**, NOT no wrong-**person** — stated honestly, never overclaimed |
| 5 | **Spend/model + operator-attention limits on the build itself** | The program is long (10 workflows × contract+impl+tests+live); an over-parallel or context-heavy build burns budget and drifts | One-at-a-time Phase 3 (bounded WIP); context-lean orchestration (deep work in subagents returning short summaries, charter §Process); Phase 2 gates before scale; the guard umbrella catches regressions cheaply so review effort concentrates on the live-verify tail |

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

**The operator sets these thresholds** — the twice-count, the "2+ migrations" line, the calendar
budget — **before approving the build order.** They are governance dials, not engineering defaults.

---

## 6. Definition of done (whole program)

The rebuild is complete when **all** hold:

1. **Every workflow migrated** (§3.3 orders 0–9) and **live-verified** by a submit-free dry-run
   against every real system it touches.
2. **Old `src` deleted** — no per-system legacy code remains; every system's dual-maintenance window
   is closed.
3. **Compat layer gone** — the lift adapter (D12), the golden-payload parity harness, and the
   one-week legacy-dashboard fallback are removed; the dashboard serves entirely from the new
   descriptor + span contract (all surfaces flipped, not just the scoped four).
4. **All guards green over `temp_src` only** — guard inventory shows every guard covering
   `temp_src`; retired parity guards are gone; graph/transaction/write/outbox/provenance fixtures
   pass; ratchet allowlists hold no new-code entries.
5. **The docs match what is built** — every owning doc updated to as-built (charter: the foundation's
   documentation is part of the foundation), and this master plan's phase table fully checked off.
6. **The immutable ledger is live** — every real commit writes an atomic outbox projected into one
   never-pruned serialized hash chain; DB tail-anchor verification passes, including truncation tests.
