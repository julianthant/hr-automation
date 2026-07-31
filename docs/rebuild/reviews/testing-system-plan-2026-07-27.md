# Testing-system plan — coverage policy, test-value standard, and legacy-suite erasure

Status: **PROPOSAL 2026-07-27, awaiting operator sign-off.** On ratification this folds into
**doc 10** as a Round-9 amendment (new §§10–13) plus two small doc 07 touches (1a work item, final
old-tree-removal checklist). Until then this file is the plan of record for the testing system.

## Ownership header (D1)

| | |
|---|---|
| **This plan OWNS** | The coverage policy (band, denominator, thresholds, gate), the test-value standard (must-test / skip-list / quality rubric / review checklist), suite sizing + anti-bloat discipline, and the legacy-suite disposition + erasure sequence. |
| **Imports (never redefines)** | Guard inventory, ratchet port map, TDD tiers, stub/live lanes, D85 testing standard, scenario corpus — **doc 10**. Phases, 1a legacy lint-debt manifest, D73 frozen tree, exit criteria — **doc 07**. `example`-derived fixtures — **doc 01**. ScenarioManifest — **doc 12**. Clock injection — **doc 11**. |
| **Operator directive (2026-07-27)** | Replace the current test system in the rebuild; aim ~60–80% coverage; skip trivial tests so the suite doesn't bloat; write better tests that pin the behaviors that actually matter; erase the current tests **after** the new system is implemented. |

**One-sentence thesis.** Doc 10 says *which guards and lanes exist*; this plan says *how much
behavior testing is enough (60–80%, measured honestly), which tests are banned as noise, how big
the suite is allowed to get, and exactly when and how the 479-file legacy suite dies.*

---

## 1. Why — the problem with the suite we have

Measured 2026-07-27: **479 test files, ~94,760 lines** (`tests/unit` 465-ish across 70+ dirs, plus
`delegation` 7, `integration` 4, `live` 7). Known properties:

- **1,325 legacy lint errors** in tests (doc 07 baseline) — the suite grew faster than its hygiene.
- A large share are **parity tests for the ~10 parallel registries** the descriptor SSOT retires
  (doc 10 §4) — they test synchronization ceremony, not behavior.
- Many are **implementation-detail tests**: they mock internals and assert the mock was called,
  so they break on refactor and pass on real bugs.
- No coverage measurement exists at all (`@vitest/coverage-v8` is not installed): the suite's size
  is unbounded in both directions — nobody can say what is over-tested or untested.

The rebuild's compiler-first design (strict contracts, closed unions, descriptor projections)
already replaces whole test families with types and guards. What behavior testing remains should be
**small, high-signal, and capped by policy** — that is this plan.

---

## 2. What is already ratified (do not re-plan)

From doc 10, unchanged and imported here:

- **Four TDD tiers** (§6): pure-logic unit with `fakeCtx` → contract/type tests → architecture
  ratchets → stub/live lanes.
- **D85 testing standard** (§3.14): scenario corpus as the everyday lane, structural dry-run
  through the real kernel, `TestTargetRegistry`, positive no-write proof (empty write-intent
  ledger).
- **Guard set + guard-of-guards manifest** (§§2–5): ~50 registered guard files; grep-ratchets
  extend to `temp_src` with zero-allowlist; parity guards retire into `descriptor-coverage`.
- **Lanes** (§7): derived-stub happy path from `example`, ScenarioManifest corpus for everything
  `example` can't express, opt-in live lane, headless `playwright-cli` dashboard loop.
- From doc 07 1a: legacy tests frozen behind the **diagnostic-fingerprinted shrink-only lint
  manifest**; `lint:rebuild-tests` zero-debt for new test roots.

This plan adds the four missing layers on top: **§3 coverage policy, §4 test-value standard,
§5 suite topology + sizing, §6 erasure.**

---

## 3. Coverage policy — the 60–80 band

### 3.1 Semantics: a floor gate and an anti-goal ceiling, not a score

- **60% is a CI floor.** Below it the gate fails.
- **80% is the "stop" line.** Coverage above ~80% earns zero credit in review; a PR whose main
  contribution is pushing an already-green directory toward 100% with low-value tests is
  **rejected**, not merged. The band exists precisely to prevent the bloat the operator flagged.
