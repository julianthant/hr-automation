# Handoff — EXTERNAL REVIEW of the whole `temp_src` rebuild plan

**Date:** 2026-07-21
**Audience:** an external reviewer (Codex) with **no prior context** on this program.
**Mode:** this is a **review brief, not a resume-work brief.** Nothing here asks you to build. We want
the plan attacked before we spend another quarter executing it.
**Paused at:** Phase 1, Step **1a** (guard scaffold), slice **1a-1 in flight and uncommitted** — see
"Current state". Phase 0 (design) is complete and committed.

---

## 0. Review ground rules (please respect these)

- **Read-only.** Do not edit files, do not commit, do not push, do not run the build or tests in a way
  that mutates state. `git status` / `grep` / reading files is what's wanted.
- **There is uncommitted work in the tree right now** (an in-flight build slice — see §3). Do not
  revert, stash, clean, or "tidy" it. Do not touch the untracked `.rebuild-spike/` directory; it is
  deliberately untracked and deliberately retained (§5).
- **Do not create `AGENTS.md`** (or `agents.md` / `agent.md`) anywhere in this repo. Project rule:
  documentation goes in the directory's `CLAUDE.md`. An `AGENTS.md` is invisible to the tooling that
  actually reads this repo, so it is treated as noise, not documentation.
- **Deliverable:** a written review. Findings ranked by severity, each with a `file:line` citation and
  a concrete failure scenario ("if X, then Y silently happens"). Prose confidence is not evidence —
  if a claim in our docs is unverified, say it is unverified.
- We would rather hear "this load-bearing assumption is unproven" than a list of typos.

---

## 1. What is being rebuilt, and why (the motivation — read this before the docs)

`hr-automation` is a **single-operator Playwright tool that files REAL HR transactions** at UCSD —
UCPath (HR system of record), Kuali, Kronos, ServiceNow, OnBase, I-9. Onboarding, separations,
work-study, oath signatures, OCR review. Wrong data here is not a failed test; it is a real person
mis-hired, mis-paid, or mis-terminated.

We are rebuilding `src/` into a new parallel tree `temp_src/`, then migrating **one workflow at a
time** over multiple quarters. The old `src/` keeps running the whole time. **This is explicitly not a
big-bang rewrite.**

### The two independent motivations

**(a) Structural — coupled by convention, not by contract.** From a 2026-07-17 survey:

- **~10 parallel hand-maintained workflow registries** (`WORKFLOW_LOADERS`, `INPUT_RUN_REGISTRY`,
  `RUN_MODAL_REGISTRY`, `INSTANCE_LABELS`, the e2e stub map, icon maps, …). Adding or renaming one
  workflow means ~10 synchronized hand edits. **Only two of the ten have a coverage guard.** A typo
  compiles fine and fails at runtime.
- **A bundle-boundary fault line.** Workflow definitions import Playwright, so they can never ship to
  the browser — which forced display metadata to be *re-declared by hand* client-side (step-label
  string switches, icon maps, label maps). Rename a step; the UI silently renders stale text.
- **Cross-spec reach-in.** `onbase-emergency-contact.ts:82` reaches into another spec's internals
  (`emergencyContactOcrFormSpec.approveTo!.canFanOut`).
- Root cause: independent lists sharing string names. **Nothing forces the second edit when you make
  the first.**

**(b) Safety — a live fail-open write hazard, with real incidents.** Two production incidents:
a **duplicate person created**, and a **wrong-person termination** (`T002173685`). Today there is no
transactional layer: no exactly-once fence, no receipt verification, no probe-then-park recovery. A
crash mid-submit leaves an unknown state that the system may treat as done.

### The thesis the whole rebuild rests on

Replace convention-coupling with **contract-coupling**: small typed tasks (zod in/out) in per-system
*and* per-workflow stores, composed into workflows; **one descriptor as the single source of truth**
that every UI surface is a projection of; a fenced fail-closed write layer; one clock/config/secrets
source; and guards that defend the foundation. The load-bearing claim is:

