# Handoff — Harden shared helpers (ctx.retry + clickIfPresent)

**Date:** 2026-07-01  **Wave:** 0 — cross-cutting, do EARLY (touched implicitly by everything; land on master before Wave 1)

## Task summary

Two shared primitives are used by essentially every workflow and system, so a defect in either shows up as workflow-wide flakiness that the per-workflow sessions would otherwise chase individually. Fix them ONCE here in Wave 0. (1) `ctx.retry` — the kernel's retry wrapper — currently swallows **cancellation** and runs a non-signal-aware backoff sleep, so an operator cancel during a retry-wrapped step doesn't propagate: the step re-runs and stalls for attempts×backoff instead of stopping. (2) `clickIfPresent` in the common safe-actions helper silently resolves `.first()` on an ambiguous locator, turning a strict-mode ambiguity error into a **silent wrong-click** — exactly the failure mode this whole campaign exists to catch. Because these are cross-cutting, land them before the Wave-1 workflow sessions build on top.

## Audit findings to fix (the actionable seed)

- [ ] **`ctx.retry` swallows cancellation + non-signal-aware backoff** (`src/core/kernel/ctx.ts:68-84`). The `catch` retries on **EVERY** error, including `AbortError` / `CancelledError`, and its backoff `sleep` (`node:timers/promises`) is passed **no `ctx.signal`**. Net effect: an operator cancel landing inside a `ctx.retry`-wrapped step is re-run and delayed by `attempts × backoff` instead of propagating. **Fix:** re-throw when `isCancellation(err)` (the pattern `src/systems/common/safe.ts:58` already uses) so cancellation propagates immediately, AND thread `ctx.signal` into the backoff `sleep` so an in-flight backoff aborts on cancel.
- [ ] **`clickIfPresent` silently resolves `.first()` on ambiguous locators** (`src/systems/common/safe.ts:112`). On a multi-match locator it silently clicks `.first()` instead of surfacing Playwright's loud strict-mode error — a **silent WRONG-click**. **Fix:** require a row-unique handle (caller passes an already-narrowed locator) OR fail loud when the locator is ambiguous (assert count, or drop the `.first()` so strict mode throws). Do not paper over ambiguity with `.first()`.
- [ ] **(Optional) Architecture guard discouraging NEW bare `waitForTimeout` in `src/systems`.** The campaign's root cause is fixed sleeps; a guard that flags *new* bare `waitForTimeout(...)` under `src/systems/**` (allowlisting existing ones, or the small set with a justifying comment) keeps the regression from creeping back. Wire it into `npm run test:architecture` if you do it. Skip if it balloons scope — it's a nice-to-have, not the core fix.

## Files / conflict surface

- `src/core/kernel/ctx.ts` (kernel — `ctx.retry`, backoff sleep)
- `src/systems/common/safe.ts` (`clickIfPresent`; `isCancellation` at `:58` is the reference re-throw pattern)
- Optional guard: the architecture-test module + a new rule file.
- **Low direct-conflict risk** (no per-workflow files), but `ctx.ts` and `safe.ts` are imported nearly everywhere — land on master first so Wave-1 sessions build on the fixed helpers rather than re-touching them. Coordinate with the in-flight parallel-work diff noted in the index before committing.

## How to start + test data (code + unit only — not live-startable)

These are library primitives with no dashboard surface of their own, so verify by **unit + architecture tests**, not a dashboard dry-run:

- `npm run typecheck`
- Scoped units: `npx vitest run tests/unit/core/ tests/unit/systems/` — add/extend a test that **pins cancellation propagation** through `ctx.retry` (an `AbortError` mid-retry must reject fast, not retry/sleep) and one that pins **`clickIfPresent` failing loud** on an ambiguous locator (no silent `.first()`).
- `npm run test:architecture` (and if you add the `waitForTimeout` guard, confirm it flags a deliberately-added bare sleep and passes clean otherwise).
- Optional integration confidence: since every workflow uses these, a single onboarding/OCR dry-run after landing is a cheap smoke check that nothing regressed — but the real proof is the pinned unit tests.

## Shared methodology + gotchas + worktree discipline + current state

See `docs/superpowers/2026-07-01-hardening-campaign-index.md` (the campaign index) — reuse its verification loop, gotchas, worktree rules, and current-state notes (esp. **never delete a failing test to get green**, and full `npm run test` may be red from the parallel-work diff — use SCOPED tests). Do NOT duplicate them here.

## Pointers

- `src/core/CLAUDE.md` (kernel API — `ctx`, retry, signal/cancellation semantics)
- `src/systems/CLAUDE.md` (safe-actions patterns, the `isCancellation` re-throw convention, no-bare-`waitForTimeout` guidance)
- `src/systems/common/safe.ts:58` — the existing correct cancellation re-throw to mirror in `ctx.retry`
