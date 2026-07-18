# 07 — Master Plan: the single phased build order for `temp_src`

Status: **Phase 0 — the consolidated build plan.** This is the ONE plan the charter demands
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
| Task contract (`defineTaskContract`/`defineTask`), contract/impl split (D3), `<system>/<verb-object>` id grammar + closed `SystemId` union (D2), error taxonomy, effect/dry-run mechanics (D6/D7), retry, decoration, stores + service stores (D4), session providers + login signature, `stores/common/` leaf homes | **Doc 01** |
| Workflow builder API (single), descriptor shape, `RunEnvelope`, run-state machine incl. gates/parks (D5), checkpoint/resume + freshness walk (D8), label precedence (D16) | **Doc 02** |
| Span/event wire schema (D10), notes stream, storage layout, SQLite projection role (D14), SSE wire shapes, lift adapter + flip plan (D12/D13), completion (fan-out/approval) union (D11) | **Doc 03** |
| Binding cross-doc reconciliation (D1–D22, both rounds) | **Doc 04** |
| Scheduler/lanes/fairness/backpressure, session pool + page leases, executor process model, speed/sleep-tax contract, page-isolation invariant | **Doc 05** |
| Data-service systems: CSV/PDF extraction + roster matching stores, operator column mapping, Edit Data checkpoint UI | **Doc 06 (written, pending approval)** |
| Cross-cutting gap findings memo (owns nothing — a design input) | **Doc 08** |
| Write-safety contract (`WriteSafety`, `ProbeVerdict`, completion union), kernel five-beat write sequence, `write_intents` fence + recovery probe (D17–D19), immutable ledger (D21) | **Doc 09** |
| Guard/test architecture suite: ratchet port map, the four safety guards, descriptor-coverage crosswalk, guard-of-guards manifest, TDD tiers, stub + live lanes | **Doc 10** |
| The Clock (sole time source), config resolver (env>settings>default), per-run prod/test instance (D6-adjacent), fiscal-year rollover, secrets accessor | **Doc 11** |

### 0.3 Standing rule — each completed phase documents itself

Charter §"One master plan": *the foundation's documentation is part of the foundation.* When a phase
completes, its owning docs are updated to describe **as-built** reality (not just design intent), and
this plan's phase table is checked off. A phase is not "done" until its doc delta is written. New
sub-systems get new docs or amend existing ones; stale prose is corrected, never layered.

---

## 1. Dependency graph of the base

The base/kernel is built along one critical path, with the guard umbrella (doc 10) scaffolded
alongside from the first commit (charter: "same quality umbrella from day one").

```
        ┌─────────────────────────────────────────────────────────────────────┐
        │ GUARD UMBRELLA (doc 10) — scaffolded from commit 1, extended each step │
        │  ported ratchets → temp_src (zero-allowlist new) · guard-manifest ·    │
        │  descriptor-coverage · the 4 safety guards land as their targets exist │
        └─────────────────────────────────────────────────────────────────────┘
              │ enforces ▲ every step below
   11 ────► 01 ────► 02 ────► 03 ────► 05 ────► 09
 clock/    task     descr.   span/    exec     write-
 config/   contract builder  event    kernel   safety
 secrets   + stores + run-    + tracker + pool   + ledger
                    state
```

**Critical path: 11 → 01 → 02 → 03 → 05 → 09.** Justification:

- **11 (clock/config/secrets) is the root.** Every timestamp (spans, checkpoints, trace ids, fence),
  every URL/timeout/fiscal date, and every credential reads through it. Building 01+ on raw
  `new Date()`/`process.env` would require re-threading later; the `clock-single-source` and
  `secrets-single-source` guards must be green from the first `temp_src` file.