- Coverage is a **diagnostic** (where is untested decision logic hiding?), never a target to
  optimize. There is **no per-PR diff-coverage mandate** — diff-coverage rules are the single
  biggest generator of trivial tests and are explicitly banned here.

### 3.2 Tooling

- Add `@vitest/coverage-v8` (dev dep).
- `npm run test:coverage` — runs the rebuild unit + scenario lanes with coverage; thresholds live
  in the vitest config `coverage.thresholds` block (glob-keyed).
- Text + lcov reporters; the summary is printed in the gate output so the trend is visible in
  every run without a dashboard.

### 3.3 The denominator — measured over what, honestly

Coverage is measured over **`temp_src/**` only** (after final cutover, the renamed tree — the
config follows the rename in the same commit). The point of the exclusion list is that 60–80 stays
an *honest* number over code that unit/scenario lanes can actually execute:

| Excluded from denominator | Why | Its real verification instrument |
|---|---|---|
| `**/*.d.ts`, generated artifacts (UI-CATALOG, editor-generated files, wire projections) | not authored code | generation determinism tests (doc 12) |
| `temp_src/dashboard/**/*.tsx` (presentation components) | no jsdom harness by design | headless `playwright-cli` loop + extracted pure logic (which **stays in** the denominator as `.ts`) |
| driver raw-page internals (the sole allowlisted raw-`Page` area, doc 10 §3.8) | cannot run without a browser | live lane, `semantic-ui-registry` guard, `// verified` discipline |
| process entrypoints (CLI main, daemon boot), `**/index.ts` pure barrels | glue, no branching | typecheck + boot smoke in serial lane |
| `tests/**` themselves, fixtures, scenario manifests | not product code | — |

**Exclusion-creep guard:** the exclusion list lives in exactly one place (the coverage config) and
the guard-of-guards manifest (doc 10 §5) pins its exact contents, fail-both-ways — adding a new
exclusion pattern requires the same reviewed one-line reason as a ratchet allowlist entry, and a
stale pattern matching nothing fails too. Nobody quietly shrinks the denominator to fake the band.

### 3.4 Thresholds — two tiers

| Scope | Lines / statements / functions | Branches |
|---|---|---|
| Global (`temp_src/**` minus exclusions) | **60** | report-only initially; gate at **50** once Phase 2 exits |
| Safety-critical: `temp_src/core/**`, `stores/common/mutation*`, write sequencer, subject binding, authority store + recovery, the ONE projection | **80** | **70** |

Rationale: the safety-critical set is already driven to high coverage *incidentally* by doc 10's
guard fixtures (crash injection, fence ordering, probe settlement) — the 80 floor just pins that it
stays true. Everything else sits in the band. Branch coverage starts report-only because early
spine code is infra-heavy and branch numbers are noisy at small tree size; gating it is a Phase-2
exit-review decision with data in hand.

### 3.5 Gate mechanics + activation

- The coverage gate joins the standard gate family: `typecheck:all` + `lint` + `test` +
  `test:architecture` + **`test:coverage`**.
- Same atomic-activation discipline as doc 10 ratchets: while `temp_src` is absent the gate is an
  explicit planned no-op; from the first file it must resolve a non-empty file set; a vacuous pass
  (empty include) fails.
- `gate-coverage` (the meta-guard) additionally pins: the script exists, thresholds are **≥ the
  ratified floors** (a silent lowering fails the meta-guard), and the exclusion list matches the
  manifest.

---

## 4. Test-value standard — what to test, what to skip, what "better" means

### 4.1 MUST-test inventory (where the 60–80 comes from)

1. **Pure decision logic in task impls** (tier 1): field mapping, receipt/transaction-number
   parsers, extractors, eligibility/branch decisions — via `run({ input, ctx: fakeCtx })`.
2. **Matching + normalization**: name/EID matching, address normalization, OCR field
   normalization + tier selection, roster re-match. (These carry the wrong-person risk class.)
3. **State machines**: run lifecycle, terminalization/claim fencing, retry authority,
   reconciliation, delegation join/cancel — via scenario fixtures, asserting emitted spans +
   terminal states.
