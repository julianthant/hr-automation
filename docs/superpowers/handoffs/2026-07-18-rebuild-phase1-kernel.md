# Handoff — temp_src rebuild, Phase 1 (base/kernel)

**Date:** 2026-07-18
**Paused at:** End of Phase 0 (design). All 12 design docs written, adversarially reviewed, reconciled, final-reviewed (verdict **sound-with-fixes**), fixes applied, and committed. User has elected to **start building Phase 1**. No implementation code exists yet — `temp_src/` is not created.

## Task summary

We are **rebuilding** the HR-automation codebase into a new `temp_src/` tree on a **task-store architecture**, then migrating the old `src/` into it one workflow at a time. The motivation: the current build is coupled *by convention* — one workflow's identity is forked across ~10 hand-maintained lists that drift silently — plus a live fail-open write hazard (a real duplicate person and a wrong-person termination, `T002173685`). The rebuild couples *by contract*: small typed tasks (zod in/out) in per-system **and** per-workflow stores, composed into workflows; one descriptor as the single source of truth (kills the parallel lists); fenced fail-closed write-safety (exactly-once); one clock/config/secrets; guards that defend the foundation. **This is a multi-quarter, one-workflow-at-a-time program — not a big-bang rewrite.** Old `src/` keeps running throughout; each system's old code is deleted only when its workflows are fully migrated.

## Plan

- **Binding build order:** `docs/rebuild/07-master-plan.md` (this is THE plan — phases + migration order + exit gates).
- **Charter (vision + non-negotiables):** `docs/rebuild/00-charter.md`.
- **Reconciliation memo (binding cross-doc decisions D1–D22 + round-2 write-safety):** `docs/rebuild/04-reconciliation.md`.
- **Per-concept design docs (one owner each):** 01 task-contract, 02 workflow-model, 03 tracker-dashboard, 05 parallelism, 06 data-intake/Edit-Data, 08 gap-audit, 09 write-safety, 10 guard/test-architecture, 11 clock/config/secrets. Reviews in `docs/rebuild/reviews/`.
- **Final review verdict (read before building):** synthesized as **sound-with-fixes** — architecture holds, order deadlock-free, 9/12 original problems structurally closed, 3 partial with *disclosed* residuals, fail-loud honored throughout. All 5 fixes + refinements are already applied (commit `7003e7e7`).

## Current state