- **01 before 02** — the descriptor (02) composes task *contracts* (01, D3's client-safe half); the
  builder's `Steps` type map (D15) is typed against contracts.
- **02 before 03** — the span-path grammar, verdict mappings, gate declarations, and completion
  program all key off doc 02's descriptor + run-state machine; doc 03 consumes them.
- **03 before 05** — the executor emits doc 03's worker/run/task spans + notes; the session pool's
  budgets feed doc 03's executor-card projections.
- **05 before 09** — the write-safety five-beat sequence (probe→fence→submit→capture→commit) is
  driven by the executor; the `write_intents` mutex is load-bearing for the *parallel* kernel (D18).
  09 also needs 02's park state, 03's `ledger/` dir + `write_intents` system-of-record table (D21),
  and 01's mutation primitive. It is therefore last of the base.
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
| **0** | Foundation design complete + operator-approved | doc 06 written+approved; master-plan approved; deferred OQs logged to §b |
| **1** | The base/kernel in `temp_src` under the full guard umbrella | `typecheck:all` + `test` + `test:architecture` green incl. all new guards; write-safety fixtures pinned |
| **2** | person-lookup end-to-end on the new base | live dry-run reads real UCPath+CRM; descriptor-coverage + parity gate green |
| **3+** | Per-workflow migration, one at a time (order §3.3) | each: §b questionnaire answered; live dry-run; old per-system code deleted; docs updated |

---

## 3. Phased plan (detail)

### Phase 0 — foundation design

**Goal.** Every foundational contract is designed, adversarially reviewed, and operator-approved
before any `temp_src` code is built (charter §Process: nothing is built before its design part is
approved).

**Status (2026-07-18).** Docs 01 (task contract), 02 (workflow model), 03 (tracker/dashboard), 04
(reconciliation, both rounds), 05 (execution), 06 (data-intake & Edit Data), 08 (gap audit), 09
(write-safety), 10 (guards), 11 (clock/config/secrets) are all **written and reconciled**. Three
adversarial review rounds are folded into D1–D22.

**What remains (the two operator sign-offs).**
1. **Doc 06 — data-intake & Edit Data.** Written, pending approval. Scope from charter §11
   (first-class `extraction`/`ocr`/`roster` service systems + **operator-defined column mapping** →
   workflow zod input) + §12 (Edit Data over checkpoints — checkpoint state always live-visible +
   editable, schema-validated on save) + gap-audit `08`. It specifies: the column-mapping model
   (source-column-title → canonical field, feeding the zod input), the service-store task shapes
   (already constrained by doc 01 §3.4 / D4), and the Edit-Data tab wired to doc 02's checkpoint
   store (§5.7). **This plan does NOT block on doc 06** — the service *stores* are buildable under
   doc 01 in Phase 1; only the mapping + Edit-Data *UI* wait for doc 06, and they land in the
   dashboard-flip window (§3.5), not on the critical path.
2. **This master plan** — operator approval of the build order itself, plus a decision on the
   deferred operator open questions (below), each of which is otherwise carried into a §b checkpoint.

**Deferred operator OQs (logged, resolved at the named point).** Kuali `save-verify` feasibility &
OnBase `upload-verify`-vs-`unverifiableByPage` (doc 09 OQ1/OQ2 — resolved at oath-upload/onbase/
separations migration); ledger tamper-evidence altitude (09 OQ3 — decided now: lightweight
hash-chain, escalation deferred); per-workflow probe-policy (09 OQ4 / charter §b — per migration);
per-run instance selection trigger (11 §4 — deferred until concurrent mixed targeting is needed);
default lane count + UCPath write-tab widening (05 OQ1/OQ2 — Phase 2 default 4, widening is a live
experiment at separations); checkpoint retention (doc 02 §9 OQ1 — resolved per D14: checkpoints
pruned only on logical-item deletion, never on the 7-day JSONL clock; operator confirms at plan
approval).

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
| 1a | **Guard scaffold first.** `test:architecture` globs `temp_src/**`; `guard-manifest` + `gate-coverage` seeded; ported grep-ratchets extended to `temp_src` with **zero-allowlist for new code**, shrink-only for ported leaves | **Doc 10** §2/§5 | `guard-manifest`, `gate-coverage`, `fail-loud-catch-default`, `nullish-literal-data-fallback`, `wait-for-timeout-allowlist`, `inline-selectors`, `evaluate-named-fn`, `import-cycles`, `control-layering`(matrix), `code-conventions` |
| 1b | **Clock + config + secrets.** `domain/clock.ts` (sole `new Date()` site), `domain/config/{schema,resolve}.ts` (env>settings>default once), `domain/secrets.ts`, fiscal-year `requireAnnualDates` fail-loud | **Doc 11** | `clock-single-source`, `fixed-clock-test-only`, `secrets-single-source`, `no-secret-values-in-logs`, `config-env-map-coverage`, `config-schema-snapshot` |
| 1c | **Task contract + stores.** contract/impl split (D3), closed `SystemId` (D2), error taxonomy, effect/dry-run overloads (D7), `freshness` field (D8), `defineStore`, service stores (D4), `stores/common/` incl. the **mutation primitive** (dry-run throw), auth login task/adapter (D15). Port UCPath/CRM selectors as **re-exports** of `src/systems/*` (D15, kills dual-maintenance drift) | **Doc 01** | example-parse, reachability, bundle-safety, verb↔effect, `KnownTaskId` stringly-dispatch ratchet, `z.record` output ban, auth-boilerplate ban, undeclared-error-code type-test, mutation-primitive dry-run throw |
| 1d | **Descriptor + builder + run-state machine.** ONE builder API, descriptor shape + `ICON_NAMES`, `RunEnvelope` (`dryRun` D6, `instance` scaffold), gates as run-state (D5), checkpoint store + freshness walk (D8) + resume scope (D9), label precedence (D16) | **Doc 02** | `descriptor-coverage` (the one guard retiring the ~5 parity guards), `no-positional-identity`, `fill-submit-pairing`, `dry-run-composition-submit-free` |
| 1e | **Span/event layer + tracker.** span wire schema (D10), notes stream, `spans/`+`notes/`+`ledger/` storage layout, SQLite projection role + `write_intents` system-of-record table (D14/D21), SSE wire shapes, completion union (D11), **lift adapter** (D12) | **Doc 03** | `tracker-row-emission`, `deletion-tombstones`, identity-on-patch throw, undeclared-vocabulary emit-validation, sealed-completion, non-recursive wire type-test, real-tracker-day zero-quarantine replay |
| 1f | **Execution kernel + session pool.** workflow-agnostic executor (ports claim/lease/heartbeat machinery), lanes, session pool + page leases, single-flight login, fairness + budgets, page-isolation invariant, OnBase cross-process lease (D15) | **Doc 05** | page-lease/no-module-`Page`, `newPage(` ratchet, single-flight login, onbase-`exclusive` lease, fan-out-starvation, sleep-budget, executor teardown soak, lane-overlap |
| 1g | **Write-safety + ledger.** `WriteSafety` field + `ProbeVerdict`, five-beat sequence, fence + same-key mutex (D18), recovery probe (D17) + schema-validated backfill (D19), immutable hash-chained ledger (D21), `cli ledger verify` | **Doc 09** | `write-safety-contract` (completion-UNION, not receipt-only, D22), `mutate-routes-through-mutation` (D22), fence-before-click fixture, same-key concurrency fixture, crash-recovery 4-case fixture, ledger-integrity + retention-floor |
| 1h | **Data-service stores** (`extraction`/`ocr`/`roster` contracts+impls, D4). Contract/impl only — mapping UI is doc 06/dashboard | **Doc 01** §3.4 (shapes), **Doc 06** (mapping, later) | reachability, bundle-safety, `example`-parse (service stores allow `sessions: []`) |

**Item 1d begins with a type-inference PROTOTYPE spike — before anything depends on the builder.**
The whole "coupled by contract" thesis rests on the FlowBuilder inferring types across steps without
manual annotation; that is **unverified until a prototype compiles**. So the first sub-task of 1d is a
throwaway spike proving the hard generics actually infer: the **two accumulated generic maps** (step
outputs + declared error codes), **`z.input`/`z.output` threading** (step mappings return `z.input`,
`run` receives `z.output`), **const-tuple `errorCodes`** (the `const` type param that keeps the code
union literal, D15), and the **sealed brands** (`defineFormSpec`/contract brands). Only once the spike
type-checks does the real 1d builder — and the 1e–1h layers that depend on it — get built on top.

**Hard exit criteria (Phase 1).**
- `npm run typecheck:all` (both tsc programs), `npm run test`, `npm run test:architecture` **all
  green**, with every guard in §1a–1g's right column registered in `guard-manifest`'s
  `REGISTERED_GUARDS` and covering `temp_src`.
- The write-safety **fixtures pinned**: fence-before-click, same-key mutex (D18), the four
  crash-recovery cases (D17/D19), ledger hash-chain break detection.
- The `real-tracker-day zero-quarantine` lift replay passes on real `.tracker` days (D12).
- Zero new-code allowlist entries in any extended ratchet (ported leaves shrink-only, argued).
- **No live system involved yet** — the base is unit/fixture-proven; the live proof is Phase 2.

**Program invariant Phase 1 establishes — FREEZE of `src`'s tracker-emit shapes.** For the whole
migration duration, the old `src`'s tracker row/log/session **emit shapes are frozen** (no new legacy
row fields, no shape changes). The lift adapter's **zero-quarantine guarantee (D12)** is only true
against the shapes the lift was written for; a new legacy emit shape mid-program would silently
quarantine (or worse, mis-lift) real rows. Any change that would touch a legacy emit shape must
instead land natively in `temp_src`. **Honesty correction to §4/risk #3:** the **ucpath/crm**
dual-maintenance windows are **program-length, not "short"** — those two systems are touched by
almost every workflow, so their `src` leaves stay alive (as re-exports, D15) until the *last*
consumer migrates at orders 8–9. "Short and explicit" holds for single-consumer systems
(sharepoint, old-kronos, onbase), not for ucpath/crm.

