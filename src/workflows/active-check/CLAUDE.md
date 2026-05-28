# Active Check Workflow

Checks UCPath **Person Organizational Summary** for active/inactive HR status by employee **name** or **8-digit EID**, using `searchByName` / `searchByEid` (`src/systems/ucpath/person-org-summary.js`) with outcome derivation in `deriveActiveCheckOutcome` (`src/domain/active-check-outcome.ts`). Name search uses `keepNonHdh: true` so non-HDH rows can surface for operator review; EID search drills a single row set.

**Kernel-based (dashboard input run by default)** — `activeCheckWorkflow` in `workflow.ts`; dashboard input runs enqueue through `/api/enqueue`.

## Selector intelligence

This workflow touches **ucpath** only.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`).
- Per-system lessons: [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- Catalog: [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)

## Shared-context pool

Same topology as **eid-lookup**: up to 4 workers share UCPath browser contexts; items are pulled from a queue until empty. See [`src/workflows/eid-lookup/CLAUDE.md`](../eid-lookup/CLAUDE.md) → Shared-context pool semantics for general behavior.

## Lessons Learned

- **2026-05-25: Dashboard input run is the public start path.** `npm run active-check` is retired; typed name/EID starts belong in `InputRunPanel` and `/api/enqueue`.
- **2026-05-27: OCR utility rows use normal count-based grouping.** `ACTIVE_CHECK_WORKFLOW_RUNTIME_POLICY` spreads the shared default policy and sets `memberRow.titleSource: "person"` for OCR utility children. Direct input-run rows stay normal surfaces; OCR fan-out rows are `single` with OCR `parentRunId`, so one child is flat and multiple siblings group as a batch surface.
