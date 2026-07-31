# Testing-system plan — coverage policy, test-value standard, and legacy-suite preservation

Status: **RATIFIED 2026-07-31 (D91).** The operator accepted the coverage floors, Phase-2 branch
floors, and soft suite-size budget; legacy erasure was rejected in favor of preservation through
initial cutover and separate later authorization for any retirement. The owning requirements are
folded into docs 07/10; this file retains the full testing rationale and execution detail.

## Ownership header (D1)

| | |
|---|---|
| **This plan OWNS** | The coverage policy (band, denominator, thresholds, gate), the test-value standard (must-test / skip-list / quality rubric / review checklist), suite sizing + anti-bloat discipline, and legacy-suite preservation/future-retirement prerequisites. |
| **Imports (never redefines)** | Guard inventory, ratchet port map, TDD tiers, stub/live lanes, D85 testing standard, scenario corpus — **doc 10**. Phases, 1a legacy lint-debt/change-accounting manifests, D88 isolation, exit criteria — **doc 07**. `example`-derived fixtures — **doc 01**. ScenarioManifest — **doc 12**. Clock injection — **doc 11**. |
| **Operator directive (2026-07-27, amended 2026-07-31)** | Build a better `temp_src` test system at ~60–80% coverage and skip trivial tests so it does not bloat. The earlier idea of erasing current tests after implementation is superseded: preserve them through initial cutover; any later retirement requires separate explicit authorization. |

**One-sentence thesis.** Doc 10 says *which guards and lanes exist*; this plan says *how much
behavior testing is enough (60–80%, measured honestly), which tests are banned as noise, how big
the rebuild suite may get, and how the 479-file legacy suite remains usable without exporting its
debt into new code.*

---

## 1. Why — the problem with the suite we have

Measured 2026-07-27: **479 test files, ~94,760 lines** (`tests/unit` 465-ish across 70+ dirs, plus
`delegation` 7, `integration` 4, `live` 7). Known properties:

- **1,344 legacy lint errors + 2 warnings** in tests (fresh 2026-07-31 baseline) — the suite grew
  faster than its hygiene.
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
  extend to `temp_src` with zero-allowlist; legacy parity guards remain runnable as rollback
  coverage while native `descriptor-coverage` becomes the rebuild authority.
- **Lanes** (§7): derived-stub happy path from `example`, ScenarioManifest corpus for everything
  `example` can't express, opt-in live lane, headless `playwright-cli` dashboard loop.
- From doc 07 1a: legacy tests remain runnable and maintainable behind a
  **diagnostic-fingerprinted no-new-debt lint manifest**; `lint:rebuild-tests` is zero-debt for new
  test roots. Touched legacy files may fix/shrink existing diagnostics but cannot add or change one.

This plan adds the four missing layers on top: **§3 coverage policy, §4 test-value standard,
§5 suite topology + sizing, §6 legacy preservation/future retirement.**

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

Coverage is measured over **`temp_src/**` only** before and after cutover; cutover switches the
normal launcher and does not rename the source root. The point of the exclusion list is that 60–80 stays
an *honest* number over code that unit/scenario lanes can actually execute:

| Excluded from denominator | Why | Its real verification instrument |
|---|---|---|
| `**/*.d.ts`, generated artifacts (UI-CATALOG, editor-generated files, wire projections) | not authored code | generation determinism tests (doc 12) |
| `temp_src/dashboard/**/*.tsx` (presentation components) | no jsdom harness by design | headless `playwright-cli` loop + extracted pure logic (which **stays in** the denominator as `.ts`) |
| driver raw-page internals (the sole allowlisted raw-`Page` area, doc 10 §3.8) | cannot run without a browser | live lane, `semantic-ui-registry` guard, `// verified` discipline |
| process entrypoints (CLI main, daemon boot), `**/index.ts` pure barrels | glue, no branching | typecheck + boot smoke in serial lane |
| `tests/**` themselves, fixtures, scenario manifests | not product code | — |

**Exclusion-creep guard:** the exclusion list lives in exactly one place (the coverage config) and
the guard-of-guards manifest (doc 10 §5) pins its full contents, fail-both-ways. Each exclusion has
an independently owned exact activation root and explicit `planned|active` status: planned requires
both owner and matches absent; active requires the owner and at least one match. The broad `.d.ts`,
raw-page, barrel, and CLI exclusions are intentionally not pre-authorized in Phase 1a because no
independent owning family exists yet; add each only with its concrete owner. Adding a pattern still
requires a reviewed reason. Nobody quietly shrinks the denominator to fake the band.

### 3.4 Thresholds — two tiers

| Scope | Lines / statements / functions | Branches |
|---|---|---|
| Global (`temp_src/**` minus exclusions) | **60** | report-only initially; gate at **50** once Phase 2 exits |
| Safety-critical: `temp_src/core/**`, `stores/common/mutation*`, write sequencer, subject binding, authority store + recovery, the ONE projection | **80** | **70** |

