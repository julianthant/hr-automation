# Handoff — Code review fixes: Workflows + Services + Docs

**Date:** 2026-05-14
**Paused at:** post-plan, before execution. All three review-fix plans are committed; this is plan 3 of 3.

## Task summary

Land every correctness, performance, and simplification finding from the 2026-05-14 codebase review for the `src/workflows/`, `src/services/`, and `src/domain/` areas, plus every documentation drift item across the repo (root `CLAUDE.md`, `README.md`, `src/core/CLAUDE.md`, `src/dashboard/CLAUDE.md`, per-system `LESSONS.md` audits, etc.).

Headline correctness issues: OCR auto-accept fires on any single roster candidate regardless of score (the `ROSTER_AUTO_ACCEPT = 0.85` constant is never consulted); token-set name match collapses duplicate tokens so `"John John"` matches `"John X"` at 0.9 (above auto-accept floor); OCR `quota-exhausted` key can stay permanently exhausted across day-rollover; 3 copies of `getGeminiKeys()` cap at 6 keys while `per-page-pool.ts` caps at 8 (keys 7-8 silently ignored); onboarding CRM ops run outside any `ctx.step` (failures untracked); `process.exit(1)` in composable in-process workflow paths kills the daemon if composed.

Headline performance issues: OCR orchestrator emits full records snapshot per child outcome (20+ JSONL writes/run); roster tokenized per OCR record instead of once; oath-upload duplicate-check is sync `readFileSync` on every PDF selection.

Headline simplification: 8 workflow `runXxxCli` CLI adapters duplicate ~200 lines of identical scaffold; delete dead `src/services/ocr/cache.ts`; collapse twin Gemini call shapes across disambiguate/lookup-suggestions; OCR form-spec shared helpers (`applyDisambiguation`, `applyCarryForward`, threshold constants).

Headline docs: root `CLAUDE.md` architecture tree is stale (kernel/daemon paths wrong; sharepoint system + active-check + crm-doc-download workflows missing); `README.md` predates daemon mode entirely; `src/LESSONS.md` and `docs/HISTORY.md` cross-references are dead; `clean:tracker` doc says 7 days but code default is 30.

**Intentionally excluded:** `src/config.ts:48-50` `ANNUAL_DATES` bump (intentional; do NOT touch).

## Plan

- Plan file: `docs/superpowers/plans/2026-05-14-review-fixes-workflows-services-docs.md`
- Created: 2026-05-14 (committed in `8b2697c1`)
- Phases: A (services correctness, 5 tasks) → B (workflows correctness, 10 tasks) → C (services performance, 8 tasks) → D (services simplifications, 6 tasks) → E (workflows simplifications, 11 tasks) → F (documentation drift, 9 tasks) → G (final verification).

## Current state

- Branch: `master`
- Worktrees: none — execute inline on master (per user direction).
- Commits ahead of `origin/master`: 1 if Plans 1 & 2 haven't run yet; otherwise whatever they produced + 1.
- Uncommitted changes: clean (assuming prior plans committed cleanly).

## Progress

- [x] Plan written and committed (`8b2697c1`)
- [ ] Phase A — Services correctness (OCR auto-accept floor, token-set match, quota-exhausted, getGeminiKeys unify, capture finalize logging) ← **resume here at Task A1**
- [ ] Phase B — Workflows correctness (onboarding step coverage, oath-upload cross-day recovery, process.exit, separations bypass-path, etc.)
- [ ] Phase C — Services performance (OCR snapshot caching + onProgress debounce, roster tokenization hoist, etc.)
- [ ] Phase D — Services simplifications (delete cache.ts, callGeminiJson + parseJsonLoose, form-spec helpers)
- [ ] Phase E — Workflows simplifications (buildCliAdapter — the big one — plus ctx.captureAndStamp, separations rejection-classifier, etc.)
- [ ] Phase F — Documentation drift (root + module CLAUDE.md, README.md, dead cross-refs)
- [ ] Phase G — Final repo verification

Total tasks: 50+ (A1–A5, B1–B10, C1–C8, D1–D6, E1–E11, F1–F9, G1).

## Open questions / deferred decisions

- **Plan ordering:** Plan 3 is largely independent of Plans 1 & 2 but Task E1's `buildCliAdapter` extraction may benefit from Plan 1's `requireEnv`/`parsePositiveInt` helpers (Task D1) if they're already in place. Document the order chosen.
- **Token-set match guard (Task A2):** Plan recommends "≥2 distinct tokens to qualify for token-set tier." Verify against existing test fixtures that this doesn't regress legitimate single-word-pair matches. Run `npm run test -- tests/unit/services/matching` after the fix.
- **OCR orchestrator decomposition:** The orchestrator at 1173 lines with 11 test-override hatches is flagged in the review as a candidate for phase-decomposition but is explicitly out of scope for this plan (a separate larger refactor). Capture as future work in `LESSONS.md` if you discover deeper coupling while executing C1/C2.
- **README rewrite (Task F6):** The plan recommends rewriting against current `package.json`. If you prefer to delete it and link to `CLAUDE.md` instead, that's also acceptable — document the choice.

## Verification before resuming

```bash
git status
git log --oneline 16559b31..HEAD   # at minimum the plan commit; possibly Plans 1 + 2 commits
git worktree list                   # main checkout only
npm run typecheck && npm run test && npm run test:architecture && npm run lint
npm run schemas:export              # confirms all workflow schemas resolve
```

If env supports it, also smoke-test OCR end-to-end (`npm run oath-upload <test-pdf>`) at the start to capture a baseline before changing OCR services.

## Pointers

- Workflow conventions: `src/workflows/CLAUDE.md`
- Per-workflow docs: `src/workflows/<workflow>/CLAUDE.md`
- Kernel API (referenced by Task E1's `buildCliAdapter`): `src/core/CLAUDE.md`
- Service primitives: `src/services/ocr/`, `src/services/matching/`, `src/services/capture/` — each has internal structure documented inline.
- Tracker internals (Task E7 moves a helper there): `src/tracker/CLAUDE.md`
- Cross-codebase lessons: `LESSONS.md` (project root) — read before non-trivial tasks.
- Global user conventions: `~/.claude/CLAUDE.md`
- Memory: relevant entries include `project_ocr_delegation_shipped.md`, `project_pending_row_input_field.md`, `feedback_fail_loud_over_auto_correct.md`, `feedback_daemon_autospawn_semantics.md`.

## Sibling plans (do NOT execute here)

- Plan 1: `docs/superpowers/plans/2026-05-14-review-fixes-core-tracker-infra.md` — kernel, tracker backend, infra.
- Plan 2: `docs/superpowers/plans/2026-05-14-review-fixes-dashboard-systems.md` — dashboard React + Playwright system drivers.

Each has its own handoff brief; the user will run them in separate fresh sessions.
