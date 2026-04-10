# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches both Old & New Kronos for timesheets, creates UCPath termination transaction, fetches job summary, and fills Kuali finalization fields.

## Files

- `config.ts` — URLs (Kuali, Kronos), template IDs (`UC_VOL_TERM`, `UC_INVOL_TERM`), screen dimensions for tiling 5 windows (2560x1440)
- `schema.ts` — `SeparationData` Zod schema; helpers: `computeTerminationEffDate` (+1 day), `buildTerminationComments`, `mapReasonCode` (Kuali → UCPath), `getInitials`, `buildDateChangeComments`
- `workflow.ts` — Main orchestration: uses `withTrackedWorkflow` for dashboard tracking (steps: launching → authenticating → kuali-extraction → kronos-search → ucpath-job-summary → ucpath-transaction → kuali-finalization), launches 4 tiled browsers, staggered Duo auth, parallel extraction/search with `Promise.allSettled`, fills UCPath + Kuali forms
- `run.ts` — CLI entry point: `runSeparation(docId, { keepOpen: true })`
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

## Verified Selectors

- **INVOL_TERM reason codes** — verified via playwright-cli 2026-04-09. Full list documented in `schema.ts` REASON_CODE_MAP comment. "No Longer Student" confirmed for "Graduated/No longer a Student".

*(Add more selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

*(Add entries here when separations bugs are fixed — document root cause and fix so the same error never recurs)*