---

### Phase 2 — vertical slice: person-lookup end-to-end (the contract's proof)

**Goal.** One simple, read-only workflow runs **end to end on the new base** and is validated by a
**live dry-run**, BEFORE any bulk migration. This is the proof the contract holds against a real
system; a flaw surfacing here is cheap, a flaw surfacing after ten migrations is not.

**Why person-lookup.** UCPath+CRM **reads only** (no mutate boundary → no write-safety engaged, no
irreversible risk), yet it exercises the whole spine: descriptor → contracts → executor → session
pool (the proven 4-tab shared context) → spans → dashboard projection. Its worked example is already
written in doc 02 §8.

**Work items.** Author `person-lookup` descriptor + its UCPath/CRM read task contracts+impls (port
`person-org-summary` + CRM match leaves, wrapped); wire the scoped dashboard flip (§4) for queue/log/
session/wfCounts; run the live dry-run.

**Dry-run = submit-free composition (charter §a).** person-lookup has no submit task, so "dry-run"
here means the standard live read path with no mutation composed at all — the safety boundary is
structural, not a runtime flag.

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

**What Phase 2 does and does NOT prove.** Phase 2 proves the **read spine + the parity gate only** —
descriptor → contracts → executor → session pool → spans → dashboard projection, against a real read.
It deliberately engages **no gate and no write**, so the write-safety and gate contracts are still
only test-proven at the end of Phase 2. Two live checkpoints are therefore named and pulled forward
so those contracts get a real-system proof as early as the migration order allows, not at order 8:
- **First-gate live checkpoint — order 4** (oath-signature/emergency-contact): the first live exercise
  of the completion union + an approval gate (park/resolve) end to end on the new base.
