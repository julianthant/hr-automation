# Work-Study Workflow

Updates employee position pool and compensation data for work-study awards in UCPath PayPath Actions.

**Kernel-based.** Declared via `defineWorkflow` in `workflow.ts` and executed through `src/core/runWorkflow`. The kernel owns browser launch, UCPath auth, tracker emission, SIGINT cleanup. The handler is a two-step pipeline (`ucpath-auth` → `transaction`) over a single UCPath browser.

## Files

- `schema.ts` — Zod `WorkStudyInput` schema (emplId: 5+ digits, effectiveDate: MM/DD/YYYY)
- `enter.ts` — Builds `ActionPlan` for the PayPath transaction: navigate → collapse sidebar → search by Empl ID → fill position data (reason "JRL", pool "F") → fill Job Data/Additional Pay comments → save/submit
- `tracker.ts` — Writes to `work-study-tracker.xlsx` (Excel-only). JSONL events are emitted by the kernel — do not call `trackEvent` here
- `workflow.ts` — Kernel definition (`workStudyWorkflow`) + CLI adapter (`runWorkStudy`). Dry-run branch bypasses the kernel (no browser launch; previews the ActionPlan directly)
- `index.ts` — Barrel exports

## Kernel Config

| Field | Value |
|-------|-------|
| `systems` | `[{ id: "ucpath", login: loginToUCPath-wrapped }]` |
| `steps` | `["ucpath-auth", "transaction"] as const` |
| `authChain` | `"sequential"` |
| `tiling` | `"single"` |
| `detailFields` | `["emplId", "effectiveDate"]` |

## Data Flow

```
CLI: npm run work-study <emplId> <effectiveDate>
  → runWorkStudy (CLI adapter)
    → if --dry-run: plan.preview() (no browser)
    → else: runWorkflow(workStudyWorkflow, input)
      → Kernel Session.launch: 1 browser, UCPath auth (Duo)
      → Handler step "ucpath-auth" (marker — auth already resolved by Session)
      → Handler step "transaction" → executes PayPath ActionPlan → updateData({ name })
      → Excel tracker row written (non-fatal on failure)
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

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-15: Migrated to kernel.** `runWorkStudy` is now a CLI adapter over `runWorkflow(workStudyWorkflow, input)`. Do not reintroduce raw `launchBrowser` / `withTrackedWorkflow` calls in the handler — those live in `src/core/`. Dry-run continues to bypass the kernel (no browser launched) and preview the plan directly.