Rationale: the safety-critical set is already driven to high coverage *incidentally* by doc 10's
guard fixtures (crash injection, fence ordering, probe settlement) — the 80 floor just pins that it
stays true. Everything else sits in the band. Branch coverage starts report-only because early
spine code is infra-heavy and branch numbers are noisy at small tree size; the ratified gate turns
on at Phase-2 exit at 50 global / 70 safety-critical without another policy decision.

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
  (EXTEND / RE-DERIVE / RETIRE), the manifest pins the path. `RETIRE` means a guard stops gating
  the rebuild only after separate authorization; it does not delete the preserved legacy test.
- **`tests/live/`** — ports as-is (doc 10 §7), opt-in, never CI, never in coverage.
- Vitest projects: `rebuild-unit` (parallel), `rebuild-scenario` (parallel unless a fixture is
  proven load-sensitive—serialization is per-file opt-in with a reason, not a lane default).
  Legacy `unit`/`serial` projects remain runnable through initial cutover and afterward as rollback
  coverage until a separately authorized retirement (§6).
- `tests/rebuild/*` keeps its name at cutover, matching the permanent `temp_src/` root. The normal
  production launcher changes; the source/test roots do not need a risky rename.

### 5.2 Sizing — the anti-bloat budget

The rebuild avoids reproducing the structural need for most of today's mass: parity tests → descriptor
projections; per-workflow step stubs → derived `example` stubs; scattered regression tests →
indexed scenarios. Expected end-state at full workflow parity:

| Family | Today | Target end-state |
|---|---|---|
| Behavior units (tier 1/2) | ~380 files, ~75k lines | **≤ 150 files, ≤ 25k lines** |
| Architecture guards | 23 files | ~50 files (ratified growth — doc 10 §5.1) |
| Scenario corpus | — (hand-written stubs) | manifests as *data* + one runner |
| delegation/integration | 11 files | absorbed into scenario corpus |
| **Rebuild test code** | legacy suite remains separate | **≈ 200–220 files / ≤ 40k lines** |

Enforcement is **soft, visible, and reviewed** — a hard file-count gate would just be gamed by
concatenation. A tiny `suite-size` report (file count + line count per family, printed with the
coverage summary) makes growth visible in every gate run; each phase-exit review (doc 07) checks
the trend. If behavior units exceed budget at a phase exit, the exit review must name which
SKIP-list rule failed or revise the budget explicitly — silent drift is not an option.

---

## 6. Legacy-suite preservation and separately authorized retirement

### 6.1 The rule

**No legacy test, project, fixture, or harness is deleted during the rebuild or initial cutover.**
The old automation remains production-authoritative while `temp_src` is built, and the complete
legacy suite remains its regression and rollback safety net. A later retirement is a separate
operator decision, never an implied phase-exit cleanup.

Timeline anchored to doc 07:

1. **During the rebuild:** legacy tests may change with production maintenance and may add real
   regressions for legacy behavior. The D90 fingerprint ratchet permits removal of old diagnostics
   but rejects a new/changed diagnostic and requires every touched legacy test file to introduce no
   additional debt. Rebuild tests stay independently zero-debt.
2. **At each migration milestone:** port high-value behavior and fixtures into rebuild scenarios,
   but do not delete their legacy originals. Record coverage in the disposition inventory as
   `ported-and-preserved`, `legacy-only`, or `candidate-for-later-retirement`.
3. **At initial all-at-once cutover:** run both legacy and rebuild suites, preserve all legacy test
   roots/projects, and record the cutover commit as the rollback baseline. The legacy lint manifest
   may remain non-zero; cutover truthfully gates on the no-new-debt ratchet, not a false global
   `lint:tests` claim.
4. **Only after a new explicit operator authorization:** a retirement plan may delete exact named
   paths after capability proof, salvage/port evidence, rollback-window closure, and a recoverable
   backup/tag. Until that authorization, final-delete mode does not exist.

### 6.2 What is preserved

- **All current legacy test roots and Vitest projects** remain runnable through initial cutover.
- **Architecture guards with EXTEND/RE-DERIVE fates** continue protecting both trees where their
  invariants apply. A guard may be replaced for `temp_src` without deleting the legacy guard.
- **`tests/live/`** remains available to the legacy runtime; rebuild live lanes use isolated state,
  sessions, and commands.
- **Fixture assets** (real-shaped PDFs, OCR goldens, JSONL/SQLite corpora) may be copied into the
  rebuild fixture corpus with provenance; originals stay intact.

### 6.3 The porting sweep — one pass per capability, without deletion

As each rebuild capability lands, one reviewed sweep copies or re-expresses the following high-value
evidence. The original test directory remains:

