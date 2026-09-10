# Handoff — Harden person-lookup

**Date:** 2026-07-01  **Wave:** 1 (parallel; own git worktree + branch `feature/harden-person-lookup`)

## Task summary

Person-lookup is the merged operator-facing lookup (formerly EID Lookup + Active Check): it searches CRM/Salesforce + UCPath for a person and flows their identity/EID downstream. The hardening goal is **correctness of identity matching** — the audit found several places where the workflow can silently return the **wrong person's** record. Motivation: a mis-matched EID here poisons every downstream workflow that consumes it.

## Audit findings to fix (the actionable seed)

- [ ] **Over-broad results-grid locator** — `src/systems/crm/selectors.ts:18` uses `page.locator("table tbody tr")`, which matches **every** table on the Salesforce page → can select a row from the wrong table/grid. Fix: **scope the results grid by a stable id/role** so only the search-results table's rows are matched.
- [ ] **Opened record is never confirmed to match the query** — `src/systems/crm/search.ts:53,67,86,91` opens a record without asserting it corresponds to the searched person, so a **different employee's data flows downstream**. Fix: after opening, **assert the opened record's id/name matches the query** before reading anything off it.
- [ ] **`matchCrmEid` ±7-day date fallback is too loose** — `src/workflows/person-lookup/workflow.ts:226` returns a CRM-matched EID when **any** `firstDayOfService` is within ±7 days of **any** SDCMP row's date → two people who started the same week collide. Fix: **require name/EID corroboration** in addition to the date proximity before accepting the match.

## Files / conflict surface

Touches `src/systems/crm`, `src/systems/ucpath`, and `src/workflows/person-lookup/`.

- **Conflicts on `src/systems/ucpath/*`** with `separations` and `work-study` (Group ucpath — serialize or resolve merges in the orchestrator).
- **Conflicts on `src/systems/crm/*`** with any other CRM-touching workflow in flight (e.g. crm-doc-download) — keep the selector/scoping edits tight.

## How to start + test data (live-verify)

- Launch from the **dashboard INPUT run** (`InputRunPanel`): enter **EIDs or names, SEMICOLON-separated** (semicolons, not commas — names contain commas, e.g. `Last, First`).
- **Read-only lookup — there is NO dryRun toggle** (nothing is written; safe to run live as-is).
- **Test data:** EIDs in `10######` 8-digit form and/or `"Last, First"` names. Include at least one pair that would previously have triggered the loose ±7-day match (two people who started the same week) if you can, to prove the corroboration fix.
- Note some CRM test records lack SSN/DOB (see index gotchas); UCPath person-search needs one of them.

## Shared methodology + gotchas + worktree discipline + current state

See `docs/superpowers/2026-07-01-hardening-campaign-index.md` (the campaign index) — reuse its live-verify loop, gotchas, and worktree rules. Do NOT duplicate them here.

## Pointers

- `src/workflows/person-lookup/CLAUDE.md`
- `src/systems/crm/LESSONS.md`, `src/systems/ucpath/LESSONS.md`
