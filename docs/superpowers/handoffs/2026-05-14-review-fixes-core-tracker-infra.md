# Handoff — Code review fixes: Core + Tracker + Infra

**Date:** 2026-05-14
**Paused at:** post-plan, before execution. All three review-fix plans are committed; this is plan 1 of 3.

## Task summary

Land every correctness, performance, and simplification finding from the 2026-05-14 codebase review for the `src/core/`, `src/tracker/`, `src/infra/`, `src/utils/`, `src/scripts/`, and `src/cli.ts` areas. The review was run as 19 parallel subagents (code-reviewer + code-simplifier per area + performance-reviewer per cluster + doc-reviewer) and surfaced ~40 correctness issues, ~25 performance items, and ~280 simplification opportunities across the whole codebase. Plan 1 owns the backend half (kernel, daemon, task-store, tracker JSONL/SSE/HTTP backend, infra auth/browser).

**Intentionally excluded:** `src/config.ts:48-50` `ANNUAL_DATES` bump — the user has confirmed those stale-looking FY dates are intentional. Do NOT touch them.

## Plan

- Plan file: `docs/superpowers/plans/2026-05-14-review-fixes-core-tracker-infra.md`
- Created: 2026-05-14 (committed in `8b2697c1`)
- Phases: A (correctness, 15 tasks) → B (performance, 12 tasks) → C (dead code & one-liners, ~15 tasks) → D (shared helper extractions, ~30 tasks) → terminal verification.

## Current state

- Branch: `master`
- Worktrees: none — execute inline on master (per user direction).
- Commits ahead of `origin/master`: 1 (the plan-commit itself).
- Uncommitted changes: clean.

## Progress

- [x] Plan written and committed (`8b2697c1`)
- [ ] Phase A — Correctness fixes ← **resume here at Task A1**
- [ ] Phase B — Performance hot paths
- [ ] Phase C — Dead code & one-liners
- [ ] Phase D — Shared helper extractions
- [ ] Final verification

Total tasks in this plan: 35+ (A1–A15, B1–B12, C1–C19 minus C12 which defers to Plan 2, D1–D35 final sweep).

## Open questions / deferred decisions

None outstanding. The plan resolves the simplification cutoff (all tiers included), the split point (by area), and the ANNUAL_DATES exclusion.

The plan does have one judgment call inside Task A7 (jsonl.ts runId race fix): UUID-based runId vs SQLite-serialized counter. The plan recommends UUID. If the executor disagrees while executing, document the choice in the commit.

## Verification before resuming

Run these first to confirm state matches this brief:

```bash
git status
git log --oneline 16559b31..HEAD   # should show only the plan commit (8b2697c1)
git worktree list                   # should be just the main checkout
npm run typecheck && npm run test && npm run test:architecture
```

If any of typecheck/test/architecture fail at the start, fix root cause before beginning Phase A — the plan assumes a green baseline.

## Pointers

- Root project conventions: `CLAUDE.md` (project root)
- Kernel internals: `src/core/CLAUDE.md`
- Tracker internals: `src/tracker/CLAUDE.md`
- Dashboard backend (touched indirectly by tracker fixes): `src/dashboard/CLAUDE.md`
- Cross-codebase lessons: `LESSONS.md` (project root)
- Global user conventions: `~/.claude/CLAUDE.md`
- Memory: `~/.claude/projects/-Users-julianhein-Documents-hr-automation/memory/MEMORY.md`
  - Particularly relevant: `feedback_fail_loud_over_auto_correct.md`, `feedback_branch_commit_merge_strategy.md`, `reference_dashboard_restart_required.md`
- Codebase review report: present in this session's conversation; the plan file is the authoritative distilled form.

## Sibling plans (do NOT execute here)

- Plan 2: `docs/superpowers/plans/2026-05-14-review-fixes-dashboard-systems.md` — dashboard React fixes + Playwright system drivers.
- Plan 3: `docs/superpowers/plans/2026-05-14-review-fixes-workflows-services-docs.md` — workflows, OCR/matching services, doc drift.

Each has its own handoff brief; the user will run them in separate fresh sessions.
