# Session 2 — Phase 1 Checkpoint: Kernel Build Complete

**Date:** 2026-04-15
**Tag:** `kernel-build-complete`
**Status:** Phase 1 done. Phase 2 (workflow migrations) has not started.

## What shipped (Tasks 0–23 of the build plan)

`src/core/` now contains a self-contained workflow kernel:

- `types.ts` — `SystemConfig`, `BatchConfig`, `WorkflowConfig`, `Ctx`, `SessionHandle`, `WorkflowMetadata`, `RegisteredWorkflow`, `BatchResult`, `RunOpts`.
- `registry.ts` — module-level `Map<string, WorkflowMetadata>` with `register`/`getAll`/`getByName`/`clear`.
- `session.ts` — `Session` class: parallel browser launch, sequential + interleaved auth chains, `page()`/`reset()`/`healthCheck()`/`killChrome()`/`close()`. `SystemSlot.browser` is `Browser | null` to accommodate `launchBrowser`'s persistent-session return shape (sanctioned plan correction).
- `stepper.ts` — `Stepper` class: `step()` emits tracker events and classifies errors, `updateData()` shallow-merges, `parallel()` returns `PromiseSettledResult` per key.
- `workflow.ts` — `defineWorkflow()`, `runWorkflow()`, `runWorkflowBatch()`. Wires Session + Stepper + `withTrackedWorkflow` + `withLogContext`. Installs a SIGINT handler for clean teardown (redundant with tracker's own handler in real-run mode; essential in `trackerStub` mode).
- `pool.ts` — `runWorkflowPool()`: worker-per-browser pool with shared queue.
- `page-health.ts` — moved from `src/utils/` (Task 17).
- `index.ts` — barrel export.

Total: 673 lines (spec budget ≤ 800).

Frontend:

- `src/dashboard/workflows-context.tsx` — `WorkflowsProvider` + `useWorkflows()` + `useWorkflow(name)` hooks, fetching `/api/workflow-definitions`.
- `src/dashboard/main.tsx` — app root wrapped in the provider.
- `src/dashboard/components/LogPanel.tsx` — now sources step pipeline from the registry (with `WF_CONFIG` fallback).

Backend:

- `src/tracker/dashboard.ts` — new `GET /api/workflow-definitions` route + exported `buildWorkflowsHandler()` for testability.

Deleted:

- `src/browser/session.ts` — unused `WorkflowSession` class.
- `src/utils/page-health.ts` — moved to `src/core/`.

Tests:

- `tests/unit/core/registry.test.ts`
- `tests/unit/core/session.test.ts`
- `tests/unit/core/stepper.test.ts`
- `tests/unit/core/workflow.test.ts`
- `tests/unit/core/batch.test.ts`
- `tests/unit/core/pool.test.ts`
- `tests/unit/tracker/workflows-endpoint.test.ts`
- `tests/integration/core/mock-workflow.test.ts`

Full suite: **160/160 passing**. Typecheck clean (both `npm run typecheck` and `npm run typecheck:all`). `npm run build:dashboard` succeeds.

## Deviations from the plan (with reasons)

1. **`SystemSlot.browser: Browser | null`** (Task 5). Plan had non-null. Necessary because `src/browser/launch.ts` returns `browser: null` in persistent-session mode, which UKG/Kronos needs. `close()` and `killChrome()` null-guard accordingly.
2. **`updateData` signature** (Task 1 fix commit). Plan had `Partial<TData> & Record<string, unknown>`. Spec has `Partial<TData & Record<string, unknown>>`. Followed the spec — the difference is semantically real for enrichment-patch typing. Committed as 1831567.
3. **SSE endpoint URL** (Task 19). Plan had `/api/workflows`. That URL was already in use returning a filesystem-based `string[]`. Renamed the new registry-backed endpoint to `/api/workflow-definitions`. Existing endpoint is untouched.
4. **Task 21 scope** (WF_CONFIG swap). Plan implied full `WF_CONFIG` elimination. The frontend `WF_CONFIG` holds UI-specific fields the registry doesn't expose (`label`, `getName`, `getId`, labeled `detailFields`). Only `steps` were swapped (in `LogPanel.tsx`). Full elimination is deferred to Session 4 (dashboard richness) once `defineWorkflow` gains declarative UI metadata.
5. **Task 11 tracker wiring** (`withTrackedWorkflow` invocation). Plan code used wrong signature (3-arg fn, options bag). Corrected to actual 5-positional signature with 4-arg fn `(setStep, updateData, onCleanup, session)` and `preAssignedRunId` as 5th positional. Also added a `Record<string, unknown>` → `Record<string, string>` adapter for `emitData` since the tracker only accepts string values.

## Commits (tail of master)

```
93a4e2e test(core): end-to-end integration test for kernel with mock workflow
651db21 refactor(dashboard): source LogPanel steps from registry via useWorkflow
4086481 feat(dashboard): add WorkflowsProvider that fetches /api/workflow-definitions
b2d1d98 feat(tracker): expose registered workflow metadata at /api/workflow-definitions
844880e refactor(browser): remove unused WorkflowSession class
571c94e chore: gitignore .tracker-log-test
dfd5e46 chore: gitignore .tracker-log-test and remove accidentally committed artifacts
388fb85 refactor(core): move page-health from utils to core
cdbcd14 feat(core): export full public API from barrel
bfc60df feat(core): runWorkflowPool for worker-per-browser batch mode
aee7f22 feat(core): preEmitPending invokes callback for each item upfront
4869133 feat(core): runWorkflowBatch sequential mode with betweenItems hooks
6d5648e feat(core): runWorkflow installs SIGINT handler for clean teardown
2af1ee2 feat(core): runWorkflow wires Session + Stepper + tracker
49e9333 feat(core): defineWorkflow registers metadata with typed steps
776dfaf feat(core): Stepper.parallel returns PromiseSettledResult per key
d74118f feat(core): Stepper with step/updateData and error classification
8c5ce79 feat(core): Session.reset, healthCheck, killChrome
a48455f feat(core): Session.launch with interleaved auth chain
f780376 feat(core): Session.launch with sequential auth chain
feef114 feat(core): add Session.page() lazy accessor
235f9d2 feat(core): add Session class skeleton with test factory
1581f73 feat(core): add workflow metadata registry
1831567 fix(core): align updateData signature with spec (Partial of intersection)
3b791e3 feat(core): add shared types for workflow kernel
4035789 feat(core): scaffold src/core/ directory
```

Tag: `kernel-build-complete`.

## Known gotchas to watch during Phase 2 migrations

1. **Tracker's `updateData` only accepts `Record<string, string>`.** The kernel's `emitData` adapter stringifies values. Workflow handlers calling `ctx.updateData({ someDate: dateObj })` will have the date converted to `String(dateObj)` — verify this produces a usable display in the dashboard. If workflows need rich types, extend the tracker signature later.
2. **Two SIGINT handlers register during real runs** (tracker's + kernel's). Tracker's fires first and exits, so the kernel's handler is a no-op except when `trackerStub: true`. Acceptable.
3. **Dashboard `WF_CONFIG` still required for `label`, `getName`, `getId`, labeled `detailFields`.** Every new workflow must still update `src/dashboard/components/types.ts`. This is the known debt that Session 4 resolves.
4. **`ctx.session.newWindow()` / `closeWindow()` throw.** Not yet implemented. Separations workflow likely needs these (5th browser window). Implement in `session.ts` when the separations migration needs them.
5. **`runWorkflowBatch` sequential mode** doesn't call `withTrackedWorkflow` per item. Each item's handler runs without tracker-level emissions (only step-level via Stepper). Batch-mode workflows (emergency-contact, kronos-reports) will need per-item tracker integration during migration — this is the "we'll build it when we migrate the first batch workflow" gap acknowledged in the plan.
6. **Validation error messages** always start with `validation error:` — downstream code depending on ZodError's specific format needs updating.

## Next session: Phase 2 — workflow migrations

Migration order (per spec):

1. **work-study** — simplest (1 system, 2 steps). Proves the kernel for a trivial case. Moves `src/ucpath/` → `src/systems/ucpath/`.
2. **emergency-contact** — sequential batch, `preEmitPending`. Moves `src/utils/roster-verify.ts` and `src/utils/sharepoint-download.ts` into `src/workflows/emergency-contact/`.
3. **eid-lookup** — page-per-worker pattern (escape hatch helper).
4. **kronos-reports** — worker-per-browser pool, persistent `sessionDir`. Moves `src/old-kronos/` → `src/systems/old-kronos/`.
5. **onboarding** — 3 systems sequential. Moves `src/crm/` → `src/systems/crm/` and `src/i9/` → `src/systems/i9/`.
6. **separations** — 4 systems, interleaved auth, phase parallelism. Moves `src/kuali/` → `src/systems/kuali/` and `src/new-kronos/` → `src/systems/new-kronos/`.

For each migration:
1. Write a short plan at `docs/superpowers/plans/2026-XX-XX-migrate-<workflow>-plan.md` via `superpowers:writing-plans`.
2. Execute via `superpowers:subagent-driven-development`.
3. Migration is done only after: `npm run typecheck` clean, tests pass, old implementation file deleted, real run succeeds (user watching, dashboard verified).
4. Tag `kernel-migration-<workflow>`.

## Resuming after a break

Paste this file's path into the next conversation plus the prompt at `docs/superpowers/sessions/02-kernel-execution.md`. The git history + `kernel-build-complete` tag + this checkpoint should be enough to continue.
