# Handoff — Harden emergency-contact
**Date:** 2026-07-01  **Wave:** 1 (parallel; own git worktree + branch `feature/harden-emergency-contact`; requires Wave 0 OCR-orchestrator hardening landed first)

## Task summary
Harden the **emergency-contact** workflow's OWN logic against flakiness, then live-verify end-to-end. It's an OCR-backed UCPath filler (`inputSubject: "name"`): OCR-approved records enqueue daemon rows that navigate UCPath HR Tasks → Personal Data Related → Emergency Contact and add/demote a contact. The dominant risk is **wrong-person writes** — it can silently rewrite the WRONG employee's emergency contacts because it never asserts the loaded record is the intended person before mutating.

**Scope boundary:** OCR is a SHARED service — the OCR orchestrator (`src/workflows/ocr/orchestrator.ts`) is hardened separately in **Wave 0** (`2026-07-01-ocr-orchestrator.md`). This task covers emergency-contact's OWN handler + `enter.ts`, NOT the orchestrator (you inherit Wave-0's fixes).

## Audit findings to fix (the actionable seed)
1. **No identity assertion before mutating a record (wrong-person class).** `src/workflows/emergency-contact/workflow.ts:165-196`: after `navigateToEmergencyContact` it reads the on-page name only for *display* (`extractEmployeeName` → `ctx.updateData({ employeeName })`, best-effort, swallowed) and then proceeds straight into the duplicate guard → `demoteExistingContact` (:206, reached via the fuzzy-match branch at :200) and the add. It **never asserts the loaded record's identity == the intended person BEFORE mutating.** A stale/retained UCPath page or a nav that reopens a prior employee → the demote+add lands on the WRONG employee's emergency contacts. **Fix:** after navigation, assert the extracted name/EID matches `effectiveRecord.employee` (name + EID) and THROW on mismatch, BEFORE the duplicate guard / demote / add. Mirror the pattern separations already uses (`verifyTimecardEmployee`) — that same wrong-person class is already guarded there; copy its shape.
2. **The identity signal is swallowed, so it can't be load-bearing.** `src/workflows/emergency-contact/enter.ts:235-250` `extractEmployeeName` is fully `try/catch`-swallowed and returns nothing on failure (empty name, silent). For the assertion in #1 to have real teeth, this must produce a **trustworthy signal**: return the extracted name/EID (or a clear "could not read identity" that the caller treats as INDETERMINATE → throw/retry, not "proceed"). Don't let a failed read look like "identity is fine." Prefer keying the assertion on the EID shown next to "Person ID" (already parsed in the regex) since EID is the unambiguous key.

## Files / conflict surface
- **Own (edit freely):** `src/workflows/emergency-contact/{workflow,enter}.ts`, `src/workflows/emergency-contact/CLAUDE.md`, tests under `tests/unit/workflows/emergency-contact/`.
- **Shared with the ucpath group:** `src/systems/ucpath/*` (selectors/navigation) — the `separations`, `person-lookup`, `work-study` group also edits ucpath, and `oath-signature` (the other ocr-backed ucpath task) touches it too. **Conflicts on ucpath** are expected; keep ucpath edits minimal and let the orchestrator resolve merges. Prefer putting the identity assertion in emergency-contact's own `enter.ts`/`workflow.ts`, reusing existing ucpath selectors rather than adding new ones.
- **Do NOT edit here:** `src/workflows/ocr/orchestrator.ts` (Wave 0).

## How to start + test data (live-verify)
- **Start path:** upload run via **RunModal** — upload a handwritten Emergency Contact form **PDF (one person per page)** + the roster xlsx (name → EID). Open `:39NN/?wf=emergency-contact`, Run → the EC run modal. Toggle **dryRun ON** — it skips the UCPath emergency-contact **Save** click (walks the form, never commits).
- OCR reviews/approves → daemon enqueues the contact rows → each navigates UCPath and (in dry-run) walks to the Save it skips. Duo clears hands-off. **Read the key screenshot** to confirm the row landed on the RIGHT employee (the whole point of finding #1) — verify the on-page Person ID/name matches the intended person before the (skipped) Save.
- **Test data:** a 1-2 page EC form PDF + a roster whose EIDs resolve in UCPath. To exercise the wrong-person guard, you can (dry-run only) point a record at a mismatched EID and confirm the new assertion THROWS instead of silently writing. Note: employees with zero existing contacts still throw `NoExistingContactError` (Add-New path unimplemented — that's expected, not your bug).

## Shared methodology + gotchas + worktree discipline + current state
See `docs/superpowers/2026-07-01-hardening-campaign-index.md`. Do NOT duplicate it. (It owns: the wave plan, the isolated-tracker + fallback-port live-verify loop, `playwright-cli` headless driving, worktree discipline, the "restart the daemon after every change" rule, the do-not-touch-the-parallel-diff warning, and the standing UCPath gotchas — incl. the `#main_target_win0` iframe + `#pt_modalMask` dismissal.)

## Pointers
- `src/workflows/emergency-contact/CLAUDE.md` — flow, duplicate/demote guard, Add-New-deferred gotcha, Edit-Data opt-in.
- `src/systems/ucpath/LESSONS.md` — UCPath gotchas (iframe, modal mask, person-search); read BEFORE any selector work.
- `src/systems/ucpath/SELECTORS.md` — auto-generated selector catalog (`npm run selector:search "emergency contact"`).
- **Reference the separations wrong-person guard** (`verifyTimecardEmployee`) as the pattern to mirror for the identity assertion.
