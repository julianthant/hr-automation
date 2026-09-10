# Handoff — temp_src rebuild, Phase 1 build (resume at 1a: guard scaffold)

**Date:** 2026-07-20
**Paused at:** End of Phase 1 **Step 0** — the FlowBuilder type-inference spike is **complete and PASSED**, and its three resulting decisions (**D23–D25**) are ratified into docs 01/02/04 and committed (`923f50c0`). No `temp_src/` code exists yet. **Resume at 1a (guard scaffold).**

## Task summary

We are **rebuilding** the HR-automation codebase into a new `temp_src/` tree on a **task-store architecture**, then migrating the old `src/` in one workflow at a time. Motivation: today's build is coupled *by convention* — one workflow's identity is forked across ~10 hand-maintained lists that drift silently — plus a live fail-open write hazard (a real duplicate person, and a wrong-person termination `T002173685`). The rebuild couples *by contract*: small typed tasks (zod in/out) in per-system **and** per-workflow stores, composed into workflows; one descriptor as the single source of truth; fenced fail-closed write-safety (exactly-once); one clock/config/secrets; guards that defend the foundation. **Multi-quarter, one-workflow-at-a-time — not a big-bang rewrite.** Old `src/` keeps running throughout.

**What Step 0 just settled (the de-risk that gated everything):** the whole thesis — "rename a field on one side, the other side fails to compile" — rested on unverified prose about TypeScript generic inference across the FlowBuilder. A throwaway spike (`.rebuild-spike/`) **compiled it under the real toolchain** (TS 5.9.3 + zod 4.4.3, strict + verbatimModuleSyntax) and proved all 7 load-bearing properties, **zero errors, non-vacuous** (see verification below). The thesis HOLDS. It required three minimal, now-ratified shape refinements (D23–D25) — one of which (D25) is a *correction* of an ambiguity doc 02 had left open that would have silently poisoned inference.

## Plan

- **THE plan (binding build order):** `docs/rebuild/07-master-plan.md` §Phase 1 (items 1a→1h + exit gate).
- **Charter (vision + non-negotiables):** `docs/rebuild/00-charter.md`.
- **Reconciliation memo (binding cross-doc decisions D1–D25):** `docs/rebuild/04-reconciliation.md` — now includes **§"Reconciliation round 3"** with D23–D25 from the Step-0 spike.
- **Per-concept owning docs:** 01 task-contract, 02 workflow-model, 03 tracker-dashboard, 05 parallelism, 06 data-intake, 08 gap-audit, 09 write-safety, **10 guard/test-architecture (owns 1a)**, 11 clock/config/secrets (owns 1b).

## Current state

- **Branch:** `master`
- **Worktrees:** main repo (`923f50c0`) + one agent worktree `.claude/worktrees/agent-af8b23ed8fb094299` (`worktree-agent-af8b23ed8fb094299` @ `c6885332`) that was **NOT created this session** — left untouched, flagged for awareness. (Memory notes a stale `i9` worktree = user's committed copy, don't remove; verify whether this is that one before touching it.)
- **Commits ahead of origin:** **2** unpushed (`923f50c0` ratification, `7003e7e7` final-review fixes). Tree otherwise **clean**.
- **Uncommitted / untracked:** `.rebuild-spike/` (throwaway spike — `spike.ts` + `tsconfig.json`, untracked, intentionally NOT committed). See "Pointers" for its fate.
- **⚠️ Remote anomaly (still open from the last handoff):** `origin/master` advanced *externally* in a prior session with no assistant push. **Standing rule: never push to `origin/master` without explicit instruction.** Confirm remote intent with the user before any remote action; do NOT push `923f50c0`/`7003e7e7`.
- **Environment locked for the build:** TS **5.9.3**, zod **4.4.3** (the `zod` package is v4; `import { z } from "zod"` gives v4). Root `tsconfig.json`: `target ES2024`, `module ESNext`, `moduleResolution bundler`, `strict`, `verbatimModuleSyntax`, `skipLibCheck`. `temp_src/` must land inside this SAME tsconfig + `test` + `test:architecture` umbrella from its first commit (charter non-negotiable: no ungated parallel tree).

## Progress

**Phase 0 — foundation design: COMPLETE ✅** (docs 00–11 + reviews, three review rounds, final xhigh review → sound-with-fixes, all fixes applied).

**Phase 1 — base/kernel.** Build in dependency order (master plan §Phase 1). Critical path: 11 → 01 → 02 → 03 → 05 → 09, with the guard umbrella (10) scaffolded alongside from commit 1.

