# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches both Old & New Kronos for timesheets, creates UCPath termination transaction, fetches job summary, and fills Kuali finalization fields.

## Files

- `config.ts` — URLs (Kuali, Kronos), template IDs (`UC_VOL_TERM`, `UC_INVOL_TERM`), screen dimensions for tiling 4 windows (2560x1440)
- `schema.ts` — `SeparationData` Zod schema; helpers: `computeTerminationEffDate` (+1 day), `buildTerminationComments`, `mapReasonCode` (Kuali → UCPath), `getInitials`, `buildDateChangeComments`
- `workflow.ts` — Main orchestration: uses `withTrackedWorkflow` for dashboard tracking (steps: launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization), launches 4 tiled browsers, staggered Duo auth, parallel extraction/search with `Promise.allSettled`, fills UCPath + Kuali forms
- `run.ts` — CLI entry point: `runSeparation(docId, { keepOpen: true })`, supports batch mode with multiple doc IDs (pre-emits pending for all, processes sequentially with shared browsers)
- `explore-kronos.ts` — Interactive exploration script for selector discovery (launches Kronos browsers, pauses for Playwright Inspector)
- `index.ts` — Barrel exports

## Data Flow

```
CLI: docId (Kuali document number)
  → Launch 4 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath)
  → Authenticate all (staggered Duo MFA)
  → Extract termination data from Kuali form
  → Compute termination effective date (separation date + 1 day)
  → Parallel (4 windows): Old Kronos timecard + New Kronos timecard
                          + UCPath Job Summary + Kuali timekeeper fill
  → Resolve Kronos dates, fill remaining Kuali fields (term date, dept, payroll)
  → UCPath termination transaction
  → Kuali finalization (transaction number, save)
  → Return SeparationData
```

## 4-Browser Tiling Layout

```
Row 1: [ Kuali ] [ Old Kronos ]
Row 2: [ New Kronos ] [ UCPath ]
```

Screen: 2560x1440, windows positioned via Chromium `--window-position` and `--window-size` args.

## Gotchas

- **4 Duo authentications** — must be done one at a time (sequential), not parallel. Uses auth-ready promises so each browser starts work as soon as its own Duo clears (see root CLAUDE.md "Multi-Browser Parallel Execution" section)
- Persistent UKG session dir: `C:\Users\juzaw\ukg_session_sep`
- Termination effective date = separation date + 1 day (computed, not from form)
- Voluntary vs Involuntary: determined by `isVoluntaryTermination()` — "Never Started Employment" and "Graduated/No longer a Student" are involuntary, everything else voluntary
- Reason code mapping: exact match → fuzzy match → fallback. VOL_TERM uses "Resign - ..." codes; INVOL_TERM uses "No Longer Student" etc.
- Template selection: `UC_VOL_TERM` (voluntary) or `UC_INVOL_TERM` (involuntary)
- Kuali drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}`
- Comments auto-generated with termination eff date, last day worked, and Kuali form #
- `Promise.allSettled` used so one system failure doesn't block others
- `explore-kronos.ts` is a dev tool, not a production workflow
- **Kronos date range** — `computeKronosDateRange` uses ±1 month (not ±2 weeks) to catch timecards that fall outside narrow windows
- **setMonth overflow on 31-day boundaries** — `computeKronosDateRange` calls `Date.setMonth()` which normalizes invalid days forward (e.g. 03/31 − 1mo targets Feb 31 → Mar 3). This slightly under-expands the window on 31st-day inputs but is harmless given the ±1mo buffer. Pinned by `tests/unit/separations-schema.test.ts` — don't "fix" without considering test impact.
- **Kronos dates are ground truth** — `resolveKronosDates` always overrides Kuali dates when Kronos dates differ, not just when they are later. Kronos is the authoritative source for last-day-worked.
- **Kronos log disambiguation** — All Kronos log messages must explicitly say `[Old Kronos]` or `[New Kronos]` so logs are not ambiguous in the dashboard
- **ensurePageHealthy()** — Must check for SAML errors and session expiry before each major phase (extraction, transaction, finalization). Stale sessions cause silent failures.
- **UCPath transaction number extraction** — After clicking OK on the confirmation dialog, must renavigate via `navigateToSmartHR()` + `clickSmartHRTransactions()` (same as initial navigation) to find the transaction number. Cannot read it from the confirmation dialog itself.
- **[NAV] framenavigated listener** — Must be removed after UCPath auth completes. If left active, it fires on every PeopleSoft page navigation and causes false logging or interference.
- **Batch mode** — CLI accepts multiple doc IDs. Pre-emits `pending` for all items, then processes sequentially with shared browsers (uses `preAssignedRunId` in `withTrackedWorkflow`). Browsers are launched once and reused across all items.

## Verified Selectors

- **INVOL_TERM reason codes** — verified via playwright-cli 2026-04-09. Full list documented in `schema.ts` REASON_CODE_MAP comment. "No Longer Student" confirmed for "Graduated/No longer a Student".

*(Add more selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-10: Kronos dates only overriding when later** — Original `resolveKronosDates` logic only updated Kuali dates when Kronos dates were later. This was wrong: if Kronos shows an earlier last-day-worked (e.g. employee stopped working before Kuali's separation date), that should still override. Fix: Kronos dates always override when they differ from Kuali dates.
- **2026-04-10: computeKronosDateRange too narrow** — ±2 weeks missed timecards for employees whose last work was more than 2 weeks from the separation date. Expanded to ±1 month.
- **2026-04-10: UCPath transaction number not found after confirmation** — After clicking OK on the UCPath confirmation modal, the page navigates away from the transaction. The transaction number was not readable from the modal text. Fix: renavigate to Smart HR Transactions list via `navigateToSmartHR()` + `clickSmartHRTransactions()` and find the most recent transaction.
- **2026-04-10: framenavigated listener left active** — The `[NAV]` listener registered during UCPath auth was never removed, causing noisy log entries on every subsequent PeopleSoft navigation. Fix: remove the listener after auth completes.
- **2026-04-10: Batch mode design** — For processing multiple separations, launching/authenticating 5 browsers per doc ID was too slow. Fix: batch mode launches browsers once, authenticates once, pre-emits `pending` for all doc IDs, then processes each sequentially reusing the same browser sessions.
- **2026-04-10: Phase parallelization** — UCPath Job Summary and Kuali timekeeper fill were previously sequential (Phase 2), waiting for Kronos (Phase 1) to complete. Neither depends on Kronos results: Job Summary only needs EID, timekeeper fill touches different form fields than date fields. Moved both into the same `Promise.allSettled` as Kronos searches. Saves ~30s per document (Job Summary completes while Old Kronos is still searching). Post-transaction UCPath reset (`navigateToSmartHR`) also made batch-only since it's only needed to reset PeopleSoft session state for the next doc.
- **2026-04-10: Interleaved auth + work via ready promises** — Previously all 4 Duo auths had to complete before any work started. Now each browser's work task chains off an auth-ready promise (`oldKronosReady.then(...)`) so it starts immediately after its own Duo clears. Auth chain (Duo #2 → #3 → #4) runs in background during Kuali extraction. Old Kronos work starts ~30s earlier (while user is still approving New Kronos/UCPath Duos). Batch mode is unaffected (promises already resolved). Health checks moved to batch-only guard since fresh-mode browsers may not be authed yet when Phase 1 starts. `.catch(() => {})` on chain steps prevents one auth failure from blocking subsequent auths.