- **First-write live checkpoint — order 6** (work-study): the first live write-safety proof — fence →
  submit → receipt/save-verify → ledger append, pulled forward onto the smallest single-system write
  (one system, low volume) rather than waiting for the incident-grade write-heavy workflows at
  orders 7–9. A flaw in the write contract surfacing at order 6 is cheap; at order 8 it is not.

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
3. **Safety guards fire** — `fill-submit-pairing`, `dry-run-composition-submit-free`,
   `write-safety-contract`, `mutate-routes-through-mutation`, `no-positional-identity` all green.
4. **Live dry-run** (`tests/live/`, `dryRun=true` = submit tasks not composed) reads the real path
   and asserts excluded submits emit `skipped`.
5. **Quiesce/drain in-flight runs before the flip.** A legacy→native flip is per-workflow but **not
   instantaneous**: any of this workflow's runs still live in the old store (queued / claimed / or
   **parked** — e.g. an oath-upload run awaiting signatures for days) must first be drained. Either
   (a) stop enqueueing new legacy runs and let the in-flight ones **complete on the old path**, or
   (b) **dual-run** old+native until the old store shows zero non-terminal runs for this workflow. A
   long-parked old run is either completed-on-old-path or **hand-migrated into an equivalent native
   checkpoint** — it is never abandoned mid-flip. Only once the workflow's old-store drain is clean
   does source authority (§5.3) flip legacy→migrated.
6. **Delete old code** for any system now fully migrated; update the nearest CLAUDE.md + owning docs.

#### 3.2 Exit criteria (per workflow)

- §b questionnaire answered + recorded in the workflow's migration doc.
- `typecheck:all` + `test` + `test:architecture` green; the workflow's descriptor passes
  `descriptor-coverage`; every mutate task passes `write-safety-contract` (its completion arm +
  probe + probe-policy) and `fill-submit-pairing`.
