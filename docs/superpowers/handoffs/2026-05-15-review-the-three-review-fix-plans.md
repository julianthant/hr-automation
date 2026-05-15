# Handoff — Review the three 2026-05-14 review-fix plans

**Date:** 2026-05-15
**Paused at:** post-plan-writing, pre-execution. User wants an independent review pass over the three plans before starting any inline execution.

## Task summary

A 19-agent codebase review on 2026-05-14 surfaced ~40 correctness issues, ~25 performance items, ~280 simplification opportunities, and ~25 doc drift items across the entire hr-automation codebase (~71k lines, 423 source files). Findings were distilled into three implementation plans split by area. The user wants a second pair of eyes on those plans before executing any of them inline.

The reviewer's job is **not** to re-do the codebase review — it's to evaluate the plans themselves for: cross-plan coherence, ordering risk, missing coverage, scope creep, dangerous changes, and anything that would be better deferred or restructured before execution starts.

## Plans to review (all committed at `8b2697c1`)

1. `docs/superpowers/plans/2026-05-14-review-fixes-core-tracker-infra.md` — ~1086 lines. Kernel, daemon, task-store, tracker JSONL/SSE/HTTP backend, infra auth/browser, utils, scripts, cli.ts. 35+ tasks across phases A (correctness) → B (performance) → C (dead code & one-liners) → D (shared helper extractions).
2. `docs/superpowers/plans/2026-05-14-review-fixes-dashboard-systems.md` — ~957 lines. React SPA fixes + Playwright system drivers + safeClick/safeFill adoption + selector hygiene. 60+ tasks across phases A–G.
3. `docs/superpowers/plans/2026-05-14-review-fixes-workflows-services-docs.md` — ~869 lines. Workflow orchestration, OCR/matching/capture services, domain helpers, all documentation drift. 50+ tasks across phases A–G.

**Sibling handoffs (not for the reviewer to consume — for the executor later):**
- `docs/superpowers/handoffs/2026-05-14-review-fixes-core-tracker-infra.md`
- `docs/superpowers/handoffs/2026-05-14-review-fixes-dashboard-systems.md`
- `docs/superpowers/handoffs/2026-05-14-review-fixes-workflows-services-docs.md`

**Intentionally excluded across all three plans:** `src/config.ts:48-50` `ANNUAL_DATES` bump. User has confirmed those stale-looking FY dates are intentional. Do NOT flag this as missing — the exclusion is deliberate.

## What to evaluate

Run these checks against the actual code. Don't just read the plans in isolation.

1. **Each high-priority correctness task — verify the bug exists.** Spot-check 5–8 critical findings (e.g., `App.tsx:625 || true`, `jsonl.ts:492` SIGINT date-local, `emergency-contact.ts:137` auto-accept floor, `match.ts:39-48` token-set collapse). Read the cited line ranges in the current code. Confirm the described bug is real and the proposed fix actually fixes it. Flag any false positives.

2. **Cross-plan dependencies.** Surface every place where a task in plan N references or depends on a task in plan M:
   - Plan 1 Task D1 (`requireEnv` / `parsePositiveInt`) is referenced in Plan 3 Task E1 (`buildCliAdapter`).
   - Plan 1 Task C9 (`node:timers/promises` sweep) overlaps with Plan 3's services usage.
   - Plan 2 Task F1/F2 (safeClick/safeFill adoption) affects Plan 3's UCPath simplification ordering.
   - Plan 1 Task A5 (SIGINT date-local) interacts with Plan 3 Task B4 (oath-upload cross-day recovery).
   - Plan 1 Task D31 (`readJsonlStream`) is referenced by Plan 3 Task C5 (`readPreviousRecords`).
   - Plan 2 Task E1 (UCPath name selector remap) requires `playwright-cli` access to a live session — if the executor lacks env, what's the fallback?

   Recommend an execution order (1→2→3, or another sequence). Identify any cycles. Identify tasks that should move between plans.