4. **The ONE projection + descriptor projections**: seeded-world fixtures asserting counts, row
   presentation, timeline — by construction (D81).
5. **Boundary schemas with corruption fixtures** (owned by `strict-boundary-schemas`).
6. **Every production bug fix → a regression scenario id in its FixRecord** (D53) — the only
   mandatory *addition* trigger; nothing else obligates a new test file.

### 4.2 SKIP-list — tests that are banned as noise

Writing these is a review reject, regardless of coverage effect:

- **Re-exports, barrels, constant tables, config literals.** The compiler owns them.
- **Pass-through wrappers** (no branching, ≤~3 lines): the callee's test covers it.
- **React render/snapshot tests** — no jsdom harness exists by design; the headless loop is the
  instrument. A `.tsx` unit test is a wrong-tool signal, not a coverage win.
- **Mock-echo tests**: assertions that only restate the test's own mocks ("was called with X"
  where X is the input). If the observable outcome can't be asserted, the seam is wrong.
- **Duplicate-angle tests**: one behavior, one test. A variant earns its file only by pinning a
  *distinct failure mode* (name it in the test name).
- **Ad-hoc type tests** outside the ratified D71 suites — type pinning is centralized so a
  weakened API fails loudly in one place.
- **Ceremony tests for guard-owned invariants**: if a ratchet already proves it structurally
  (e.g. "no inline selectors"), a unit test re-proving it is dead weight.

### 4.3 Quality rubric — what makes the new tests "actually test the things we do"

Every new test must satisfy all of:

1. **Public-seam only.** Contract `run`, descriptor projection, server route, scenario runner,
   command service. Private helpers are never imported by tests — if a helper deserves direct
   testing, extract it to a pure function first (that *is* the tier-1 pattern).
2. **Fails for an operator-visible reason.** The test name states the behavior in operator terms
   ("a lost fence CAS discards staged state with zero clicks"), not the function name.
3. **Fixtures from `example` / ScenarioManifest** (D3) — no hand-rolled parallel fixtures that can
   drift from the contract.
