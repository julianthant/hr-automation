# Handoff — Code review fixes: Dashboard + Systems

**Date:** 2026-05-14
**Paused at:** post-plan, before execution. All three review-fix plans are committed; this is plan 2 of 3.

## Task summary

Land every correctness, performance, and simplification finding from the 2026-05-14 codebase review for the `src/dashboard/` (React SPA) and `src/systems/` (Playwright drivers + selector registries) areas. The review surfaced multiple real bugs in the dashboard (`App.tsx:625 || true` debug leftover, `useEntries` duplicate setters per SSE tick, `FailureBell` fetch loop, `LogStream initialTab` reset bug, `useNow`/`useQueueDepth` HMR leaks, dead `StepPipeline` cache branch) plus the highest-leverage simplification in the codebase (extract `IconActionButton`, `usePostAction`, `useSseHistoryStream` — collapses ~400 lines across 12 button components).

On the systems side: the architecture mandate that `safeClick`/`safeFill` wrap every Playwright `.click()`/`.fill()` for selector-fallback instrumentation is currently honored by zero callers — adopting them is a substantial fan-out across UCPath, CRM, I9, Kuali, Kronos, ServiceNow drivers. Also: replace hardcoded personal-name exclusion in `ucpath/person-org-summary.ts:47` (`"Julian Zaw"`) with a selector-driven lookup; remove hardcoded I9 URL bypassing config; fix `as never` type-cast holes.

**Intentionally excluded:** `src/config.ts:48-50` `ANNUAL_DATES` bump (intentional; do NOT touch).

## Plan

- Plan file: `docs/superpowers/plans/2026-05-14-review-fixes-dashboard-systems.md`
- Created: 2026-05-14 (committed in `8b2697c1`)
- Phases: A (dashboard correctness, 8 tasks) → B (dashboard performance, 7 tasks) → C (dashboard shared components, 4 tasks) → D (dashboard component/state simplifications, 16 tasks) → E (systems correctness, 8 tasks) → F (safeClick/safeFill adoption, 2 large tasks) → G (systems simplifications, 17 tasks) → terminal verification.

## Current state

- Branch: `master`
- Worktrees: none — execute inline on master (per user direction).
- Commits ahead of `origin/master`: 1 if Plan 1 hasn't run yet; otherwise whatever Plan 1 produced + 1.
- Uncommitted changes: clean (assuming Plan 1 has committed cleanly if it ran first).

## Progress

- [x] Plan written and committed (`8b2697c1`)
- [ ] Phase A — Dashboard correctness ← **resume here at Task A1**
- [ ] Phase B — Dashboard performance (virtualize LogStream is the headline)
- [ ] Phase C — Dashboard shared components (IconActionButton, usePostAction, useSseHistoryStream — biggest single-PR win)
- [ ] Phase D — Dashboard component & state simplifications
- [ ] Phase E — Systems correctness
- [ ] Phase F — safeClick/safeFill adoption (fanout)
- [ ] Phase G — Systems simplifications
- [ ] Final verification

Total tasks: 60+ (A1–A8, B1–B7, C1–C4, D1–D16, E1–E8, F1–F2, G1–G17).

## Open questions / deferred decisions

- **Plan 1 dependency:** Plan 2 is largely independent of Plan 1 changes — none of the listed tasks share files. Plans can run in either order, but if Plan 1 has already run, verify it's committed cleanly before starting (re-run `npm run typecheck && npm run test && npm run test:architecture`).
- **QueuePanel virtualization (Task B3):** Conditional on observed queue size. Skip if the queue rarely exceeds ~50 visible rows; otherwise apply TanStack Virtual pattern as in Task B2. Decide based on production usage.
- **SSE Hub reconnect refactor (Task D11):** May be skippable if mid-session flicker is not actually observed. Document either way.
- **Selector remap for "Julian Zaw" fix (Task E1):** Requires `playwright-cli` access to a live UCPath session. If env is unavailable in the execution session, defer the remap and document — but still document the issue clearly in `src/systems/ucpath/LESSONS.md`.

## Verification before resuming

```bash
git status
git log --oneline 16559b31..HEAD   # at minimum the plan commit (8b2697c1); possibly Plan 1 commits too
git worktree list                   # main checkout only
npm run typecheck && npm run test && npm run test:architecture && npm run lint
npm run dashboard                   # smoke test — does the SPA render?
```

For dashboard tasks, keep the dashboard running while editing — visual regressions are catchable immediately.

## Pointers

- Dashboard internals: `src/dashboard/CLAUDE.md`
- Per-system drivers: `src/systems/<system>/CLAUDE.md` (especially `ucpath/`, `i9/`, `old-kronos/`, `servicenow/`)
- Per-system lessons: `src/systems/<system>/LESSONS.md` — append new lessons as you discover non-obvious selector failures.
- Selector registry rules: `CLAUDE.md` § "Selector registry" + `npm run selector:search "<intent>"` before mapping anything new.
- Architecture guards: `npm run test:architecture` — enforces no-default-exports, no-inline-selectors, lesson format, catalog sync.
- Global user conventions: `~/.claude/CLAUDE.md`
- Memory: relevant entries include `feedback_uiuxpromax_scope.md`, `feedback_questions_text_format.md`, `feedback_branch_commit_merge_strategy.md`.

## Sibling plans (do NOT execute here)

- Plan 1: `docs/superpowers/plans/2026-05-14-review-fixes-core-tracker-infra.md` — kernel, tracker backend, infra.
- Plan 3: `docs/superpowers/plans/2026-05-14-review-fixes-workflows-services-docs.md` — workflows, OCR/matching services, doc drift.

Each has its own handoff brief; the user will run them in separate fresh sessions.