1. **Production-incident regressions** → re-expressed as ScenarioManifests with a FixRecord link
   (the 2026-07-15 terminalization class, 2026-06-17 separations batch, Duo re-arm, modal-mask —
   these are the suite's crown jewels and must be present in both regression worlds).
2. **High-value case tables** → port the *data*, not the harness: name/EID matching corpora,
   address normalization cases, receipt-parser cases, OCR normalization/tier tables, JSONL↔SQLite
   parity cases (the 2026-05-08 lesson class).
3. **Fixture assets** (§6.2).

### 6.4 Porting inventory (bucket level; legacy originals remain)

| Legacy bucket | Files | Rebuild porting focus |
|---|---|---|
| `unit/tracker/**` (~94) | Port reconciliation + terminalization regressions and exporter goldens into Phase 1g/2g scenarios; preserve originals. |
| `unit/dashboard/**` (~68) | Port pure-logic tables; use the rebuild headless loop for rebuilt components; preserve legacy dashboard tests. |
| `unit/core/**` (~53) | Re-express cancel/claim/requeue regressions as executor/command/checkpoint scenarios in Phase 1f; preserve originals. |
| `unit/services/**` (~49) | Highest porting density: OCR/matching/capture/model case tables + goldens feed Phase 2h stores. |
| `unit/workflows/**` (~60) | Port operator-visible regressions into scenarios at each Phase-3 migration; derived stubs replace only the rebuild-side ceremony. |
| `unit/domain/**` (~36) | Much becomes type-guaranteed under strict schemas; genuine logic (presentation resolution, trace-id) ports as tier-1 units. |
| `unit/systems/**` (~31) | Port parser logic and verified semantic cases into the semantic-UI registry + rebuild live lane. |
| `unit/architecture/**` (23) | Preserve; doc 10 §2 governs how corresponding rebuild coverage is extended/re-derived. |
| `unit/{control,utils,infra,scripts}` (~44) | Port load-bearing control/infra behavior into command-service scenarios; SKIP-list material is simply not copied. |
| `delegation/` (7), `integration/` (4) | Re-express the behavior in deterministic rebuild scenarios without removing legacy lanes. |
| `workflows/kronos-pay-rule` (2), stragglers | Record alongside their workflow migration and preserve originals. |

### 6.5 Preservation and future-retirement guard

Extend the `legacy-capability-disposition` mechanism (doc 10 §3.11) with a sibling
**`legacy-test-disposition`** arm: every legacy test directory is classified exactly once as
`preserved`, `ported-and-preserved`, or `candidate-for-later-retirement`, with its rebuild evidence
ids. A new legacy directory fails until classified. During the rebuild and initial cutover the
guard rejects deletion or project removal. A future retirement mode may be introduced only by a
separate operator-ratified decision naming exact paths, capability proof, rollback-window closure,
and backup/recovery evidence; it must reject missing port evidence and any new lint debt.

---

## 7. Tooling changes (concrete)

1. `npm i -D @vitest/coverage-v8`.
2. Vitest config: add `rebuild-unit` + `rebuild-scenario` projects; `coverage` block with the §3.3
   include/exclude and §3.4 thresholds (glob-keyed).
3. Scripts: `test:coverage` (rebuild lanes + coverage gate), `test:rebuild` (rebuild lanes only,
   fast inner loop), suite-size report bolted onto the coverage run.
4. Guard-manifest additions: coverage-script + threshold-floor pin, exclusion-list pin,
   `legacy-test-disposition` arm registration.
5. Ratification fold: doc 10 owns the executable guard/coverage requirements; doc 07 1a owns the
   tooling + lint/change-accounting/disposition seeds and its cutover gate preserves legacy tests.

## 8. Phase mapping

| Phase (doc 07) | This plan's work landing there |
|---|---|
| 1a (pre-tree) | Coverage tooling installed inert; `legacy-test-disposition` inventory seeded; suite-size report script |
| 1b+ (first `temp_src` file) | Coverage gate activates atomically (non-empty include proof); rebuild lanes live; SKIP-list review discipline in force |
| Phase 1 exit | Global floor 60 green over the spine; safety-critical floor 80 green over 1f/1g code |
| Phase 2 exit | Branch gates activate at ratified 50 global / 70 safety-critical; first porting sweeps recorded (core/tracker buckets) |
| Phase 3+, per workflow | Porting sweep recorded; scenario regressions land while legacy originals remain |
| Initial all-at-once cutover | Both suites run; all legacy tests/projects remain as rollback coverage; no rename or deletion |
| Later explicit retirement, if authorized | Exact-path capability/port/rollback/backup proof before any deletion; not part of this rebuild plan |

## 9. Operator decisions — ratified 2026-07-31

1. **Coverage floors accepted:** 60 global and 80 safety-critical for lines, statements, and
   functions.
2. **Branch policy accepted:** report-only through Phase 1; 50 global / 70 safety-critical gates
   activate at Phase-2 exit.
3. **Suite-size policy accepted:** report + phase-exit review, not a hard file-count gate.
4. **Legacy erasure rejected for this program:** preserve legacy source, tests, fixtures, and test
   projects through initial cutover. Any later retirement is a separate explicit operator decision.
