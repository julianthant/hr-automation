# Handoff — Harden OCR orchestrator

**Date:** 2026-07-01  **Wave:** 0 — cross-cutting, do FIRST (land on master before Wave 1 fans out)

## Task summary

The OCR orchestrator (`src/workflows/ocr/orchestrator.ts`) is the shared prep-and-review engine behind every OCR-backed operation: **emergency-contact + oath-signature + onbase + oath-upload** all funnel through it (upload → per-page OCR read → identity/second-opinion re-read → person-lookup enrich → `awaiting-approval` → approve fan-out). **Harden it ONCE here and all four downstream workflows inherit the fix** — that's why it's Wave 0 and must land on master before the OCR-backed group (`emergency-contact`, `oath-signature`, `onbase`, `oath-upload`) starts. The through-line: today the orchestrator lets bad/partial/mis-identified records advance to approval instead of stopping — a bad page can reach `awaiting-approval`/`done` and then fan out a wrong person. Fix = gate the terminal emit on real completeness + a positive identity match, and surface (don't swallow) the failures that funnel bad state forward.

## Audit findings to fix (the actionable seed)

- [ ] **Gate the terminal emit on person-lookup completion** (`orchestrator.ts:1384`, `:1362`, `:1185`). The `done`/`awaiting-approval` transition can fire before lookup enrichment has actually resolved for every record. Only emit terminal once lookup has completed (or explicitly flagged the record `needsReview`).
- [ ] **Gate the terminal emit on zero-usable-records** (`:651-664`). `failedPages` is computed but **never gates progression** — an all-pages-failed PDF still reaches `awaiting-approval`/`done`. Fail the run (or hold it non-terminal) when there are **no usable records**; do not present an empty/all-failed prep as ready to approve.
- [ ] **Require a POSITIVE identity match before adopting the second-opinion re-read** (`:749-757`). The re-read re-anchors via `rowIndex ?? 0`, so on a **multi-record page** it can swap a DIFFERENT person's name/EID into a slot that approval then fans out. Only adopt the second-opinion values when they positively match the record's own identity (name/EID), not by positional fallback.
- [ ] **Surface swallowed LLM-disambiguation + lookup-suggestion failures onto the record** (`:814-817` → returns `{eid:null,confidence:0}`; `:877-879` lookup-suggestion). Today these silently degrade and the run proceeds. Instead mark the record `needsReview` (with cause) so the operator sees it — don't proceed silently on a null/zero-confidence identity.
- [ ] **`readPreviousRecords` swallows JSON parse errors** (`:1480-1484`, consumed at `:772-777`) — a corrupt/partial carry-forward file silently drops the operator's carry-forward **corrections**. At minimum `log.warn` (structured) so a dropped correction is visible; don't fail-open silently.
- [ ] **Wrap the debounced emit against the off-stack discard throw** (`:1371` `setTimeout(…250ms)` → `:396` `createOperatorDiscardError`). A discard landing inside that 250ms window throws off-stack and can crash the in-process prep. Guard the debounced emit so a discard during the window resolves cleanly instead of crashing.
- [ ] **Bounded retry on `loadRosterFn`** (`:518-519`) — a network-mount read with no retry today. Wrap it in the shared bounded-retry (mirror `gotoWithRetry`/`ctx.retry` semantics) so a transient mount hiccup doesn't fail an otherwise-good prep.

## Files / conflict surface

- Primary: `src/workflows/ocr/` (esp. `orchestrator.ts`); read-only reference into `src/services/ocr/`.
- **Cross-cutting:** this is the shared engine for `emergency-contact`, `oath-signature`, `onbase`, `oath-upload`. Land it on master before any of those Wave-1 sessions start so they don't re-diverge the orchestrator. Keep edits inside `src/workflows/ocr/` — do NOT reach into the four consumer workflows here (they harden their own `enter.ts`/`workflow.ts` in Wave 1).
- No system-file (`src/systems/*`) edits expected, so no conflict with the ucpath/kronos/i9 groups.

## How to start + test data (live-verify)

- **Live-startable:** a **standalone OCR upload run** via the dashboard `RunModal` (formType `oath` / `ec` / `verify`). Boot the isolated dashboard, open the OCR upload panel, pick a multi-page test PDF, Run.
- **Cover the multi-record page case explicitly** — a single page carrying **2+ people** is what exercises the `rowIndex ?? 0` second-opinion swap; verify from the isolated tracker log + the review screenshot that each slot kept the RIGHT name/EID.
- **Confirm the downstream approve fan-out**: after prep reaches `awaiting-approval`, approve and confirm the fan-out enqueues the correct downstream rows (operation-member per person). A standalone OCR run has no approve flow of its own — use one routed through an operation intent (`oath` → oath-signature, `ec` → emergency-contact) to see the fan-out.
- **Negative cases to force:** an **all-pages-fail** PDF (should NOT reach `awaiting-approval`), and a **null-identity** record (should land `needsReview`, not proceed).

## Shared methodology + gotchas + worktree discipline + current state

See `docs/superpowers/2026-07-01-hardening-campaign-index.md` (the campaign index) — reuse its live-verify loop, gotchas, worktree rules, and current-state notes. Do NOT duplicate them here.

## Pointers

- `src/workflows/ocr/` (orchestrator + panel), `src/services/ocr/` (the OCR service — a SERVICE, not oath-upload's partner; don't re-group them)
- Root `CLAUDE.md` — the **OCR / operation** sections (operation coordinator vs operation-member, `approveTo` fan-out, `operationWorkflow` intent routing)
- Consumer CLAUDE.md for context on what inherits this fix: `src/workflows/{emergency-contact,oath-signature,onbase,oath-upload}/CLAUDE.md`