- [x] **Step 0 — FlowBuilder type-inference spike.** PASSED (HOLDS-with-adjustments). Decisions **D23–D25 ratified** into docs 01 §2.2 / 02 §3 / 04 §Round-3 and committed `923f50c0`. Spike lives in `.rebuild-spike/`.
- [ ] **1a — Guard scaffold ← RESUME HERE.** (Owner: **doc 10** §2/§5.) `test:architecture` globs `temp_src/**`; seed `guard-manifest` + `gate-coverage`; extend ported grep-ratchets to `temp_src` with **zero-allowlist for new code**, shrink-only for ported leaves. Trivially green on the empty tree. Guards that must be registered+green: `guard-manifest`, `gate-coverage`, `fail-loud-catch-default`, `nullish-literal-data-fallback`, `wait-for-timeout-allowlist`, `inline-selectors`, `evaluate-named-fn`, `import-cycles`, `control-layering`(matrix), `code-conventions`.
- [ ] 1b — Clock / config / secrets (doc 11).
- [ ] 1c — Task contracts + stores (doc 01: contract/impl split, `defineTask`; **apply D23** — per-effect `defineTaskContract` overloads returning `SealedRead/MutateContract`).
- [ ] 1d — Descriptor + workflow builder (doc 02). **Apply D24/D25** (`StepEntry<C,Cond>`; single-signature `.step` with `HasWhen<O>`, NO overloads). **Promote `.rebuild-spike/`'s assertion battery into `temp_src`'s type-level test here** (satisfies doc 01 §8 #13 / doc 02 §7). **Verify the D25 residual:** make `probePolicy` a compile error when omitted on a mutate step via a `C`-effect-conditional `StepOpts`; if it won't infer cleanly, fall back to factory + `descriptor-coverage` guard (runtime-enforced always).
- [ ] 1e — Spans + tracker/event layer (doc 03).
- [ ] 1f — Parallel executor + session pool (doc 05).
- [ ] 1g — Write-safety primitive + ledger (doc 09: five-beat, `write_intents` fence/mutex, probe-then-park recovery, hash-chained ledger).
- [ ] 1h — Service stores (extraction / ocr / roster — doc 06 / doc 01 §3.4).
- **Exit gate:** `typecheck:all` + `test` + `test:architecture` green incl. all new safety guards; write-safety fence/mutex/recovery/ledger fixtures pinned; lift replays real `.tracker` days with zero quarantine.

Then Phase 2 (person-lookup live proof) and Phase 3+ (migration order 0–9, incident workflows last).

## Open questions / deferred decisions

- **Q: D25 residual — does `probePolicy`-required-on-mutate compile under the single-signature `.step`?** — current thinking: 1d verifies a `C`-effect-conditional `StepOpts` (`require probePolicy when C extends SealedMutateContract`); if it doesn't infer, enforce at the factory + `descriptor-coverage` guard. Not blocking 1a–1c.
- **Q: Remote state** — did the user intend `origin/master` to advance externally? Confirm before any remote action; do NOT push the 2 unpushed commits without explicit instruction.
- **Q: The `agent-af8b23ed8fb094299` worktree** — is it the memory's "user's committed copy" to keep, or a removable leftover? Verify with the user before touching; do NOT remove blind.
- **Deferred to per-workflow migration (charter §b questionnaire, asked AT migration time):** double-submit probe policy (`always` vs `retries-and-recovery-only`), which actions are real submits, receipt/completion check per submit, dry-run split boundary, freshness `maxAgeMs` values. The user explicitly wants to be asked these per workflow.
- **Disclosed residuals (known limits, not bugs):** probe-can-lie (exactly-once closes double-*file*, not the wrong-*person* racy read); multi-tab WRITE parallelism unproven; the identity-approval gate (the real T002173685 defense) needs its own design before separations (order 8); Kuali save-verify / OnBase upload-verify feasibility resolves at orders 7–8.
- **Program stop-loss (master plan §5.1):** operator sets abort thresholds before approving the full build order.

## Verification before resuming

```bash
git status                                   # expect clean except untracked .rebuild-spike/
git log --oneline -1                         # expect 923f50c0 docs(rebuild): ratify Step-0 spike decisions D23-D25...
git rev-list --count origin/master..master   # expect 2 (unpushed); confirm remote intent with user
ls docs/rebuild/                             # expect 00–11 + reviews/
grep -n "Round 3" docs/rebuild/04-reconciliation.md   # confirm D23-D25 present

# Re-prove the Step-0 spike still compiles clean (the whole thesis):
npx tsc -p .rebuild-spike/tsconfig.json && echo "SPIKE GREEN"
#   Non-vacuity is built in: the 4 @ts-expect-error controls each suppress a real
#   error (TS errors on an unused one), and positive checks use an any-proof Equal<>.

# Baseline the umbrella BEFORE adding temp_src guards (1a extends these to temp_src/**):
npm run test:architecture
npm run typecheck:all
```

## Pointers

- **Read first, in order:** `docs/rebuild/00-charter.md`, `docs/rebuild/07-master-plan.md`, `docs/rebuild/04-reconciliation.md` (incl. §Round 3 / D23–D25), then **`docs/rebuild/10-guard-test-architecture.md`** (owns 1a) and `docs/rebuild/11-clock-config-secrets.md` (owns 1b). For 1c/1d read `01`/`02` (now carrying D23–D25).
- **Project CLAUDE.md:** `/Users/julianhein/Projects/hr-automation/CLAUDE.md` (fail-loud rule, architecture, conventions, live-verification pre-authorization).
- **`.rebuild-spike/`:** throwaway type spike proving the FlowBuilder inference. `spike.ts` = the 7-property assertion battery + the D23/D24/D25 type shapes as-proven. **At 1d, promote its assertions into `temp_src`'s real type-level test, then the dir may be deleted.** Do NOT commit it as-is. Stage files explicitly (never `git add -A`) so it isn't swept in.
- **Memory entries** (`~/.claude/projects/-Users-julianhein-Projects-hr-automation/memory/`): `rebuild-program-temp-src.md` (program status + migration order), `rebuild-write-safety-gap-audit.md` (write-safety decisions), `orchestrator-subagent-design-process.md` (working style), `fail-loud-no-unverified-fallbacks.md`.
- **Working style (important):** the user is the **lean orchestrator** — deep work in high-effort (Opus) subagents that return short summaries; review their output adversarially; explain each part in **plain, non-technical language** (old way → why it hurt → how the new way fixes it); get **part-by-part sign-off before BUILDING** each item. Do NOT push to origin without explicit instruction. Commit as-you-go by category, local only.