- **Branch:** `master`
- **Worktrees:** none relevant to this work. (A stale `i9` worktree exists = user's committed copy — do NOT remove it; see memory.)
- **Commits ahead of origin:** 1 (`7003e7e7`, unpushed). Tree is **clean**.
- **⚠️ Remote anomaly — verify before trusting remote state:** `origin/master` advanced *externally* this session (its tip is `07bb330e`; it now contains the earlier commits). No `git push` was ever run by the assistant, and there is no auto-push hook/config. Likely the user pushed manually or an IDE/sync did. **Standing rule: never push to `origin/master` without explicit instruction.** Confirm with the user whether the remote state is intended before doing anything with the remote.

## Progress

**Phase 0 — foundation design: COMPLETE ✅** (docs committed `cc0dd757`, `6acdb84a`, `07bb330e`, `7003e7e7`)
- [x] Design docs 00–11 + reviews, three review rounds, final xhigh review → sound-with-fixes, fixes applied.

**Phase 1 — base/kernel: NOT STARTED.** Build in this dependency order (from master plan §Phase 1). `temp_src/` lives under the SAME `typecheck:all` / `test` / `test:architecture` umbrella from the first commit; guards carry a `temp_src` glob from 1a.

- [ ] **Step 0 — FlowBuilder type-inference PROTOTYPE spike ← resume here.** Before committing to the builder, prove the linchpin compiles: the `defineTask`/`FlowBuilder` accumulating two generic maps (outputs + tasks) with `z.input`/`z.output` threading, `const`-tuple `errorCodes`, sealed/branded specs. The whole "coupled by contract / fails to compile on the other side" thesis is currently **unverified prose** — if inference collapses under `AnyTaskContract` erasure, the design must adapt. This is the review's top de-risk. Do it FIRST, in a throwaway/spike file, before 1a–1h depend on it.
- [ ] 1a — guard scaffold (guard-manifest + ratchets extended with a `temp_src` glob; trivially green on empty tree)
- [ ] 1b — clock / config / secrets (doc 11)
- [ ] 1c — task contracts + stores (doc 01: contract/impl split, `defineTask`)
- [ ] 1d — descriptor + workflow builder (doc 02) — apply the Step-0 prototype
- [ ] 1e — spans + tracker/event layer (doc 03)
- [ ] 1f — parallel executor + session pool (doc 05)
- [ ] 1g — write-safety primitive + ledger (doc 09: five-beat, `write_intents` fence/mutex, probe-then-park recovery, hash-chained ledger)
- [ ] 1h — service stores (extraction / ocr / roster — doc 06 / doc 01 §3.4)
- **Exit gate:** `typecheck:all` + `test` + `test:architecture` green incl. new safety guards; write-safety fence/mutex/recovery/ledger fixtures pinned; lift replays real `.tracker` data with zero quarantine.

Then Phase 2 (person-lookup live proof) and Phase 3+ (migration order 0–9, incident workflows last). See master plan.

## Open questions / deferred decisions

- **Q: Two sign-offs (task contract + write-safety) were pending — proceed anyway?** User said "start building Phase 1," which is the implicit go-ahead; building the contract IS exercising that design. If the user wants a formal plain-language walkthrough of either before coding, offer it. — current thinking: proceed, but surface any contract-shape decision that emerges from the Step-0 prototype for confirmation.
- **Q: Remote state** — did the user intend `origin/master` to advance? Confirm before any remote action; do not push commit `7003e7e7` without explicit instruction.
- **Deferred to per-workflow migration (charter §b questionnaire):** the double-submit probe policy (`always` vs `retries-and-recovery-only`), which actions are real submits, receipt/completion check per submit, dry-run split boundary, freshness `maxAgeMs` values. Ask these AT migration time, per workflow — the user explicitly wants to be asked.
- **Disclosed residuals (not bugs — known limits):** probe-can-lie (exactly-once closes double-*file*, not the wrong-*person* racy read); multi-tab WRITE parallelism unproven (write-heavy workflows may stay serial — framing is "sleep-tax-first," not "5× everything"); the identity-approval gate (the real T002173685 defense) needs its own design before the separations migration (order 8); Kuali save-verify / OnBase upload-verify read-back feasibility resolves at orders 7–8.
- **Program stop-loss (master plan §5.1):** operator sets the abort thresholds before approving the full build order.

## Verification before resuming

```bash
git status                          # expect clean
git log --oneline -1                # expect 7003e7e7 docs(rebuild): apply final-review fixes...
git rev-list --count origin/master..master   # expect 1 (unpushed); confirm remote intent with user
ls docs/rebuild/                    # expect 00–11 + reviews/
npm run test:architecture           # baseline green before adding temp_src guards
```
Read first, in order: `docs/rebuild/00-charter.md`, `docs/rebuild/07-master-plan.md`, `docs/rebuild/04-reconciliation.md`, then `01`/`02`/`09`/`10`/`11` for the pieces Phase 1 builds.

## Pointers

- **Project CLAUDE.md:** `/Users/julianhein/Projects/hr-automation/CLAUDE.md` (fail-loud rule, architecture, conventions).
- **Design docs:** `docs/rebuild/` (all 12 + `reviews/`). The three visual explainers are Artifacts (foundation blueprint, hardening pass, build plan) — links are in the conversation, not needed to build.
- **Memory entries** (`~/.claude/projects/-Users-julianhein-Projects-hr-automation/memory/`): `rebuild-program-temp-src.md` (program status + migration order), `rebuild-write-safety-gap-audit.md` (write-safety decisions), `orchestrator-subagent-design-process.md` (working style: lean orchestrator, high-effort subagent brainstorms, plain-language part-by-part sign-off), `fail-loud-no-unverified-fallbacks.md`.
- **Working style (important):** the user wants the assistant as a **lean orchestrator** — deep work in high-effort (Opus) subagents that write to `docs/` and return summaries; review their output adversarially; explain each part in **plain, non-technical language** (old way → why it hurt → how the new way fixes it); get **part-by-part sign-off** before building. Do NOT push to origin without explicit instruction. Commit as-you-go by category (local only).