> **Rename a field on one side, and the other side fails to compile.**

---

## 2. The document set to review (`docs/rebuild/`, ~6,000 lines)

Phase 0 produced these. They went through three internal review rounds plus a final high-effort
review ("sound with fixes", all fixes applied). **They have never been read by anyone outside this
program.** That is what we want from you.

| Doc | Lines | Owns |
|---|---|---|
| `00-charter.md` | 157 | Vision + non-negotiables. **Read first.** |
| `01-task-contract.md` | 925 | Task contract/impl split, `effect` (read/mutate), error taxonomy, `example` fixtures, `defineStore`, the sealed mutation primitive |
| `02-workflow-model.md` | 758 | Descriptor SSOT, the FlowBuilder, `RunEnvelope`/dry-run, gates as run-state, checkpoints + resume |
| `03-tracker-dashboard.md` | 783 | Span/event schema, notes stream, storage layout, SQLite projection, SSE wire shapes, the legacy "lift" adapter |
| `04-reconciliation.md` | 221 | **The binding cross-doc decision register, D1–D25.** Where conflicts between docs were settled |
| `05-execution-parallelism.md` | 452 | Executor, lanes, session pool, page leases, fairness/budgets |
| `06-data-intake-and-edit-data.md` | 480 | Operator-defined column mapping, Edit-Data-over-checkpoints |
| `07-master-plan.md` | 455 | **THE binding build order.** Phases 0→3+, migration order, risk register, stop-loss |
| `08-foundation-gap-audit.md` | 387 | Adversarial audit of docs 00–05 that found the missing write-safety layer |
| `09-write-safety.md` | 587 | Exactly-once: five-beat sequence, `write_intents` fence/mutex, probe-then-park recovery, hash-chained ledger |
| `10-guard-test-architecture.md` | 370 | **Owns the step in flight (1a).** Ratchet port map, 4 new safety guards, guard-of-guards manifest, TDD topology |
| `11-clock-config-secrets.md` | 426 | Single-source clock, config precedence, secrets |
| `reviews/{01,02,03,09}-review.md` | — | Prior internal review rounds — useful to see what was already challenged |

**Suggested reading order for review:** `00` → `07` → `04` → then whichever of 01/02/09/10 you intend
to attack deepest. `04` matters more than its length suggests: it is where doc-vs-doc conflicts were
resolved, so a decision that looks arbitrary in one doc usually has its argument there.

---

## 3. Current state (honest)

- **Branch:** `master`. **Worktrees:** none but the main checkout.
- **Phase 0 (design): COMPLETE**, committed through `923f50c0`.
- **Phase 1 Step 0 (FlowBuilder type-inference spike): COMPLETE, PASSED.** See §4.
- **Phase 1 Step 1a slice 1a-1: IN FLIGHT, UNCOMMITTED.** As of this writing `git status` shows
  modified `tsconfig.json`, `package.json`, `eslint.config.js`,
  `tests/unit/architecture/gate-coverage.test.ts`, and an untracked `temp_src/`. **No `temp_src` code
  exists beyond an empty layer skeleton.** Nothing of the actual kernel is built yet.
- **Untracked and intentionally kept:** `.rebuild-spike/` (§5).
- **Remote anomaly, unresolved:** `origin/master` has advanced externally more than once with no push
  from this program. **Standing rule: never push to `origin/master` without explicit operator
  instruction.** Do not push anything.

### Baseline gates (measured this session, on `923f50c0`, before the in-flight slice)

| Gate | Result |
|---|---|
| `npm run test:architecture` | PASS — 23 guard files, 137 tests, ~4.5s |
| `npm run typecheck:all` | PASS — ~9s |

---

## 4. What Step 0 settled — and the exact limit of what it proves

