# Separations Workflow

Multi-system employee termination: extracts data from Kuali Build, searches both Old & New Kronos for timesheets, creates UCPath termination transaction, fetches job summary, and fills Kuali finalization fields.

## Files

- `config.ts` — URLs (Kuali, Kronos), template IDs (`UC_VOL_TERM`, `UC_INVOL_TERM`), screen dimensions for tiling 5 windows (2560x1440)
- `schema.ts` — `SeparationData` Zod schema; helpers: `computeTerminationEffDate` (+1 day), `buildTerminationComments`, `mapReasonCode` (Kuali → UCPath), `getInitials`, `buildDateChangeComments`
- `workflow.ts` — Main orchestration: launches 5 tiled browsers, staggered Duo auth, parallel extraction/search with `Promise.allSettled`, fills UCPath + Kuali forms
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
- Voluntary vs Involuntary: determined by `terminationType` against `INVOLUNTARY_TYPES` list
- Reason code mapping: exact match → fuzzy match → fallback `"Resign - No Reason Given"`
- Template selection: `UC_VOL_TERM` (voluntary) or `UC_INVOL_TERM` (involuntary)
- Kuali drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}`
- Comments auto-generated with termination eff date, last day worked, and Kuali form #
- `Promise.allSettled` used so one system failure doesn't block others
- `explore-kronos.ts` is a dev tool, not a production workflow
