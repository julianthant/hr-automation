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

1. **Write the implementation plan.** Use the `superpowers:writing-plans` skill. Save to `docs/superpowers/plans/2026-04-15-workflow-kernel-plan.md`. Cover both phases:
   - **Phase 1 — Kernel build:** scaffold `src/core/` with `workflow.ts`, `session.ts`, `stepper.ts`, `batch.ts`, `pool.ts`, `registry.ts`, `page-health.ts` (moved from utils), `types.ts`. Add unit tests. Add the ESLint rules for `no-floating-promises` + `await-thenable`. Add `GET /api/workflows` to the SSE server. Add `WorkflowsProvider` + `useWorkflows()` to the dashboard. Delete `src/browser/session.ts` (unused `WorkflowSession` class). Kernel build alone is ~5 working days of task detail.
   - **Phase 2 — Migrations, 6 workflows, in this order:** work-study → emergency-contact → eid-lookup → kronos-reports → onboarding → separations. Per-system dir renames (`src/ucpath` → `src/systems/ucpath`, etc.) happen WITH the first workflow migration that uses that system (see spec migration plan section for the exact mapping). Workflow-specific utils (`roster-verify`, `sharepoint-download`) move into their workflow's dir during the emergency-contact migration.

   Each workflow migration is ~1-2 days of task detail. Total plan ~15-17 working days of tasks.

2. **Execute the plan.** Use `superpowers:subagent-driven-development` — dispatch a fresh subagent per task, you review the diff, then dispatch the next. You stay in manager mode: reading diffs, catching issues, maintaining architectural coherence. Do not do implementation yourself — you are there to judge, not type.

3. **Handle multi-conversation span.** This session's scope is ~15-17 working days of execution. That does NOT fit in one literal conversation. When context starts feeling strained (or the user stops for the day), write a mid-session checkpoint to `docs/superpowers/sessions/02-kernel-execution-checkpoint-<date>.md` summarizing what's done + what's next + any gotchas discovered. The user will paste that checkpoint at the start of the next chat to resume. The plan file with its checkboxes is the primary progress record; checkpoints add nuance.

4. **At the end — write Session 3's handoff prompt.** When all 6 workflows are migrated, validation criteria from the spec are met, and the kernel is in production, write `docs/superpowers/sessions/03-selector-registry.md` following the same pattern as this file. Session 3's job will be: fresh brainstorm → spec → plan → execute for Subsystem A (the selector registry). The A spec needs `src/systems/` to exist, which your work produces. Include in Session 3's prompt: (a) context on what Session 2 built, (b) the user's priorities from Session 1 (`A > D > C` remaining), (c) instructions to brainstorm fresh rather than re-use the Session 1 spec's rough sketch of A.

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
2. Read the root `CLAUDE.md` (auto-loaded) and skim per-module CLAUDE.md files relevant to Phase 1 (`src/browser/`, `src/utils/`, `src/tracker/`, `src/dashboard/`).
3. Check memory (`MEMORY.md` + referenced files) for user preferences.
4. Invoke `superpowers:writing-plans` to produce the plan.
5. When the user approves the plan, invoke `superpowers:subagent-driven-development` to begin execution.

## Out of scope for this session

- Selector registry design (that's Session 3)
- Dashboard richness leveling (Session 4)
- CLAUDE.md convention rewrite (Session 5)
- Any architectural change not already captured in the spec

If something in the spec looks wrong once you start executing, STOP and discuss with the user before deviating. The spec is the contract.

Begin.
