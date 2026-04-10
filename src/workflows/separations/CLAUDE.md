# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches both Old & New Kronos for timesheets, creates UCPath termination transaction, fetches job summary, and fills Kuali finalization fields.

## Files

- `config.ts` — URLs (Kuali, Kronos), template IDs (`UC_VOL_TERM`, `UC_INVOL_TERM`), screen dimensions for tiling 5 windows (2560x1440)
- `schema.ts` — `SeparationData` Zod schema; helpers: `computeTerminationEffDate` (+1 day), `buildTerminationComments`, `mapReasonCode` (Kuali → UCPath), `getInitials`, `buildDateChangeComments`
- `workflow.ts` — Main orchestration: uses `withTrackedWorkflow` for dashboard tracking (steps: launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization), launches 4 tiled browsers, staggered Duo auth, parallel extraction/search with `Promise.allSettled`, fills UCPath + Kuali forms
- `run.ts` — CLI entry point: `runSeparation(docId, { keepOpen: true })`, supports batch mode with multiple doc IDs (pre-emits pending for all, processes sequentially with shared browsers)
- `explore-kronos.ts` — Interactive exploration script for selector discovery (launches Kronos browsers, pauses for Playwright Inspector)
- `index.ts` — Barrel exports

## Data Flow

```
CLI: docId (Kuali document number)
  → Launch 5 tiled browsers (Kuali, Old Kronos, New Kronos, UCPath Txn, UCPath Job Summary)
  → Authenticate Kuali (first Duo)
  → Extract termination data from Kuali form
  → Compute termination effective date (separation date + 1 day)
  → Parallel: search Old Kronos + New Kronos for employee timesheets
  → Parallel: create UCPath termination transaction + fetch job summary
  → Fill Kuali finalization fields (department, payroll code, transaction number)
  → Return SeparationData
```

## 5-Browser Tiling Layout

```
Row 1: [ Kuali ] [ Old Kronos ] [ New Kronos ]
Row 2: [ UCPath Txn ] [ UCPath Job Summary ]
```

Screen: 2560x1440, windows positioned via Chromium `--window-position` and `--window-size` args.

## Gotchas

- **5 separate Duo authentications** — must be done one at a time (sequential), not parallel
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