4. **Deterministic**: Clock injected (doc 11), no real sleeps, no wall-clock, no ordering luck.
   (The old suite's delegation-lane contention flake is the anti-pattern being retired.)
5. **Asserts outcomes + emitted events, not call counts** — the sealed mutation primitive is the
   one exception, where the call *is* the externally-visible outcome.
6. **Double-entry ground truth** where feasible (D85): a UI assertion pairs with an independent
   source (projection payload vs rendered row; write proof vs probe read-back).

### 4.4 Review checklist (goes into the PR/commit discipline)

For any commit adding test files: (a) is each new test on the MUST list or a FixRecord regression?
(b) does anything hit the SKIP-list? (c) rubric 1–6 hold? (d) did coverage move *into* the band
rather than past it? A "coverage improved 92%→96%" commit is a smell, not a win.

---

## 5. Suite topology + sizing

### 5.1 Roots and lanes (coexistence and after)

- **`tests/rebuild/unit/`** — tier-1/2 behavior tests (parallel lane). Zero-debt lint
  (`lint:rebuild-tests`, doc 07 1a) from the first file.
- **`tests/rebuild/scenario/`** — the ScenarioManifest corpus + runner (doc 12); deterministic
  fixture drivers; the everyday lane (D85 #1).
- **`tests/unit/architecture/`** — stays where it is; guards follow the doc 10 §2 fate table
  (EXTEND / RE-DERIVE / RETIRE), the manifest pins the path.
- **`tests/live/`** — ports as-is (doc 10 §7), opt-in, never CI, never in coverage.
- Vitest projects: `rebuild-unit` (parallel), `rebuild-scenario` (parallel unless a fixture is
  proven load-sensitive — serialization is per-file opt-in with a reason, not a lane default),
  legacy `unit`/`serial` projects survive untouched until erasure (§6).
- At final cutover (old tree deleted): `tests/rebuild/*` renames to `tests/unit` +
  `tests/scenario`; config and scripts follow in the same commit.

### 5.2 Sizing — the anti-bloat budget

The rebuild deletes the structural need for most of today's mass: parity tests → descriptor
projections; per-workflow step stubs → derived `example` stubs; scattered regression tests →
indexed scenarios. Expected end-state at full workflow parity:

| Family | Today | Target end-state |
|---|---|---|
| Behavior units (tier 1/2) | ~380 files, ~75k lines | **≤ 150 files, ≤ 25k lines** |
| Architecture guards | 23 files | ~50 files (ratified growth — doc 10 §5.1) |
| Scenario corpus | — (hand-written stubs) | manifests as *data* + one runner |
| delegation/integration | 11 files | absorbed into scenario corpus |
| **Total test code** | **479 files / ~95k lines** | **≈ 200–220 files / ≤ 40k lines** |

Enforcement is **soft, visible, and reviewed** — a hard file-count gate would just be gamed by
concatenation. A tiny `suite-size` report (file count + line count per family, printed with the
coverage summary) makes growth visible in every gate run; each phase-exit review (doc 07) checks
the trend. If behavior units exceed budget at a phase exit, the exit review must name which
SKIP-list rule failed or revise the budget explicitly — silent drift is not an option.

---

## 6. Legacy-suite disposition + erasure — "erase after implementation," made exact

### 6.1 The rule

**Legacy tests are deleted *with the subsystem they test*, in the same merge that proves its
replacement — never before, never long after.** "After implementation" is therefore per-subsystem
and mechanical, not one big end-of-program deletion (which would leave 95k dead lines rotting for
months) and not an early deletion (which would drop the only safety net the frozen tree has).

Timeline anchored to doc 07:

1. **Now → src freeze (D73):** legacy tests may still change for *production fixes on `src`* only.
   No new legacy tests otherwise; the D70 fingerprint manifest only shrinks.
2. **At src freeze:** `tests/unit` etc. become read-only + delete-only, same as `src/`
   (the `frozen-legacy-tree` guard's glob extends to the legacy test roots in the freeze commit).
3. **Per migration (Phases 1–3+):** when a workflow/subsystem passes its exit criteria, its mapped
   legacy test directories are deleted in the same merge, after the one-time salvage sweep (§6.3).
   The D70 manifest shrinks correspondingly — deletion is *visible* in the gate.
4. **Final old-tree removal (doc 07):** remaining legacy roots (`tests/unit` remnants,
   `tests/delegation`, `tests/integration`, legacy vitest projects, `tests/_utils`, `setup.ts`
   legacy hooks, log-audit legacy wiring) are deleted; the D70 manifest reaches zero and is itself
   deleted; `lint:tests` becomes mandatory-green (already ratified, doc 07). `tests/rebuild/*`
   renames into place.

### 6.2 What is NOT erased

- **Architecture guards with EXTEND/RE-DERIVE fates** (doc 10 §2) — they are the umbrella, not the
  bloat; only the RETIRE set (parity guards) dies, each in the commit where `descriptor-coverage`
  proves its replacement.
- **`tests/live/`** — ports as-is.
- **Fixture assets with no substitute** (real-shaped PDFs, OCR goldens, JSONL/SQLite corpora) —
  they move into the rebuild fixture corpus during salvage, they don't die with the harness around
  them.

### 6.3 The salvage sweep — one pass per directory, before deletion

Before a legacy test dir is deleted, one reviewed sweep extracts exactly three things (everything
else dies with the directory):

1. **Production-incident regressions** → re-expressed as ScenarioManifests with a FixRecord link
   (the 2026-07-15 terminalization class, 2026-06-17 separations batch, Duo re-arm, modal-mask —
   these are the suite's crown jewels and must not be lost in the deletion).
2. **High-value case tables** → port the *data*, not the harness: name/EID matching corpora,
   address normalization cases, receipt-parser cases, OCR normalization/tier tables, JSONL↔SQLite
   parity cases (the 2026-05-08 lesson class).
3. **Fixture assets** (§6.2).

### 6.4 Disposition inventory (bucket level; per-file happens at each migration)

| Legacy bucket | Files | Fate |
|---|---|---|
| `unit/tracker/**` (~94) | Largest bucket; mostly re-derives against doc 03's span/projection model. Salvage: reconciliation + terminalization regressions, exporter goldens. Deleted with tracker-successor merges (Phase 1g/2g). |
| `unit/dashboard/**` (~68) | Mostly render-adjacent + projection tests. Pure-logic tables salvage; component tests die unreplaced (headless loop is the instrument). Deleted with the dashboard flip. |
| `unit/core/**` (~53) | Re-derived as executor/command/checkpoint scenario fixtures (Phase 1f). Salvage: cancel/claim/requeue regressions. |
| `unit/services/**` (~49) | OCR/matching/capture/llm: highest salvage density (case tables + goldens) → Phase 2h service stores. |
| `unit/workflows/**` (~60) | Step-level tests die (derived stubs replace them); per-workflow regressions → scenarios at each Phase-3 migration order. |
| `unit/domain/**` (~36) | Much becomes type-guaranteed under strict schemas; genuine logic (presentation resolution, trace-id) ports as tier-1 units. |
| `unit/systems/**` (~31) | Selector-adjacent tests retire into the semantic-UI registry + live lane; parser logic salvages. |
| `unit/architecture/**` (23) | **Not erased** — doc 10 §2 fate table governs. |
| `unit/{control,utils,infra,scripts}` (~44) | Control → command-service scenarios; utils mostly SKIP-list material — expect high pure-deletion rate. |
| `delegation/` (7), `integration/` (4) | Absorbed into the scenario corpus (which is deterministic where these were load-flaky). |
| `workflows/kronos-pay-rule` (2), stragglers | Fold into their workflow's migration order. |

### 6.5 Erasure guard

Extend the `legacy-capability-disposition` mechanism (doc 10 §3.11) with a sibling
**`legacy-test-disposition`** arm: every legacy test directory is classified exactly once
({salvage-then-delete | delete | not-erased-per-doc-10}) with its owning migration milestone; a new
legacy test dir fails until classified; **final-delete mode** rejects any surviving legacy test
path, any non-zero D70 manifest, and any salvage item without a landed scenario/fixture id. This is
the mechanical proof that "erase the current tests" actually completed and lost nothing it meant
to keep.

---

## 7. Tooling changes (concrete)

1. `npm i -D @vitest/coverage-v8`.
2. Vitest config: add `rebuild-unit` + `rebuild-scenario` projects; `coverage` block with the §3.3
   include/exclude and §3.4 thresholds (glob-keyed).
3. Scripts: `test:coverage` (rebuild lanes + coverage gate), `test:rebuild` (rebuild lanes only,
   fast inner loop), suite-size report bolted onto the coverage run.
4. Guard-manifest additions: coverage-script + threshold-floor pin, exclusion-list pin,
   `legacy-test-disposition` arm registration.
5. Doc edits on ratification: doc 10 gains §§10–13 (this plan's §§3–6); doc 07 1a gains the
   coverage-tooling install + disposition-inventory seed; doc 07 final-removal checklist gains
   §6.1 step 4.

## 8. Phase mapping

| Phase (doc 07) | This plan's work landing there |
|---|---|
| 1a (pre-tree) | Coverage tooling installed inert; `legacy-test-disposition` inventory seeded; suite-size report script |
| 1b+ (first `temp_src` file) | Coverage gate activates atomically (non-empty include proof); rebuild lanes live; SKIP-list review discipline in force |
| Phase 1 exit | Global floor 60 green over the spine; safety-critical floor 80 green over 1f/1g code |
| Phase 2 exit | Branch-gating decision (report-only → 50?) with real data; first salvage sweeps (core/tracker buckets) |
| Phase 3+, per workflow | Salvage sweep + same-merge deletion of that workflow's legacy tests; scenario regressions land with each migration |
| Final old-tree removal | §6.1 step 4 + final-delete disposition check; `tests/rebuild/*` renames into place |

## 9. Open decisions for the operator

1. **Floor numbers** — proposed 60 global / 80 safety-critical (lines). Accept, or shift?
2. **Branch coverage** — proposed report-only until Phase 2 exit, then gate at 50/70. Accept?
3. **Suite-size budget** — proposed soft (report + phase-exit review), not a hard gate. Accept?
4. **Erasure cadence** — proposed per-subsystem same-merge deletion (§6.1), not one big deletion at
   program end. Accept? (This is the main interpretation choice in "erase after implementation.")