- **Live dry-run** green against every real system it touches (submit-free).
- Old per-system `src` code deleted once that system has no remaining un-migrated consumer; a
  system's dual-maintenance window is short and explicit (charter).

#### 3.3 Recommended migration order (by risk / complexity / reuse)

Read-only and simple first (populate the read stores, low blast radius); OCR/approval flows next
(exercise the completion union + gates); write-heavy last (the write-safety contract's real test),
with the two **incident** workflows (onboarding duplicate-person, separations wrong-person) dead
last as the highest-stakes proofs.

| Order | Workflow(s) | Class | One-line justification |
|---|---|---|---|
| 0 | **person-lookup** | read | Phase 2 slice — done; proves the spine |
| 1 | **person-match**, **i9-lookup** | read | Pure UCPath reads; reuse person-lookup's store tasks almost wholesale — fastest reuse proof |
| 2 | **crm-doc-download**, **sharepoint-download**, **old-kronos-reports** | read/download | Single-system reads/downloads; stand up crm/sharepoint/old-kronos stores at low risk |
| 3 | **ocr** pipeline workflow (consumes the Phase-1h service stores) | service | No browser, no submit; the `extraction`/`ocr`/`roster` service stores are already built in **Phase 1h** (§3.5) — this order migrates the pipeline *workflow* on top of them, unblocking every OCR/roster-dependent workflow below |
| 4 | **oath-signature**, **emergency-contact** | OCR fan-out + light write | Exercise the completion union (D11) + approval gates (D5) + operation-member fan-out; the write is a bounded UCPath enter/fill |
| 5 | **i9-check** | UCPath-only read + roster append | Operation coordinator + member enqueue + display-only rows, but **no submit** (charter §13 note) — the bridge that exercises fan-out completion without write-safety risk |
| 6 | **work-study**, **kronos-pay-rule** | single write | First real mutate submits — small, isolated (one system each: UCPath / new-kronos); prove the five-beat sequence + receipt/save-verify on a low-volume surface |
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

1. **Real submits** — which task(s) in this workflow are irreversible mutate boundaries? (Each
   becomes an `effect:"mutate"` submit task, split from its fill — charter §a.)
2. **Completion check per submit** — receipt (UCPath/ServiceNow: source of the confirmation/ticket
   number + its schema) | save-verify (Kuali: the read-back task) | upload-verify (OnBase: the
   positive read-back, OR an argued `unverifiableByPage`→always-park)? (Doc 09 §2.)
3. **Double-submit probe policy per submit** — `"always"` (safe, +1 read) or
   `"retries-and-recovery-only"` (faster, narrow first-attempt window)? **Required, no default**
   (doc 09 §5 / D17).
4. **Dry-run split boundary** — confirm which submit tasks are excluded from the dry-run composition
   (the operator curates which submits exist as their own task — charter §a).
5. **Freshness maxAges — justify the *value*, not just its presence.** For each read whose output
   feeds a write, state the chosen `freshness.maxAgeMs` (D8) **and the reason that number is right**
   for this data's staleness risk — the guard only checks the field is *present*, never that the
   value is *correct*, so the operator owns justifying it (a too-large window silently reuses stale
   data into a live write). `Infinity` must be argued in a comment.
6. **Workflow-specific gates/data** — identity-approval gate? OCR approval gate? EID re-match?
   roster column mapping (doc 06)? per-run test/prod instance need (doc 11 §4)?
7. **Reuse map** — which store tasks reused (peer-to-peer), which new, and for each new task: its
   reusable-base design + the workflow-specific customization (charter §3/§8).

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

- **Lift adapter (doc 03 §5 / D12).** One-direction, one-place decoder from the old terminal contract
  (`tracked-workflow.ts` outcomes — `done`/`failed`-with-step/`skipped`/`interrupted`/`superseded`/
  the `<step>:failed:<err>` pseudo-step) into the new span model. It **quarantines** (a loud card),
  **never throws**, on post-cutover legacy rows or invalid archetypes; it reads the visible-entries
  layer (deletion tombstones respected). Pinned by replaying real `.tracker` days asserting **zero
  quarantines** (Phase 1e exit).
- **Scoped dashboard flip (doc 03 §5.4 / D13).** The flip is **not wholesale** (review 03 sized that
  at ~103 endpoints / ~122 components — an unacceptable pre-Phase-2 mega-milestone). The **parity
  gate covers only queue rows + log panel + session cards + wfCounts.** Capture, workflow-modifier,
  settings, AI-assist **proxy to the old endpoints** until their own later migration milestones. A
  **one-week legacy-dashboard fallback** stays after the flip. **OCR's review/approve mutation
  routes are the one exception to the proxied long tail:** they are not proxied but migrate native
  *with* the OCR workflow at order 3–4 (§3.3), so the completion union + approval gates run against
  the native review UI rather than the old `/api/ocr/approve-batch`.
- **The parity gate.** For the scoped surfaces, the new server's projections must match the old
  dashboard's **golden payloads** byte-for-relevant-field (D13 golden-payload parity test). This gate
  is first met in **Phase 2** (person-lookup) and re-checked as each workflow migrates.
- **Source authority (doc 03 §5.3).** A workflow is **legacy XOR migrated** — never both. The lift
  only touches legacy rows; migrated workflows emit native spans. No workflow is half-flipped.
- **In-flight drain at each flip (not instantaneous).** Because a workflow is legacy XOR migrated,
  the flip cannot strand a run mid-flight in the old store. Before flipping a workflow, **quiesce/
  drain** its non-terminal old-store runs (queued / claimed / parked): complete them on the old path
  first, or dual-run old+native until the old store is empty of this workflow's live runs. A
  long-parked old run (e.g. oath-upload awaiting signatures for days) is completed-on-old-path or
  **hand-migrated into a native checkpoint** — never dropped. A per-workflow flip is therefore a
  bounded drain window, not a switch throw (§3.1 step 5).
- **Compat-layer deletion.** When the LAST workflow migrates, the lift adapter, the golden-payload
  parity harness, the legacy-dashboard fallback, and the old `src` tree are deleted together — the
  program's definition of done (§6).

---

## 5. Risk register (top sequencing risks)

| # | Risk | Why it bites | Mitigation |
|---|---|---|---|
| 1 | **A contract flaw surfaces late** (after many migrations) | The base is proven only by tests until Phase 2; a real-system mismatch in the task/span/write contract is expensive to fix at order 8 | Phase 2 is a **mandatory live-dry-run proof before any bulk migration**; the read→OCR→write ordering (§3.3) surfaces contract stress incrementally, cheapest first; every flaw is fixed in the owning doc, not patched locally |
| 2 | **The dashboard-flip parity milestone slips** (scope creep back to wholesale) | 103 endpoints/122 components is a mega-milestone that could swallow the schedule | D13 keeps the flip **scoped** (4 surfaces); everything else proxies; the parity gate is a concrete golden-payload test, not "looks right"; the one-week fallback de-risks the cutover |
| 3 | **Dual-maintenance drift** during Phase 3 (a fix lands in `src` but not `temp_src`, or selectors diverge) | Old + new coexist for the whole migration; a selector fixed in one tree silently rots the other | Selectors ported as **re-exports** of `src/systems/*` (D15) so there is one source until deletion day; per-system windows are **short and explicit**; old code deleted the moment a system is fully migrated (no idle duplicate) |
| 4 | **The probe can still lie** (write-safety residual) | A too-early racy read (duplicate-person root cause) can report `absent` on a still-rendering page — a mechanical guard cannot catch it | Disclosed residual (D20 / doc 09 §11): `ProbeVerdict` fail-closed (`unknown`/`ambiguous`→park), `maxAgeMs:0` always-live probe, stable-key exact match, and **per-probe live verification at migration** (the race-classifiers port into the probe impls); exactly-once = no double-**file**, NOT no wrong-**person** — stated honestly, never overclaimed |
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
4. **All guards green over `temp_src` only** — `guard-manifest` shows every registered guard covering
   `temp_src`; the retired parity guards are gone; the four safety guards + write-safety fixtures
   pass; ratchet allowlists hold no new-code entries.
5. **The docs match what is built** — every owning doc updated to as-built (charter: the foundation's
   documentation is part of the foundation), and this master plan's phase table fully checked off.
6. **The immutable ledger is live** — every real mutation across the migrated workflows writes a
   never-pruned, hash-chained ledger entry (doc 09 §6); `cli ledger verify` passes.
