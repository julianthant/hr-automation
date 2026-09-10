# Handoff — Harden work-study

**Date:** 2026-07-01  **Wave:** 1 (parallel; own git worktree + branch `feature/harden-work-study`)

## Task summary

Work-study updates an employee's position pool + compensation data in UCPath PayPath Actions for a work-study award. The hardening goal is **navigation reliability**: replace the bare, un-retried page navigation and apply the campaign's wait-for-target-then-assert pattern so a slow PeopleSoft load doesn't fail or mis-drive the update. Motivation: PayPath nav is exactly the kind of step that flakes under iframe-reload timing.

## Audit findings to fix (the actionable seed)

- [ ] **Bare un-retried navigation** — `src/workflows/work-study/enter.ts:36` uses a raw `page.goto` with no retry → **route it through `gotoWithRetry`** (same helper the other UCPath workflows use).
- [ ] **Apply wait-for-target-then-assert to the update steps** — after each PayPath navigation/action, wait for the concrete target element and assert it before proceeding, rather than fixed 3-5s sleeps.

## ⚠ Not dashboard-startable today — pick a live-verify strategy

This workflow has **no input-run surface**: its `CLAUDE.md` states "no public start path until a dashboard input run is added" (the `npm run work-study` script was retired 2026-05-25). So live-verify requires a decision — **state which you chose in your handoff/commit**:

- **Option A — add a minimal input-run surface** so you can drive it from the dashboard and live-verify end-to-end. Schema = `emplId` (5+ digits) + `effectiveDate` (`MM/DD/YYYY`). Wire per `src/workflows/CLAUDE.md` (`DASHBOARD_INPUT_RUN_WORKFLOWS` + `src/dashboard/lib/input-run-registry.ts` + `src/core/workflow-loaders.ts`). Then follow the standard live-verify loop.
- **Option B — code-harden + unit-test only** (no dashboard surface added): make the `gotoWithRetry` / wait-then-assert changes and cover them with scoped unit tests, since there's no operator start path to drive live.

## Files / conflict surface

Touches `src/systems/ucpath` and `src/workflows/work-study/`.

- **Conflicts on `src/systems/ucpath/*`** with `separations` and `person-lookup` (Group ucpath — serialize or let the orchestrator resolve merges). Keep the `gotoWithRetry` swap scoped so it doesn't collide with their UCPath edits.

## Shared methodology + gotchas + worktree discipline + current state

See `docs/superpowers/2026-07-01-hardening-campaign-index.md` (the campaign index) — reuse its live-verify loop, gotchas, and worktree rules. Do NOT duplicate them here.

## Pointers

- `src/workflows/work-study/CLAUDE.md`
- `src/systems/ucpath/LESSONS.md`
