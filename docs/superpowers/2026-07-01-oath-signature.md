# Handoff — Harden oath-signature
**Date:** 2026-07-01  **Wave:** 1 (parallel; own git worktree + branch `feature/harden-oath-signature`; requires Wave 0 OCR-orchestrator hardening landed first)

## Task summary
Harden the **oath-signature** workflow's OWN logic against flakiness, then live-verify end-to-end. EID-only (`inputSubject: "eid"`, `code: "os"`, `archetype: "single"` rendered as a batch): searches UCPath Person Profile by Empl ID and adds an **Oath Signature Date** row. Two flaky spots, both silent-wrong-outcome: (a) it adds the oath without confirming the loaded profile is actually that EID's, and (b) a failed idempotency probe is misread as "already has an oath" → it drops a real signature.

**Scope boundary:** OCR is a SHARED service — the OCR orchestrator (`src/workflows/ocr/orchestrator.ts`) is hardened separately in **Wave 0** (`2026-07-01-ocr-orchestrator.md`). This task covers oath-signature's OWN `enter.ts` + handler, NOT the orchestrator (you inherit Wave-0's fixes). The paper-roster PDF prep is owned by OCR; oath-signature just consumes the per-EID signer rows OCR fans out.

## Audit findings to fix (the actionable seed)
1. **No profile-identity assertion before add+save (wrong-person class).** `src/workflows/oath-signature/enter.ts:100-104` (`searchByEmplId`): after the search it trusts "EID is unique so this lands directly on the profile" and proceeds to add the oath with **no assertion the rendered profile is actually `emplId`'s.** In daemon/batch mode a retained prior Person-Profile page (Return-to-Search didn't fire, or direct nav reopened the prior detail page — both are documented UCPath quirks) means the oath is added to the WRONG person. **Fix:** verify the rendered profile's EID (or name) equals the intended `emplId` BEFORE `clickAddNewOath` + save; throw on mismatch. `extractEmployeeName` (`enter.ts:126-141`) already reads the profile name — make it (or an EID readback) load-bearing for this check instead of display-only.
2. **A failed idempotency probe silently drops a real signature.** `src/workflows/oath-signature/enter.ts:151-163` (`probeExistingOath`): it does `noOathSentinel.isVisible({ timeout: 3000 }).catch(() => false)` then `alreadyHasOath = !sentinelVisible`. So a slow/transient page that simply **fails to render the sentinel in 3s** flips `alreadyHasOath` to `true` → the handler SKIPS add+save and marks **"Skipped (Existing Oath)"** when no oath actually exists — a real signature is silently dropped. **Fix:** treat the probe timeout as **INDETERMINATE**, not "already has oath." Distinguish three outcomes: sentinel present (safe to add) / an actual existing-oath row detected (genuinely skip) / probe couldn't determine (retry the read, and throw if still indeterminate) — never infer "already has oath" from a failed/absent-sentinel read alone.

## Files / conflict surface
- **Own (edit freely):** `src/workflows/oath-signature/{enter,handler}.ts` (+ `workflow.ts` if needed), `src/workflows/oath-signature/CLAUDE.md`, tests under `tests/unit/workflows/oath-signature/`.
- **Shared with the ucpath group:** `src/systems/ucpath/*` — `separations`/`person-lookup`/`work-study` + `emergency-contact` (the other ocr-backed ucpath task) also touch ucpath. **Conflicts on ucpath** are expected; keep ucpath edits minimal and let the orchestrator resolve merges. Prefer the fixes inside oath-signature's own `enter.ts`, reusing the `oathSignature` selector group.
- **Do NOT edit here:** `src/workflows/ocr/orchestrator.ts` (Wave 0).

## How to start + test data (live-verify)
- **⚠ Use the PDF UPLOAD run to live-verify, NOT the typed-EID input run.** The typed-EID **input run has NO dry-run UI toggle**, so it would attempt a REAL UCPath Save. The PDF **UPLOAD run** (RunModal: oath roster PDF + roster xlsx, `targetWorkflow="oath-signature"`) HAS the **dryRun toggle** (skips the UCPath Save click). Open `:39NN/?wf=oath-signature`, Run → the oath run modal, upload the roster PDF + xlsx, toggle **dryRun ON**.
- OCR reviews/approves → fans out one signer row per approved EID → each searches the profile and (dry-run) walks to the Save it skips. An oath-signature PDF run files **no** ServiceNow ticket. Duo clears hands-off. **Read the key screenshot** — confirm it's on the RIGHT person's PROFILE with the oath row staged (finding #1), not the empty search form (a recently-fixed bug — audit screenshots must land on the profile).
- **Test data:** a small oath roster PDF + roster xlsx. To exercise finding #2, an EID whose page is slow to render the sentinel should now retry/throw rather than false-skip. Note the recent live-verified EID 10618178 / Lisette Ochoa already had an oath (→ skip path), so the ADD path's date+staged/saved shots are NOT yet fully live-exercised — try to pick an EID WITHOUT an existing oath so you actually walk add → stage → (skipped) save.

## Shared methodology + gotchas + worktree discipline + current state
See `docs/superpowers/2026-07-01-hardening-campaign-index.md`. Do NOT duplicate it. (It owns: the wave plan, the isolated-tracker + fallback-port live-verify loop, `playwright-cli` headless driving, worktree discipline, the "restart the daemon after every change" rule, the do-not-touch-the-parallel-diff warning, and the standing UCPath gotchas.)

## Pointers
- `src/workflows/oath-signature/CLAUDE.md` — UCPath rules (Person Profile uses `#ptifrmtgtframe`, clear the search box each item, Return-to-Search recovery, duplicate accessible names on the Add link) + the 2026-07-01 selector re-anchor lesson (name/date/screenshot bugs).
- `src/systems/ucpath/LESSONS.md` — UCPath gotchas; read BEFORE any selector work.
- `src/systems/ucpath/SELECTORS.md` — `oathSignature` selector group (`npm run selector:search "oath"`).