3. **Risk surfaces.** Flag tasks that could break the daemon, lose user-visible data, regress UX, or violate the user's "fail loud over auto-correct" preference. Specifically:
   - Plan 1 Task A4 (daemon claim invariant — throw instead of UUID fallback) — is that the right call given the daemon would crash on a single bad row?
   - Plan 1 Task A7 (runId race — UUID format change `id#N` → `id#<hex>`) — does this actually break any UI assertion or dashboard sort logic?
   - Plan 1 Task D23 (`DaemonState` extract from 10+ `let` vars) — large refactor; risk of subtle regressions in heartbeat / shutdown ordering.
   - Plan 1 Task D26 (unify single-run + batch-run inner loops) — even larger; verify the two paths actually share enough to safely unify.
   - Plan 2 Task B2 (LogStream virtualization) — affects scroll, copy-on-click, hover; any chance of subtle UX regression?
   - Plan 3 Task A1 (auto-accept score floor) — verify the threshold `ROSTER_AUTO_ACCEPT = 0.85` is the right floor for this form; the oath form uses `NAME_DISAMBIG_FLOOR` which may differ.

4. **Scope creep & deferral candidates.** Several Plan 1 tasks (D23, D26, D27) and Plan 3 OCR orchestrator decomposition are large refactors that could be deferred to focused PRs. Flag anything where the size/risk doesn't justify bundling it with quick wins.

5. **Coverage gaps.** Skim the original review findings (summarized at the top of each plan's referenced session — or use the plan files themselves as the canonical distillation). Anything the review surfaced that no plan task addresses? Specifically check that no "Important" / "Critical" severity finding was dropped.

6. **Verification rigor.** Each task in the plans has a verification step. Are they sufficient? Are there tasks where the verification is just "run typecheck" when end-to-end exercise would be needed (e.g., changes to daemon claim-loop, JSONL filename derivation, OCR auto-accept logic)?

7. **Conflicts with project conventions.** The plans were authored against the current `CLAUDE.md` + `LESSONS.md` rules. Spot-check that proposed refactors don't violate:
   - No default exports
   - No inline selectors (Plan 2 Task F1/F2 must respect compound-selector whitelisting via `// allow-inline-selector` comments)
   - Lessons-format guard (any task that adds a LESSONS.md entry must conform)
   - Architecture-guard suite (no new architecture violations introduced)

## Deliverable

Write a review report at `docs/superpowers/reviews/2026-05-15-review-fix-plans-review.md` (create dir if needed) with sections:

- **Overall verdict:** ship / ship with changes / restructure / defer.
- **High-impact findings:** specific tasks to change, drop, split, or reorder. Cite plan file + task ID.
- **Cross-plan ordering recommendation:** which plan to execute first, second, third, and why. Note any tasks that should move between plans.
- **Risk register:** tasks where the executor should be extra cautious or run a smoke test before committing.
- **Coverage gaps:** findings not covered (if any) with cite to where they came from.
- **Nits:** anything the executor should know but isn't worth restructuring for.

Keep it actionable. The user will read it and either start execution or revise plans based on it. Don't pad with summaries of what each plan does — the plans speak for themselves.

## Verification before starting the review

```bash
git status                             # should be clean
git log --oneline 16559b31..HEAD       # should show the plan commit (8b2697c1) and handoff commit (6d938cef)
ls docs/superpowers/plans/2026-05-14-review-fixes-*.md   # three files present
ls docs/superpowers/handoffs/2026-05-14-review-fixes-*.md # three handoffs present
npm run typecheck && npm run test && npm run test:architecture  # green baseline
```

If any of those fail, fix or surface before starting the review.

## Pointers

- Project conventions: `CLAUDE.md` (root)
- Module CLAUDE.md's: `src/core/`, `src/tracker/`, `src/dashboard/`, `src/workflows/`, `src/systems/<system>/`
- Cross-codebase lessons: `LESSONS.md` (root)
- Global user conventions: `~/.claude/CLAUDE.md` (especially the branching/commit/worktree discipline and the "fail loud" feedback)
- Memory: `~/.claude/projects/-Users-julianhein-Documents-hr-automation/memory/MEMORY.md`
- Architecture guard tests: `tests/unit/scripts/`, `tests/unit/systems/inline-selectors.test.ts`

## Tool guidance

- Use `feature-dev:code-reviewer` or `code-reviewer:code-reviewer` subagent dispatch if helpful for spot-checks. The reviewer should ideally do at least one parallel fan-out for the 5–8 sampled correctness verifications.
- Read full plan files end-to-end before forming the verdict. Skimming the headers is not enough.
- Don't re-do the codebase review — the bugs are mostly already verified by the original 19-agent fan-out.