The whole thesis ("rename a field, the other side fails to compile") rested on **unverified prose**
about TypeScript generic inference through the FlowBuilder. Before building anything on it, we
compiled a throwaway spike (`.rebuild-spike/`) under the real toolchain — **TS 5.9.3, zod 4.4.3,
`strict` + `verbatimModuleSyntax`** — asserting 7 load-bearing inference properties.

**Result: PASSED, zero errors, and non-vacuous by construction** — four `@ts-expect-error` controls
each suppress a real error (TypeScript itself errors on an *unused* `@ts-expect-error`), and the
positive assertions use an `any`-proof `Equal<>` helper.

It required three shape refinements, now ratified as **D23–D25** in `04-reconciliation.md`
§"Reconciliation round 3":
- **D23** — per-effect `defineTaskContract` overloads returning `SealedRead`/`SealedMutateContract`.
- **D24** — `StepEntry<C, Cond>`.
- **D25** — a **correction**: doc 02 had left an ambiguity that would have silently poisoned
  inference; `.step` is now single-signature with `HasWhen<O>`, **no overloads**.

**What it does NOT prove — please treat this as an open question, not a settled one:** the spike is a
*type-level* proof on a small synthetic surface. It does not prove the inference survives at real
workflow scale (dozens of steps, deep zod schemas), nor that error messages stay legible when it
fails, nor the D25 residual below.

---

## 5. `.rebuild-spike/` — why it still exists

