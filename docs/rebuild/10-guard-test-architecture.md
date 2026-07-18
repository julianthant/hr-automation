# 10 — Guard & Test Architecture SSOT (`temp_src`)

Status: **Phase 0 design — for operator/orchestrator review.** Owns gap-audit (`08`) BLOCKER #2.
Design starting point: `08` §3. This doc goes deeper: the full ratchet port map, the four new
safety guards designed concretely, the descriptor crosswalk that retires the parity guards, the
guard-of-guards manifest, the TDD topology, and the stub/live lanes on the new kernel.

## Ownership header (D1)

| | |
|---|---|
| **This doc OWNS** | The **test/guard architecture suite** for `temp_src`: the ratchet inventory + how each ports/extends/retires, the four NEW safety guards, the descriptor-coverage crosswalk, the guard-of-guards manifest, the TDD tier topology, and the stub + live lanes on the new kernel. |
| **Imports (never redefines)** | Task contract / `effect` / `example` / `fakeCtx` / mutation primitive / dry-run overloads — **doc 01**. Descriptor shape + `descriptor-coverage.test.ts` §1.4 + run-state/checkpoint — **doc 02**. Span/event schema + completion union + lift adapter + dashboard flip — **doc 03**. Pool/lease/sleep-budget guards — **doc 05**. Receipt/idempotency/fence contract — **doc 09** (this doc *hosts* its guards in `tests/unit/architecture/`, doc 09 owns the contract they check). Clock/config/secrets single-source — **doc 11**. |
| **Charter bindings** | "Same quality umbrella from day one" (every ratchet covers `temp_src` from the first line); "fail loud"; §1a fill/submit split is the dry-run safety model this doc makes a static invariant; §5 descriptor SSOT retires the parity guards. |

**One-sentence thesis.** The umbrella is only real if ONE place owns *how* every doc's per-§ guard
promise actually lands in `tests/unit/architecture/`, extends the 23 existing ratchets to
`temp_src`, replaces the ~5 parity guards with one descriptor-coverage guard, and adds the four
safety guards no single doc can own — the dry-run **composition** guard, the fill↔submit **pairing**
guard, the **write-safety-contract** guard (doc 09's — a `completion`-UNION check, *not*
receipt-only), and the **no-positional-identity** guard.

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
code** and shrink-only entries for verbatim-ported leaves.

