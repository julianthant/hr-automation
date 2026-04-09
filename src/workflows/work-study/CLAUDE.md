# Work-Study Workflow

Updates employee position pool and compensation data for work-study awards in UCPath PayPath Actions.

## Files

- `schema.ts` — Zod `WorkStudyInput` schema (emplId: 5+ digits, effectiveDate: MM/DD/YYYY)
- `enter.ts` — Builds `ActionPlan` for PayPath transaction: navigate to PayPath Actions, collapse sidebar, search by Empl ID, fill position data (reason "JRL", pool "F"), fill Job Data/Additional Pay comments, save/submit
- `tracker.ts` — Writes to `work-study-tracker.xlsx` (Excel-only, no `trackEvent` — JSONL events handled by `withTrackedWorkflow` in workflow.ts)
- `workflow.ts` — Main orchestration: uses `withTrackedWorkflow` for dashboard tracking (steps: ucpath-auth → transaction). Launch browser, authenticate UCPath, dry-run preview or execute plan, update tracker
- `index.ts` — Barrel exports

## Data Flow

```
CLI: emplId + effectiveDate
  → Authenticate UCPath
  → Navigate to PayPath Actions (sidebar → iframe load)
  → Search employee by Empl ID
  → Fill position data form (pool "F", reason "JRL")
  → Navigate Job Data → Additional Pay tabs
  → Save and Submit
  → Update tracker
```

## Gotchas

- **Save & Submit is commented out** (line ~237-240 in enter.ts) — pending test completion
- Position Pool hardcoded to `"F"`, Position Change Reason to `"JRL"`
- Comments template: `"Updated pool id to F per work study award {effectiveDate}"`
- Employee name extracted from PeopleSoft header (multiple selector variants)
- Sidebar must be auto-collapsed to prevent click interception on iframe buttons
- 3-5 second waits required after PeopleSoft iframe reloads
- PeopleSoft alerts (payroll-in-progress warnings) are auto-dismissed
- Uses `getContentFrame()` for all iframe interactions — same pattern as onboarding
