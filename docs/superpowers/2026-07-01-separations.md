# Handoff — Harden separations

**Date:** 2026-07-01  **Wave:** 1 (parallel; own git worktree + branch `feature/harden-separations`)

## Task summary

Separations drives a UCPath termination transaction + Kuali Build termination doc finalization (with a Kronos timekeeper step) to off-board an employee. It is the **most-hardened workflow already**, so the goal here is narrow: **triage the audit's real-vs-intended findings FIRST**, then close the one genuine reliability gap so a Kuali doc can't be finalized missing a required field. Motivation: a silently-skipped field fill leaves a finalized separation doc that looks complete but isn't.

## Audit findings to fix (the actionable seed)

- [ ] **TRIAGE FIRST — the "blank-txn Kuali save" is INTENDED, not a bug.** The audit flagged a blank-transaction Kuali save; that is deliberate: it preps the Kuali doc blank for manual entry and then *fails the run on purpose*. See `src/workflows/separations/CLAUDE.md` (2026-06-18 lesson). **Do not "fix" this** — confirm the behavior matches that lesson and move on.
- [ ] **REAL GAP — timekeeper-name fill failure on the kronos-skip path is only `log.warn`'d** (`src/workflows/separations/workflow.ts:~833`). When the fill fails, the run continues and the Kuali doc can be **finalized missing a required field** (`TIMEKEEPER_NAME`). Fix: **verify the field's value post-fill and either fail the step or hard-block finalization** if the timekeeper name didn't land. A `log.warn` is not sufficient for a required field.
- [ ] After the fix, apply the campaign's wait-for-target-then-assert discipline to the timekeeper fill so the assertion isn't racing the PeopleSoft/Kuali reload.

## Files / conflict surface

Touches `src/systems/kuali`, `src/systems/ucpath`, `src/systems/new-kronos`, and `src/workflows/separations/`.

- **Conflicts with `person-lookup` and `work-study`** on `src/systems/ucpath/*` (Group ucpath — the three UCPath workflows overlap; ideally serialize, or run in worktrees and let the orchestrator resolve merges).
- **Conflicts with `kronos`** on `src/systems/new-kronos/*`.
- Keep edits scoped to the timekeeper-verify path; avoid broad UCPath selector churn that would widen the merge surface for the other two ucpath-group workflows.

## How to start + test data (live-verify)

- Launch from the **dashboard INPUT run** (`InputRunPanel`): enter **Kuali doc id(s), comma-separated**. Toggle the run-settings **dry-run** switch ON (this workflow declares `supportsDryRun`; dry-run = no UCPath transaction, no Kuali finalization — the safety boundary).
- **Test data:** at least one **Kuali Build termination doc id** (a real termination doc the operator can point at). More than one exercises the comma-separated multi-doc path.
- Dry-run keeps it safe end-to-end; confirm from the isolated tracker log + the key screenshot that the timekeeper field actually received the value (that's the whole point of this fix).

## Shared methodology + gotchas + worktree discipline + current state

See `docs/superpowers/2026-07-01-hardening-campaign-index.md` (the campaign index) — reuse its live-verify loop, gotchas, and worktree rules. Do NOT duplicate them here.

## Pointers

- `src/workflows/separations/CLAUDE.md` (esp. the 2026-06-18 blank-txn-is-intended lesson)
- `src/systems/kuali/LESSONS.md`, `src/systems/ucpath/LESSONS.md`, `src/systems/new-kronos/LESSONS.md`