| Today's guard | Fate | How, under the new kernel |
|---|---|---|
| `fail-loud-catch-default` | **EXTEND** | glob += `temp_src/**`; zero-allowlist for new code. The single most important ratchet — it is what makes doc 09's probe safe (a `catch{return notFound}` on an idempotency probe is banned here). |
| `nullish-literal-data-fallback` | **EXTEND** | glob += `temp_src/{stores,workflows,domain,core,tracker}/**`; zero-allowlist. |
| `wait-for-timeout-allowlist` | **EXTEND** | glob += `temp_src/stores/**`; **zero-allowlist new** (doc 05 §7 #3); shrink-only ported. Doc 05 adds the per-task `sleepMs` budget ratchet beside it. |
| `inline-selectors-workflows` (+ base) | **EXTEND** | now scans `temp_src/stores/*/tasks/**` (impls own selectors) — doc 01 §3.2. |
| `evaluate-named-fn` | **PORT** | glob += `temp_src/stores/**`; unchanged rule (`__name` in `page.evaluate` still throws live). |
| `import-cycles` | **EXTEND** | SCC over `temp_src/`; `ALLOWED_CYCLES` starts empty for the new tree. |
| `control-layering` | **EXTEND → matrix** | absorb gap-audit `08` #9: enforce the full `domain → infra/services/systems → core → control/workflows` direction over `temp_src` (today only the `control` edge is guarded). |
| `code-conventions` | **EXTEND** | same rules over `temp_src` (no default exports, kebab/Pascal filenames, no `.tsx` outside dashboard, console guard). |
| `cancel-mechanism` | **RE-DERIVE** | the one-mechanism invariant re-expressed against doc 05's executor + `runRegistry` successor; still a structural ban on a second cancel path. |
| `delegate-to-usage` / `delegate-to-all-impl-callers` | **RE-DERIVE** | delegation is now workflow-composition (docs 01/02). Re-expressed as "child runs enqueue only via the kernel composition API," but note: peer-to-peer store reuse is now *allowed* (charter §1), so the old "no cross-workflow internal import" shape loosens — see `workflow-boundaries`. |
| `workflow-boundaries` | **RE-DERIVE (loosened)** | charter §1 makes tasks peer-reusable, so importing another workflow's *task contract* is legal. New rule: a workflow may import another's **contracts** and store tasks, never its `descriptor.ts` internals or non-task private helpers. |
| `tracker-row-emission` | **RE-DERIVE** | archetype-stamping is gone; the new invariant is doc 03's: writes go only through the typed span-emit path, `appendFileSync` to event JSONL banned outside `temp_src/tracker/`. |
| `deletion-tombstones` | **PORT** | append-only delete + no `DELETE FROM <audit table>` — reinforced by D14 (SQLite system-of-record) + D12 (lift reads the visible-entries layer). |
| `dashboard-security-boundary` | **PORT** | CORS + auth-middleware-ordering over the new dashboard server; scoped-flip (D13) keeps old + new servers, both must pass. |
| `frontend-tailwind-compliance` | **EXTEND** | over `temp_src/dashboard`. |
| `i9-check-import-guard` | **GENERALIZE** | today: one workflow's import allowlist proves no-mutate. New: any descriptor whose `nodes` contain no `effect:"mutate"` contract is *structurally* search-only — subsumed by the dry-run-composition guard's machinery (§3), applied per-descriptor. |
| `origin-workflow-banned` | **DROP-OR-PORT** | the lineage field it bans does not exist in `temp_src`; keep a banned-term guard only if the concept resurfaces. Decide at Phase 1. |
| `archetype-coverage` | **RETIRE → descriptor** | `descriptor.surface.shape` is the SSOT (§4). |
| `runtime-policy-coverage` | **RETIRE → descriptor** | shape/actions/gates read off the descriptor (§4). |
| `instance-labels-coverage` + `INSTANCE_LABELS` | **RETIRE → descriptor** | label = `descriptor.sessionLabel ?? label` (doc 02 §1.3). |
| `queue-row-kind-coverage` + `SUBJECT_TO_KIND` | **RETIRE → descriptor** | kind derived from `descriptor.inputSubject` inside descriptor-coverage. |
| `gate-coverage` (meta) | **KEEP + EXTEND** | becomes the guard-of-guards manifest (§5): also asserts `test:architecture` still globs `temp_src`, and every named guard file exists + is registered. |
| — | **NEW** | `descriptor-coverage` (§4), `dry-run-composition-submit-free`, `fill-submit-pairing`, `write-safety-contract` (completion-UNION, §3.3), `mutate-routes-through-mutation` (§3.6), `no-positional-identity` (§3), `clock-single-source` (hosted here, owned by doc 11). |

---

## 3. The NEW safety guards (don't exist today, even in spec)

No architecture guard references `dryRun` today; the entire dry-run safety model rests on it. Each
guard below keys off a **closed union** (the contract `effect`, the sealed mutation-primitive
registry, the descriptor node list) — never a text heuristic — so it cannot false-positive on prose.

### 3.1 `dry-run-composition-submit-free.test.ts` — charter §1a as a static invariant

**Thesis: a workflow's dry-run composition provably contains NO reachable submit — the dangerous
action is *absent by construction*, not skipped by a branch.**

For every descriptor: compute the **dry-run composition** (doc 02's node list with submit tasks
excluded — the executor builds this same list from `RunEnvelope.dryRun`, D6). Assert over its
reachable task nodes:
1. no node's contract is `effect:"mutate"` + `dryRun:"unsupported"` (would fail the run loudly at
   runtime anyway — but we prove it can't be *reached* in dry-run), AND
2. no reachable impl imports a `stores/common/mutation.ts` primitive (the sealed set of irreversible
   helpers — doc 01 §6.2). Import-graph walk, not grep for the word "submit".

Backstop already in doc 01 §6.2: the mutation primitive throws if fired while `ctx.dryRun`. This
guard lifts that runtime throw to a **compile-adjacent invariant** — the reason charter §1a is safe.
Live companion: doc 05's e2e dry-run lane asserts `skipped` rows for the excluded submits (§7).

### 3.2 `fill-submit-pairing.test.ts` — a submit is unreachable without its fill

**Thesis: every real submit has a paired fill; you cannot compose a submit whose fill is absent.**

For every `effect:"mutate"` form-filing submit task referenced by a descriptor: assert the same
workflow's node list contains a preceding `effect:"read"` fill task feeding it (bind-graph edge),
OR an allowlisted `{ reason }` for a genuinely atomic write (a single-click filing with no separate
fill — rare, argued once). Generalizes the shape of today's `i9-check-import-guard` (one workflow's
structural proof) to the fill↔submit invariant across all descriptors.

