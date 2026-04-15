# Session 2 Handoff — Execute the Workflow Kernel Refactor

This is a standalone prompt for a fresh Claude Code session. Paste everything below the `---` line into a new conversation to start Session 2.

---

I'm continuing a multi-session architectural refactor of this hr-automation codebase. Your job in this session is to execute **Subsystem B+E** — the workflow kernel + directory restructure.

## Context (read first)

Session 1 (a prior conversation) produced a committed design spec at `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md`. Read that spec in full before anything else. It's the authoritative record of architectural decisions. Do not re-brainstorm those decisions; they are locked.

The overall refactor is split into **4 subsystem-level sessions** for quality reasons (context decay in long sessions hurts architectural reasoning):

1. Session 1 (done) — brainstorm + spec for B+E (kernel + directory)
2. **Session 2 (THIS ONE)** — plan + execute B+E
3. Session 3 — selector registry (Priority A)
4. Session 4 — dashboard richness leveling (Priority D)
5. Session 5 — CLAUDE.md conventions (Priority C)

Relevant memory entries: `project_architecture_refactor_arc.md` (the arc + current status), `feedback_delegation_style.md` (how the user delegates).

## Your deliverables in this session

### Phase 1 — Kernel build (plan already written)

The Session 1 implementation plan is at `docs/superpowers/plans/2026-04-15-workflow-kernel-build-plan.md`. It covers 23 tasks that build `src/core/` end-to-end: types, registry, Session (with interleaved auth), Stepper, defineWorkflow, runWorkflow, sequential batch with betweenItems hooks, worker-per-browser pool, page-health relocation, `GET /api/workflows` endpoint, dashboard `WorkflowsProvider`, and `WorkflowSession` deletion. Scope ends with a mock-workflow integration test passing and a `kernel-build-complete` git tag.

**Your job for Phase 1:** execute the existing plan using `superpowers:subagent-driven-development`. Dispatch a fresh subagent per task, review the diff, then dispatch the next. You stay in manager mode. Do not re-plan the kernel — the spec + plan are locked.

Phase 1 is roughly 5 working days of task detail. It likely fits in one literal conversation if the user stays present, but may span 2–3 if interrupted.

### Phase 2 — Workflow migrations (plans written incrementally)

After Phase 1 completes (`kernel-build-complete` tag exists), migrate workflows one at a time in this order:

1. **work-study** (simplest — proves the kernel for trivial case)
2. **emergency-contact** (sequential batch, `preEmitPending`; also moves `roster-verify.ts` and `sharepoint-download.ts` out of `src/utils/` into `src/workflows/emergency-contact/`)
3. **eid-lookup** (page-per-worker pattern via existing `runWorkerPool` helper)
4. **kronos-reports** (worker-per-browser pool, persistent `sessionDir`)
5. **onboarding** (3 systems sequential, PDF download side effect, retries)
6. **separations** (4 systems, interleaved auth, phase parallelism — final boss)

Per-system directory renames happen WITH the first migration that uses that system (mapping in the spec's Migration plan section). Use `git mv` to preserve history. Tag each successful migration: `git tag kernel-migration-<workflow>`.

**Your job for Phase 2:** for each workflow, write a short migration plan (`docs/superpowers/plans/2026-XX-XX-migrate-<workflow>-plan.md`) using `superpowers:writing-plans`, then execute it via `superpowers:subagent-driven-development`. The plan is written incrementally — one at a time — because we want to learn from each migration before committing to the next. If the kernel needs a small API tweak discovered during a migration, do it in the kernel and note it.

A migration is "done" only after: all workflow tests pass, `npm run typecheck` is clean, the old implementation file is deleted, and one real run succeeds (user watching, dashboard verified).

### Multi-conversation span

Total execution is ~15-17 working days. That does NOT fit in one literal conversation. When context starts feeling strained, write `docs/superpowers/sessions/02-kernel-execution-checkpoint-<date>.md` summarizing what's done, what's next, and any gotchas. The user pastes that checkpoint at the start of the next chat to resume. The plan file checkboxes + git tags are the primary progress record.

### End of session — write Session 3's handoff

When all 6 migrations land and every success criterion in the spec is met (see "Success criteria" section of the spec), write `docs/superpowers/sessions/03-selector-registry.md` following the same pattern as this file. Session 3's job: fresh brainstorm → spec → plan → execute for Subsystem A (selector registry). Include in Session 3's prompt:
- Context on what Session 2 shipped (kernel + 6 migrations + new `src/systems/` layout)
- User's remaining priorities: `A > D > C`
- Instruction to brainstorm fresh — do NOT reuse the rough sketch in the kernel spec's "Follow-up specs" section; that was preliminary
- The reminder that `src/systems/<system>/` is now the natural home for selectors
- The reminder that `.or()` fallback chains are currently used in only 2 files across the entire codebase despite PeopleSoft grid ID mutation (see Session 1 survey evidence)

## Constraints and conventions

- Follow the project's `CLAUDE.md` rules (they auto-load). Especially: update module CLAUDE.md files after each migration, document verified selectors, use playwright-cli for any new selector mapping.
- `npm run typecheck` and `npm run test` must pass after every task. If they fail, fix before proceeding.
- Use `git mv` for directory renames so history is preserved.
- Tag each successful migration: `git tag kernel-migration-<workflow>`.
- No feature flags. Each migration replaces the old implementation atomically (within one commit's scope).
- The kernel build (Phase 1) must ship with passing unit tests before any migration starts.
- A migration is "done" only after: dry-run produces matching tracker events, one real run succeeds with the user watching, and the old implementation file is deleted.

## How to start

1. Read `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md` in full.
2. Read `docs/superpowers/plans/2026-04-15-workflow-kernel-build-plan.md` in full — this is what you'll execute first.
3. Read the root `CLAUDE.md` (auto-loaded) and skim per-module CLAUDE.md files relevant to Phase 1 (`src/browser/`, `src/utils/`, `src/tracker/`, `src/dashboard/`).
4. Check memory (`MEMORY.md` + referenced files) for user preferences.
5. Invoke `superpowers:subagent-driven-development` to execute the kernel plan task-by-task. Do not re-plan.
6. When Phase 1 completes (`kernel-build-complete` tag), pause and confirm with the user before starting Phase 2 migrations.

## Out of scope for this session

- Selector registry design (that's Session 3)
- Dashboard richness leveling (Session 4)
- CLAUDE.md convention rewrite (Session 5)
- Any architectural change not already captured in the spec

If something in the spec looks wrong once you start executing, STOP and discuss with the user before deviating. The spec is the contract.

Begin.
