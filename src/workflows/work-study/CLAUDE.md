# Work-Study Workflow

Updates the employee position pool for work-study awards in UCPath PayPath Actions.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflow`. The kernel owns browser launch, UCPath auth, tracker emission, SIGINT cleanup. The handler is a two-step pipeline (`ucpath-auth` → `transaction`) over a single UCPath browser.

**Dashboard input.** In Work Study, enter an EID followed by an effective date. Separate multiple pairs with commas. The dashboard normalizes single-digit months and days to `MM/DD/YYYY`, and the shared schema validates the calendar date. To preview the filled form, turn on **Dry run** in Run settings. A dry run captures all three tabs, checks that Save and Submit is enabled, and stops before clicking it.

## Selector intelligence

This workflow touches one system: **ucpath**.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"paypath position pool"`, `"comp rate"`, `"action plan"`).
- Per-system lessons (read before re-mapping): [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- Per-system catalog (auto-generated): [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)

## Gotchas

- Position Pool hardcoded to `"F"`, Position Change Reason to `"JRL"`
- Comments template: `"Updated pool id to F per work study award {effectiveDate}"`
- Employee name extracted from PeopleSoft header (multiple selector variants)
- Sidebar must be auto-collapsed to prevent click interception on iframe buttons
- 3-5 second waits required after PeopleSoft iframe reloads
- PeopleSoft alerts (payroll-in-progress warnings) are auto-dismissed
- Uses `getContentFrame()` for all iframe interactions — same pattern as onboarding

## Retry safety

**Known idempotency gap (workflow bug — not a kernel concern).** Contract 2 makes retry a uniform kernel behavior: the kernel re-runs the handler from step 0 with the pristine original input. The `transaction` step's PayPath submit has no live-page dupe probe (already called out in the 2026-04-23 lesson below), so a retry on a successfully-submitted PayPath transaction can re-submit it.

The fix lives in this workflow, not the kernel: scan the Smart HR Transactions list for an existing pending/in-flight transaction for this `(emplId, effectiveDate)` before submitting. Pattern reference: separations' `findExistingTerminationTransaction` (in `src/workflows/separations/`).

Until that probe lands, operators retrying work-study are responsible for confirming PayPath doesn't already have a pending transaction for the EID/date before clicking Retry. The kernel does not gate this — no `supportsRetry` flag, no "not retryable" error; idempotency belongs in the workflow.

## Lessons Learned

- **2026-07-08: Repeated timeout literals in `enter.ts` now use named `TIMEOUTS` entries (no behavior change).** The repeated `15_000`/`10_000`/`5_000`/`2_000` inline Playwright timeouts were replaced with `TIMEOUTS.navigation`/`TIMEOUTS.normal`/`TIMEOUTS.fast`/`TIMEOUTS.uiSettle` (`src/config.ts`) — same values, named once. `navigation`/`normal`/`fast` already existed (previously unused anywhere in `src/`); `uiSettle` (2s post-click/dismiss settle pause) is new. Genuine one-off literals (`3_000`, `20_000`, `1_000`) were left as-is — this pass only named REPEATED literals.
- **2026-05-16: Deleted `tracker.ts` (Excel writer).** Convention violation per `src/workflows/CLAUDE.md` — kernel JSONL + dashboard are the only observability. The two `updateWorkStudyTracker` call sites in `workflow.ts` (success-path handler and `runWorkStudy` failure-path catch) were removed along with the file. The `runWorkStudy` catch block now just logs + rethrows.
- **2026-05-25: Retired the public CLI start.** `npm run work-study` was removed in the switch to dashboard launches.
- **2026-04-23: Removed tracker-side idempotency cache.** `src/core/idempotency.ts` (hashKey / hasRecentlySucceeded / recordSuccess) was deleted across the repo. The `transaction` step no longer short-circuits on a hashed-key match — re-running the same `{emplId, effectiveDate}` after a crash WILL attempt to re-submit the PayPath transaction. No live-page probe exists for work-study yet; if duplicate submits become a problem in practice, the replacement pattern is a pre-submit scan (see separations' `findExistingTerminationTransaction` against the Smart HR Transactions list).
- **2026-04-15: Migrated to kernel.** `runWorkStudy` is now a thin wrapper over `runWorkflow(workStudyWorkflow, input)`. Do not reintroduce raw `launchBrowser` / `withTrackedWorkflow` calls in the handler — those live in `src/core/`.