Untracked throwaway spike (`spike.ts` + `tsconfig.json`). It sits outside every tsconfig include,
lint glob, and guard root — which is technically the exact "ungated parallel tree" the charter
forbids (`00-charter.md:118-119`). We consciously accepted this: it is untracked (so it is not "in
the codebase"), and at **Step 1d** its 7-property assertion battery gets **promoted into a real
`temp_src` type-level test**, after which the directory is deleted. Its conclusions are already
ratified as D23–D25, so nothing is lost if it disappears early.

**Do not commit it, do not delete it, do not `git add -A`** (that would sweep it in).

---

## 6. What we most want challenged (ranked — but do not feel bound by this list)

1. **Is the "compile-time coupling" thesis actually load-bearing at scale?** Step 0 proved 7
   properties on a synthetic surface. Does the design hold when a workflow has 20 steps and nested
   zod objects? Where does inference realistically collapse into `any` or an unreadable error?
2. **Write-safety (doc 09) — is exactly-once actually achieved, or only mostly?** The five-beat
   sequence, the `write_intents` fence + same-key mutex (D18), probe-then-park recovery (D17),
   schema-validated backfill (D19), the hash-chained ledger (D21). **We already know and accept one
   residual: "probe-can-lie" — exactly-once closes double-*filing*, but NOT the wrong-*person* racy
   read, which is the class the real `T002173685` incident belongs to.** The identity-approval gate
   that would close *that* is deliberately unbuilt and undesigned. Attack whether there are residuals
   we have *not* named.
3. **Is the descriptor genuinely exhaustive?** `10-guard-test-architecture.md` §4 claims one
   `descriptor-coverage` guard can retire ~5 parity guards because "every projection a component or
   daemon consumes is derived from the descriptor." Is that projection table complete, or is there a
   surface that will inevitably need a *new* hand-maintained list — reintroducing the exact problem
   the rebuild exists to kill?
4. **Is the phased order in `07-master-plan.md` §Phase 1 actually a valid dependency order?**
   1a→1h with the critical path 11 → 01 → 02 → 03 → 05 → 09. Is there a cycle, or a step that
   silently needs a later step's output?
5. **Migration realism.** `07` §3.3 sets the workflow migration order (incident-bearing workflows
   last). `07` lines 188–198 declare a program-length **FREEZE on the old `src`'s tracker-emit
   shapes**, because the lift adapter's zero-quarantine guarantee (D12) only holds against shapes it
   was written for. **Is a multi-quarter freeze on a system in active production use realistic?** If
   it breaks, what silently mis-lifts?
6. **The guard architecture (doc 10) — does it defend what it claims?** §8 self-lists 9 rot vectors.
   Which vector is under-defended? Specifically: allowlists that grow unchecked are mitigated only by
   "a lesson, not a guard" (§8 #1, an admitted residual).
7. **Scope.** Multi-quarter rebuild, single operator, production system running throughout. Is the
   phasing wrong? Is there a materially cheaper path to the same two goals (kill the 10 registries,
   close the write hazard) that we talked ourselves out of?

---

## 7. Residuals we already know about — don't spend effort rediscovering these

Flag them if you think we've *mis-sized* the risk, but they are known:

- **probe-can-lie** — exactly-once closes double-filing, not the wrong-person racy read (see §6.2).
- **The identity-approval gate** — the real `T002173685` defense — needs its own design, not yet
  written, required before separations (migration order 8).
- **Multi-tab WRITE parallelism is unproven.**
- **Kuali save-verify / OnBase upload-verify feasibility** is unresolved until migration orders 7–8;
  neither system emits a machine receipt, so both rely on an earned post-submit read-back that does
  not exist today.
- **D25 residual (open):** does `probePolicy`-required-on-mutate compile under the single-signature
  `.step`? Planned fallback if not: enforce at the factory + a runtime `descriptor-coverage` guard.
  Not blocking steps 1a–1c.
- **`ucpath` / `crm` dual-maintenance is program-length, not short** — those two systems are touched
  by nearly every workflow, so their `src` leaves survive as re-exports until the last consumer
  migrates. `07` was corrected to say this honestly.
- **Deferred by operator directive to per-workflow migration time** (`00-charter.md` §b
  questionnaire): double-submit probe policy per submit, which actions count as real submits,
  receipt/completion check per submit, dry-run split boundary, freshness `maxAgeMs` values. These are
  *intentionally* unanswered in the plan.

---

## 8. Decisions taken this session (Step 1a) — also in scope for review

Three were put to the operator in plain language and approved:

1. **Lock the `temp_src` layer layout now, hard-fail on unknown top-level directories.** The layer
   guard enforces `rank(target) <= rank(importer)`; a new unrecognized top-level folder fails the
   build with "add it to the layer map with a reason." Rejected alternative: start permissive.
2. **Extract a shared guard helper first, as an isolated zero-scope-change commit,** before widening
   any guard to `temp_src`. Rationale: 7 guards each carry a near-identical private `walk()` and 4
   carry a near-identical allowlist checker; extending in place would grow that to ~15 copies.
   Safety property: the refactor commit must leave the test count *identical* and change **zero
   characters** in any existing `src` allowlist.
3. **Keep `.rebuild-spike/` untracked until Step 1d,** then promote its assertions and delete it.

Two further calls made by the orchestrator (please review these as deviations):

4. **Deviation from doc 10 §2, unratified:** doc 10 scopes the `nullish-literal-data-fallback` ratchet
   to `temp_src/{stores,workflows,domain,core,tracker}/**`. That five-folder subset **omits half the
   directories the other design docs assume exist** (`base/`, `exec/`, `events/`, `server/`,
   `intake/`, `forms/`). Widened to the whole tree minus `dashboard/`. **This needs ratifying as a
   new decision (D26?) — it currently contradicts doc 10 as written.**
5. **Non-vacuity mechanism changed.** Doc 10 §8 #4 names "temp_src escapes coverage" as a rot vector
   but closes it only with a glob-token text check. Strengthened: **each `temp_src` guard arm asserts
   the file list it scanned is non-empty** before checking violations, so a guard pointed at nothing
   goes red naming itself rather than passing forever.

### Four traps found in the real code that the design docs missed

These were discovered by reading the guard suite, not the docs — worth knowing they were *not*
anticipated by doc 10:

- **The 8 walk-based guards ENOENT-crash on a missing `temp_src`** — they do not skip it. Any branch
  or checkout without the directory turns the entire architecture suite red. This makes the skeleton
  a hard ordering constraint, not a preference.
- **`eslint` exits 2 on an empty or unmatched pattern** (verified). The obvious fix
  (`--no-error-on-unmatched-pattern`) is the wrong one — it makes "lint silently covered nothing"
  green forever.
- **`eslint.config.js` scopes the project's real rules to `src/**` only.** Adding `temp_src` to the
  lint *command* without widening the *config* yields a tree that looks linted but gets only base
  presets — no unused-import rule, no Node globals, no type-aware tuning. **Doc 10 never mentions
  eslint at all.**
- **`code-conventions.test.ts:78` matches allowlist entries with `path.includes(prefix)`**, and
  `"/scripts/"` is in that list — which already pre-grants console-logging exemption to any future
  `temp_src/**/scripts/**`.

---

## 9. Verification — confirm the tree matches this brief before reviewing

```bash
git status                                   # expect: 4 modified files + untracked temp_src/ + .rebuild-spike/
git log --oneline -1                         # expect 923f50c0 docs(rebuild): ratify Step-0 spike decisions D23-D25...
ls docs/rebuild/                             # expect 00-11 + reviews/
grep -n "Round 3" docs/rebuild/04-reconciliation.md   # confirm D23-D25 present

# Baseline gates (read-only; safe to run):
npm run test:architecture                    # expect 23 files / 137 tests PASS (pre-slice baseline)
npm run typecheck:all                        # expect PASS

# Re-prove the Step-0 spike compiles (the whole thesis):
npx tsc -p .rebuild-spike/tsconfig.json && echo "SPIKE GREEN"
```

> Note: the in-flight slice may make `test:architecture` report a slightly higher test count (new
> assertions were being added to `gate-coverage`). The **file count must stay 23** at this stage. If
> either gate is RED, the slice was interrupted mid-edit — report that rather than fixing it.

---

## 10. Pointers

- **Project instructions:** `/Users/julianhein/Projects/hr-automation/CLAUDE.md` — read the
  **"Fail loud — no unverified silent fallbacks"** section in particular. It is the single most
  load-bearing convention in the repo and the reason several design choices look paranoid.
- **Subsystem instructions:** `src/systems/<system>/CLAUDE.md`, `src/workflows/<workflow>/CLAUDE.md`,
  `src/core/CLAUDE.md`, `src/dashboard/CLAUDE.md`, `src/tracker/CLAUDE.md`.
- **Conventions:** `docs/engineering/codebase-conventions.md`. **Doc map:** `docs/README.md`
  (distinguishes canonical from historical/ephemeral docs).
- **Prior handoffs (context on how we got here):**
  `docs/superpowers/handoffs/2026-07-18-rebuild-phase1-kernel.md`,
  `docs/superpowers/handoffs/2026-07-20-rebuild-phase1-1a-guards.md`.
- **Existing guard suite** (what `temp_src` inherits): `tests/unit/architecture/` — 23 files.
- **Toolchain (locked):** TS 5.9.3, zod 4.4.3 (v4 API). Root `tsconfig.json`: `target ES2024`,
  `module ESNext`, `moduleResolution bundler`, `strict`, `verbatimModuleSyntax`, `skipLibCheck`.

---

## 11. Working style (context for why the plan reads the way it does)

The operator is a **lean orchestrator**: deep work happens in high-effort subagents that return short
summaries; the orchestrator reviews adversarially and explains each part to the operator in **plain,
non-technical language** (old way → why it hurt → how the new way fixes it) and gets **part-by-part
sign-off before building**. Nothing in `temp_src` is built before its design part is operator-
approved (`00-charter.md:157`). If a design doc reads as over-explained, that is deliberate — it was
written to be reviewable by a non-specialist as well as a compiler.