### 3.3 `write-safety-contract.test.ts` — completion-UNION + exactly-once (HOSTS doc 09's guard)

**Thesis (doc 09 owns the contract; this file is where it lands):** every `effect:"mutate"` contract
MUST declare a `writeSafety` whose `completion` satisfies doc 09's **UNION** — `receipt |
save-verify | upload-verify` (D22) — plus an `idempotency.probe` resolving to a real `effect:"read"`
task in the *same* store, or carry an allowlisted `{ reason }` (a genuinely idempotent write, argued).
**The guard walks the union; it does NOT demand a flat `receipt` schema of every mutate contract:**

- `receipt` (UCPath / ServiceNow) — a **non-empty** `schema` (one that parses `{}`/`null`/`undefined`
  ⇒ fail) plus a `pick`. Unit-pinned: a mutate `run` returning `submitted:true` with a receipt
  failing its schema throws.
- `save-verify` (Kuali) / `upload-verify` (OnBase) — a `verify` TaskId resolving to a real
  `effect:"read"` task in the same store whose output is (or extends) `ProbeVerdict`. **These satisfy
  the guard WITHOUT any confirmation number** — Kuali/OnBase have no machine receipt (charter §13);
  demanding a `receipt` of them would be a guard bug (a type-level test pins that). They still can't
  pass without *earning* a post-submit read-back that doesn't exist today — so the guard forces doc
  09's one genuine addition rather than waving them through.
- `upload-verify` carrying **`unverifiableByPage`** — legal ONLY with an allowlist + `{ reason }`
  entry (§3.5); the submit then always-parks, never auto-`done`.

The crash-recovery fixture injects `write.attempting`-without-`write.committed` and asserts: the probe
re-runs FIRST (probe-then-park, D17); a `present` receipt is schema-validated before backfill (D19);
and two same-key runs cannot both fence (D18, via the `write_intents` in-flight consult + the
partial-unique index). Mechanism mirrors the `Record<file,{count,reason}>` ratchet shape.

### 3.4 `no-positional-identity.test.ts` — items/checkpoints keyed by stable id, never index

**Thesis (the docs-1/2 invariant): identity is a stable key, never an array position.** A row keyed
by index silently binds the wrong person when the list reorders — the class of the real wrong-person
incident. Guard: ban `members[<int>]` / `items[<int>]` / `checkpoints[<int>]`-style positional lookups
as a row/checkpoint **identity** in `temp_src/{core,workflows,stores,tracker}/**` (iteration is fine;
using the index as the persisted key is not). Structurally reinforces doc 02's `(workflow, item_id)`
logical key (D9) and doc 03's `(runId, attempt, spanPath)` span identity (D10) — both are id-keyed.

### 3.5 `unverifiableByPage` requires an allowlist + reason (D22 — closes the verify escape hatch)

Doc 09's `upload-verify.unverifiableByPage` is the one place a mutate contract may declare "this page
genuinely cannot prove landing" and fall to always-park. Left unguarded it is a silent escape from
proof-of-landing (review 09 #5). Ratchet: any `completion` carrying `unverifiableByPage` MUST have a
matching `Record<contractId, { reason }>` allowlist entry — the **same discipline as the idempotency
`{ genuinelyIdempotent }` allowlist** (§3.3) and the grep-ratchet allowlists (§1), fail-both-ways: a
new `unverifiableByPage` with no argued entry fails, and a stale entry whose contract dropped the
flag fails the reverse. "We can't verify this write" becomes a reviewed, enumerated decision, never a
quiet default — today only OnBase is a candidate, and it must earn its line.

### 3.6 `mutate-routes-through-mutation.ts` (D22 — closes the fence-bypass overclaim)

Doc 09's fence-before-click is only "unbypassable" if every real submit actually goes through the
sealed `stores/common/mutation.ts` primitive, where the fence + dry-run preconditions live. Nothing
structural asserted that (review 09 #6) — a leaf could fire a raw `page.click` on a Save button and
skip the fence. Ratchet: **every `effect:"mutate"` impl in `temp_src/stores/**` must import/route its
transaction click through `stores/common/mutation.ts`** — an import-graph check over each mutate
task's `run`, not a grep for "submit". A mutate impl reaching a `page.click`/`page.press`-class submit
that does NOT pass through the mutation primitive fails. This complements the inline-`page.` ban (§2):
the ban keeps clicks inside `stores/*`; this ratchet keeps mutate *submits* inside the one fenced
choke point — together they make doc 09's "fence-before-click is unbypassable" a structural fact.

---

## 4. `descriptor-coverage.test.ts` — the ONE guard that replaces the parity guards

Owned by **doc 02 §1.4**; this doc owns the **crosswalk** (which old guards it retires) and the
**exhaustiveness argument**. A single table-driven test over `DESCRIPTORS` (the one client-safe list,
doc 02 §1.2). It is exhaustive because **every projection a component or daemon consumes is derived
from the descriptor, and the guard walks the whole projection set** — a descriptor that fails to
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
| `verdicts` | `queue-row-status-index` + `statusExtensions` | plain-data verdict map read from descriptor (doc 03) |
| `completion` targets | OCR approve branching | targets typecheck vs target descriptors' `input` (#5) |
| e2e **stub happy path** | e2e stub map | walk `nodes`, emit each contract's `example` (schema-parsed) — §6 |
| runtimePolicy actions | `runtime-policy-coverage` | actions/gates read off descriptor (retires parity) |

Plus two guarantees in the same file: **bundle-safety** — descriptor modules value-import only `zod`
+ `temp_src/domain/**` (import-graph walk, #6, keeps them client-safe forever); and a **new-hand-list
ratchet** — any object literal in `temp_src/` (outside `descriptor.ts`/`workflow-registry.ts`) whose
keys include ≥3 known workflow ids fails with "derive it from DESCRIPTORS instead." That ratchet is
what stops a *new* parity guard ever being needed again.

---

## 5. The guard-of-guards manifest — the ratchet set can't silently shrink

Rot vector: a guard file is deleted, renamed, or dropped from the `test:architecture` glob, and
nobody notices the umbrella shrank. Extends the existing `gate-coverage` meta-guard.

`tests/unit/architecture/guard-manifest.test.ts` holds `REGISTERED_GUARDS` — the authoritative
name-set of every guard file that must exist. The test asserts:
1. every name in `REGISTERED_GUARDS` maps to a real file under `tests/unit/architecture/`;
2. every `*.test.ts` file present is *in* `REGISTERED_GUARDS` (no unregistered guard — forces a
   conscious add, and forces this doc's inventory to stay honest);
3. `test:architecture` in `package.json` still globs the directory (a rename can't orphan the suite);
4. the `temp_src`-scoped ratchets (the extend-set in §2) each still include a `temp_src` glob token —
   so nobody can quietly narrow a ratchet back to `src/` only during the dual-maintenance window;
5. `gate-coverage`'s existing assertions (both `tsc` programs, `--max-warnings 0`) are kept inline.

This is the same discipline as `gate-coverage`: the doc doesn't *list* guards in prose as the source
of truth — a **test** is. If this doc and the manifest disagree, the manifest wins and the doc is
stale (and CI stays green regardless — the manifest is the real guarantee).

### 5.1 The full registered set — where every doc's guards converge

`REGISTERED_GUARDS` is the one place the whole umbrella is enumerated. Each doc *owns* its guards'
contracts; the manifest owns that they exist and stay wired. The set (contract-owner in parens):

- **Ported/extended ratchets (this doc, §2):** `fail-loud-catch-default`, `nullish-literal-data-fallback`,
  `wait-for-timeout-allowlist`, `inline-selectors-workflows` (+ systems base), `evaluate-named-fn`,
  `import-cycles`, `control-layering` (+ layer matrix), `code-conventions`, `cancel-mechanism`,
  `delegate-to-usage`, `delegate-to-all-impl-callers`, `workflow-boundaries`, `tracker-row-emission`,
  `deletion-tombstones`, `dashboard-security-boundary`, `frontend-tailwind-compliance`.
- **New safety guards (this doc §3; contract in 09 for write-safety):** `dry-run-composition-submit-free`,
  `fill-submit-pairing`, `write-safety-contract` (09 — the `completion`-UNION check + the
  `unverifiableByPage` allowlist, §3.3/§3.5), `mutate-routes-through-mutation` (09 fence-routing, §3.6),
  `no-positional-identity`.
- **Descriptor SSOT (doc 02):** `descriptor-coverage` — replaces `archetype-coverage`,
  `runtime-policy-coverage`, `instance-labels-coverage`, `queue-row-kind-coverage`, `i9-check-import-guard`.
- **Task-store guards (doc 01):** pairing, reachability, bundle-safety, `example`-parse, freshness,
  verb↔effect, `KnownTaskId` stringly-dispatch ratchet, `z.record` output ban, auth-boilerplate ban,
  UCPath-selectors pure-re-export, undeclared-error-code type-test, mutation-primitive dry-run throw.
- **Event/dashboard guards (doc 03):** dashboard-component purity (no `workflow ===`), client
  re-projection import-boundary, identity-on-patch throw, undeclared-vocabulary emit-validation,
  sealed-completion (`defineFormSpec`, + oath-upload & verify pinned to NO `CompletionProgram`),
  lift-adapter deletion ratchet, notes-not-a-data-channel, non-recursive wire type-test,
  real-tracker-day zero-quarantine replay fixture, D13 golden-payload parity gate.
- **Parallelism guards (doc 05):** page-lease/no-module-`Page`, per-contract sleep budget, single-flight
  login, onbase-`exclusive` lease, `newPage(` ratchet, fan-out-starvation, pool-size `// verified` config,
  executor teardown soak, lane-overlap.
- **Meta (this doc):** `gate-coverage` + `guard-manifest` itself.

A guard added to any doc that never lands in `REGISTERED_GUARDS` fails the manifest — so a doc's §guards
promise cannot quietly stay a promise.

---

## 6. TDD topology for `temp_src` — four tiers, each an owned home

"Same quality umbrella, made concrete." A new task or workflow is built **test-first** against these:

1. **Pure-logic unit** — `task.impl.run({ input, ctx: fakeCtx })`. Doc 01 §7B makes every task run a
   plain-object call; the `fakeCtx` contract (a `TaskCtx` with fake `page`/`recordData`/`dryRun`) is
   the unit seam. "Pure logic extracted and unit-tested" = the impl's decision logic is a pure
   function the run composes, tested with a fake ctx and no browser — the *primary* hardening tier
   (charter #2: types first, then this).
2. **Contract / type** — every contract's mandatory `example` parses through its own `output` schema
   (doc 01 guard #4); type-level tests pin that undeclared `errorCodes` fail `tsc` (D15), a mutate
   contract missing a `receipt` fails the write-safety guard, and a `read` ctx has no `dryRun` member
   (so a mis-declared read can't branch on dry-run — doc 01 §2.3). **Fixtures come from `example`**
   (D3): the mandatory canonical output is the single reusable fixture — stubs, unit tests, and the
   dashboard preview all consume it, so it can't drift.
3. **Architecture ratchets** — §2's ported grep-ratchets + §3–§5's new guards, each glob covering
   `temp_src/**` with a zero-allowlist for new code and shrink-only for ported leaves.
4. **E2e stub lane + live lane** — §7.

Write order for a new task (red→green): write the contract (`example` fails to parse → red) → write
the impl `run` typed against the contract → pure-logic unit test with `fakeCtx` (red → green) →
register in the store index (reachability guard green) → add the node to a descriptor
(descriptor-coverage green) → if it mutates, add `receipt`+`probe` (write-safety green) and its fill
pair (pairing green).

---

## 7. Stub + live lanes on the new kernel

**Stub lane (`HRAUTO_E2E_STUBS=1`).** Today `maybeWrapE2EStub` clones a `RegisteredWorkflow`, sets
`systems: []`, and walks the real step list with a hand-written `StepDataFn` per workflow
(`stub-workflows.ts`), honoring file-based **hold gates** (park a run mid-step) and one-shot **fail
gates** (`E2EScriptedFailError` → terminal `failed` + Retry). Migration:

- **Happy path becomes derived** (D3): the executor runs each descriptor's `nodes`, and each task's
  stub output is its contract's `example` (schema-parsed) instead of a hand-written `StepDataFn`. The
  hand-maintained per-workflow scripts disappear — the stub map is a descriptor projection
  (descriptor-coverage #(stub) covers it), so it can't drift from the real steps.
- **What `example` CANNOT express stays hand-scripted** (review 02 #12): failure injection, cancel,
  and parallel-overlap scenarios are *behaviors over time*, not output values. They keep the
  file-based hold/fail-gate mechanism (`e2e-gates/`) — the driver arms a gate, the executor honors
  it. Doc 05 §7 #1 adds a **lane-overlap** scenario here: two held runs of different workflows must
  be simultaneously `running` on one executor, asserted on span timestamps (`maxConcurrentLanes ≥ 2`).
- **Span-emitting workflows**: the stub daemon emits the same span/note events (doc 03) a real run
  would, so the dashboard parity gate (D13) and lift-free new-server projections are exercised
  without a browser. `oath-upload`-style real-handler-with-stubbed-legs cases port as test seams.

**Live lane (`tests/live/`, opt-in, never CI).** Ports as-is: real Chromium, real UCSD SSO, Duo
cleared hands-off by the enrolled WebAuthn credential (charter §9 — no phone step). Its safety
boundary is unchanged and is now *structural*: **`dryRun=true` = the submit task is not in the
composition** (§3.1), so a live dry-run reads the real path and proves the excluded submits emit
`skipped`, with no possibility of an irreversible write — the write-safety contract (doc 09) only
ever engages on a real submit, which a dry-run composition doesn't contain. The dashboard headless
`playwright-cli` verification loop (root CLAUDE.md "Verifying dashboard changes") is unchanged: seed
a synthetic tracker dir → boot the real new-server dashboard → drive + assert on the a11y snapshot.

---

## 8. Adversarial self-review — how the guard set rots, and the meta-guard for each

| # | Rot vector | Meta-guard |
|---|---|---|
| 1 | **Allowlists grow unchecked** — every failure "fixed" by an allowlist add | Each entry needs a one-line `reason` (ported discipline); the fail-both-ways ratchet fails on a *stale over-count* too, so a shrunk violation forces the entry down; periodic review is a lesson, not a guard — honest residual risk, mitigated by zero-allowlist for *new* `temp_src` code. |
| 2 | **A guard is deleted or dropped from the glob** | The guard-of-guards manifest (§5) — a missing/unregistered file, or a `test:architecture` glob that stops covering the dir, fails. |
| 3 | **A ratchet quietly narrows back to `src/` only** during dual-maintenance | Manifest check #4: the extend-set must keep a `temp_src` glob token. |
| 4 | **`temp_src` escapes coverage** — new code lands untouched by any ratchet | The fail-loud/nullish/wait-for-timeout globs include `temp_src/**` with zero-allowlist; a new file with a banned pattern fails on first commit. |
| 5 | **A new parity/hand-list registry reappears** | descriptor-coverage's ≥3-workflow-id-keys ratchet (§4) fails it with a pointed message. |
| 6 | **The composition/pairing guard false-positives on prose** and gets weakened | Both key off closed unions (contract `effect`, sealed mutation-primitive registry, descriptor nodes) — no text heuristic to weaken; a genuinely-atomic write uses the `{ reason }` escape, not a guard edit. |
| 7 | **This doc becomes a stale prose index** | §5's manifest is the SSOT, not this doc; they can disagree and CI still enforces the manifest. |
| 8 | **Meta-risk: three new safety docs (09/10/11) drift** | Each is a D1-owned contract doc the master plan (07) *references*, never redefines; this doc imports their contracts and only hosts their guards. |
| 9 | **The write-safety guard regresses to demanding a flat `receipt`** (would wrongly reject Kuali/OnBase) | §3.3 walks doc 09's `completion` UNION (`receipt\|save-verify\|upload-verify`, D22): save-verify/upload-verify pass with a `ProbeVerdict` read-back and NO confirmation number; a type-level test pins that demanding `receipt` of a save-verify contract is itself a guard bug. The `unverifiableByPage` allowlist (§3.5) and the mutation-primitive fence-routing ratchet (§3.6) each fail-both-ways, so the verify escape hatch and the fence bypass can't quietly re-open. |

---

## 9. Worked example — adding one new submit-bearing workflow

Scenario: a new `badge-reissue` workflow that fills and submits a UCPath form. Red→green, and what
must be registered:

1. **Contracts.** Write `ucpath/fill-badge-reissue` (`effect:"read"`) and `ucpath/submit-badge-reissue`
   (`effect:"mutate"`). RED: `write-safety-contract` fails — the mutate contract has no `receipt`/
   `idempotency.probe`. Add `receipt` (the `T…` transaction number, ported from
   `readLatestTransactionNumber`) + `probe: "ucpath/find-existing-badge-reissue"`. RED: the
   `example` guard fails until each contract's `example` parses. GREEN.
2. **Impls + unit.** Write both `run`s in `stores/ucpath/tasks/`; the submit fires through
   `stores/common/mutation.ts`. Pure-logic unit tests with `fakeCtx` for the fill's field-mapping and
   the submit's receipt-parse (red→green). Reachability guard: both must be in the store index.
3. **Descriptor.** Add `badge-reissue` descriptor with nodes `[fill, submit]`, `code`, `icon`,
   `inputSubject`, run surfaces. RED: `descriptor-coverage` fails until id/code unique, icon ∈
   ICON_NAMES, systems union resolves. GREEN.
4. **Safety guards fire.** `fill-submit-pairing`: GREEN (submit has its preceding fill). `dry-run-
   composition-submit-free`: the dry-run composition = `[fill]` (submit excluded), no mutation
   primitive reachable → GREEN; had someone marked the submit `dryRun:"unsupported"` and left it in
   the dry-run list, RED. `mutate-routes-through-mutation` (§3.6): GREEN because the submit fires
   through `stores/common/mutation.ts`; a raw `page.click` on Save would go RED. `write-safety-contract`:
   GREEN — the `receipt` completion arm is satisfied (a UCPath `T…` receipt); a Kuali form here would
   instead pass via the `save-verify` arm with no confirmation number (§3.3). `no-positional-identity`:
   GREEN as long as members key on EID, not index.
5. **Register.** `SERVER_REGISTRY[badge-reissue]` (key-parity with DESCRIPTORS). Stub happy path is
   derived from the `example`s automatically; add a hand-scripted fail/cancel gate scenario only if
   the e2e matrix needs one. No `INSTANCE_LABELS`/`SUBJECT_TO_KIND`/icon-map edits — those lists no
   longer exist. **Guard-manifest**: unchanged (no new guard *file*), but if this workflow needed a
   bespoke guard, it must be added to `REGISTERED_GUARDS` or the manifest test fails.
6. **Live proof.** A live dry-run (`tests/live/`) reads the real fill path and asserts the submit
   emits `skipped`; the double-submit probe policy is decided at the §b migration checkpoint.

Net: the four safety guards + descriptor-coverage do the work the ~10 synchronized hand-edits and ~5
parity guards used to — one contract change, and the compiler + ratchets force the rest.
