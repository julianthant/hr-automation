# EID Lookup Workflow

Searches UCPath Person Organizational Summary for employees by name, filters for SDCMP business unit and Housing/Dining/Hospitality departments, with optional CRM cross-verification.

## Files

- `search.ts` — Multi-strategy name search: parses "Last, First Middle" input, tries full name → first only → middle only, drills into SDCMP results to extract department/job details, filters for HDH keywords
- `crm-search.ts` — CRM cross-verification: searches by last then first name, extracts PPS ID/UCPath EID/hire date/dept, date-matching helper (±7 days)
- `tracker.ts` — Writes to `eid-lookup-tracker.xlsx` with columns for name, EID, HR status, department, position, start/end dates, FTE, empl class
- `workflow.ts` — Three modes: `lookupSingle` (1 browser), `lookupParallel` (N workers sharing auth), `lookupWithCrm` (parallel UCPath + CRM with Duo sequencing)
- `index.ts` — Barrel exports

## Data Flow

```
CLI: "Last, First Middle" name(s)
  → Navigate to Person Organizational Summary (direct URL)
  → Search by name (multi-strategy fallback)
  → Filter results: SDCMP business unit only
  → Drill into each SDCMP row → extract department, position, dates, FTE, class
  → Filter for HDH keywords (Housing, Dining, Hospitality)
  → (Optional) Cross-verify with CRM search
  → Update tracker
```

## Name Search Strategy

1. Try full name: `lastName, firstName middleName`
2. If no SDCMP results: try `lastName, firstName` (drop middle)
3. If still nothing: try `lastName, middleName` (middle as first)

## Gotchas

- PeopleSoft search results table ID: `tdgbrPTS_CFG_CL_STD_RSL$0`
- Valid data rows must have exactly 9 cells with numeric Empl ID (5+ digits) in first cell
- Drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact
- Assignment table scan: finds first row with 12+ cells where cell[3] matches business unit pattern (4-5 uppercase chars + optional digit) and cell[6] is department description
- "View All" button may need re-clicking after drill-in if results are paginated (rowIndex > 10)
- CRM search uses different strategy: last name first, then first name
- CRM date matching uses ±7 day tolerance for hire date comparison
- Parallel mode: shared auth context (one Duo), multiple tabs, queue-based distribution
- Browsers kept open for inspection (no automatic close)
