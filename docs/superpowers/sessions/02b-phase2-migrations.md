# Phase 2 Handoff — Workflow Migrations

This is a standalone prompt for a fresh Claude Code session. Paste everything below the `---` line into a new conversation to continue the hr-automation architectural refactor.

---

I'm continuing a multi-session architectural refactor of this hr-automation codebase. **Phase 1 (kernel build) is complete** — tag `kernel-build-complete` marks it. Your job in this session is **Phase 2: migrate all 6 workflows onto the new `src/core/` kernel.**

## Context (read first, in order)

1. **`docs/superpowers/sessions/02-kernel-execution-checkpoint.md`** — Session 2's own Phase 1 closeout. Lists exactly what shipped, deviations from the plan (with rationale), known gotchas, and commit hashes. This is the freshest truth about the current state; read it before the spec.
2. `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md` — authoritative architecture spec. Read in full.
3. `docs/superpowers/plans/2026-04-15-workflow-kernel-build-plan.md` — 23-task Phase 1 plan. Useful for understanding intent where the checkpoint says "deviated from plan."
4. `src/core/` — the kernel itself. Read `index.ts`, `types.ts`, `workflow.ts`, `session.ts`, `stepper.ts`, `pool.ts`, `registry.ts`. These are your primitives.
5. Memory: `MEMORY.md` + referenced files, especially `project_architecture_refactor_arc.md` and `feedback_delegation_style.md`.

The overall refactor has 4 subsystem-sessions; you're in the middle of subsystem B+E. After Phase 2, the next session handles Subsystem A (selector registry).

## Known debt from Phase 1 (must be resolved during Phase 2)

Phase 1 shipped with three documented debt items. Each has a specific gate:

1. **`runWorkflowBatch` sequential mode doesn't wrap each item in `withTrackedWorkflow`.** Fix BEFORE migration #2 (emergency-contact). Otherwise batch runs won't emit per-item tracker events and the dashboard will be silent during batches. This is a kernel fix in `src/core/workflow.ts`, not a migration task. Add a dedicated task in the emergency-contact migration plan, OR do it as a prerequisite before the plan.

2. **`ctx.session.newWindow()` / `closeWindow()` are throw stubs.** Fix BEFORE migration #6 (separations). Check whether separations actually needs dynamic window management — the existing workflow may not, in which case leave the stubs and document that. If it does, implement on `Session` (launch extra browser + store in the `browsers` map, set a `Promise.resolve()` readyPromise).

3. **Tracker values stringified at the adapter — rich types (dates) lose fidelity.** Not a migration blocker but a dashboard quality issue. Fix at your discretion during Phase 2, ideally before migration #3 (eid-lookup) which has Date-heavy tracker data. Investigate `src/tracker/jsonl.ts` for the stringification call site.

## Migration order (do not reorder)

1. **work-study** — 1 system (UCPath), 2 steps, sync. Simplest. Proves the kernel end-to-end. Also moves `src/ucpath/` → `src/systems/ucpath/` with `git mv`.
2. **emergency-contact** — 1 system, sequential batch, `preEmitPending`. Also moves `src/utils/roster-verify.ts` + `src/utils/sharepoint-download.ts` into `src/workflows/emergency-contact/`. Resolve debt item #1 before or during this migration.
3. **eid-lookup** — 1 system, page-per-worker pattern via existing `runWorkerPool` helper. Verify helper still satisfies the need; no kernel change expected. Consider resolving debt item #3 here.
4. **kronos-reports** — worker-per-browser pool (`batch.mode = 'pool'`), persistent `sessionDir`. Also moves `src/old-kronos/` → `src/systems/old-kronos/`.
5. **onboarding** — 3 systems sequential (CRM + UCPath + I9), PDF download side effect, retries. Preserve existing `retryStep` helper. Also moves `src/crm/` → `src/systems/crm/` and `src/i9/` → `src/systems/i9/`.
6. **separations** — 4 systems, interleaved auth, phase parallelism, `betweenItems` hooks. Final boss. Also moves `src/kuali/` → `src/systems/kuali/` and `src/new-kronos/` → `src/systems/new-kronos/`. Resolve debt item #2 before this migration if separations actually needs dynamic window mgmt.

Each migration follows the pattern from the spec's "Per-workflow migration steps" section:
1. Write `src/workflows/<name>/workflow.v2.ts` using `defineWorkflow`.
2. Reuse existing per-system helpers untouched.
3. Dry-run: `npm run <workflow>:dry` against a known input.
4. Real run with user watching.
5. Delete v1, swap CLI entry to v2.
6. Update workflow's CLAUDE.md.
7. Commit + tag `kernel-migration-<workflow>`.

## Your deliverables

- **For each of the 6 migrations:** write a short migration plan at `docs/superpowers/plans/2026-XX-XX-migrate-<workflow>-plan.md` using `superpowers:writing-plans`, then execute it via `superpowers:subagent-driven-development`. One migration at a time. Do NOT batch them into one mega-plan — we want to learn from each before committing to the next.
- **Resolve the 3 debt items at their gates.**
- **At end of Phase 2:** write `docs/superpowers/sessions/03-selector-registry.md` (Session 3 handoff for Subsystem A). Follow the pattern of this file. Include: context on what Phase 2 shipped, user's remaining priorities (A > D > C), instruction to brainstorm fresh (not reuse the rough sketch in the kernel spec), and a pointer to `src/systems/` as the natural home for selectors.

## Constraints

- `npm run typecheck` + `npm test` must stay green after every task.
- Use `git mv` for directory renames. Do renames in dedicated commits (not mixed with refactor).
- Tag each migration: `git tag kernel-migration-<workflow>`.
- No feature flags — each migration is atomic.
- A migration is "done" only after a real run succeeds with the user watching and the old impl file is deleted.
- Follow the project's root `CLAUDE.md` (auto-loaded) and update per-module `CLAUDE.md` files after each migration per the Continuous Improvement Protocol.

## Start here

1. Read the three context docs listed above.
2. Skim the current `src/workflows/work-study/` to understand today's shape.
3. Invoke `superpowers:writing-plans` to produce the work-study migration plan at `docs/superpowers/plans/2026-XX-XX-migrate-work-study-plan.md`.
4. When user approves the plan, invoke `superpowers:subagent-driven-development` and execute.
5. After work-study lands, pause and confirm before proceeding to emergency-contact (which triggers debt item #1).

## Out of scope for this session

- Subsystem A (selector registry) — Session 3
- Subsystem D (dashboard richness) — Session 4
- Subsystem C (CLAUDE.md conventions) — Session 5
- Anything not captured in the spec

Begin.
