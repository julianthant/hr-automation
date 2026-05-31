# Person Lookup Workflow

Resolves an employee by name or EID via UCPath Person Organizational Summary + CRM cross-verification, then derives active/HDH status. Merges the former **EID Lookup** and **Active Check** workflows into one operator-facing daemon workflow.

**Kernel-based (daemon mode).** Registered in `WORKFLOW_LOADERS` and dashboard input runs. One `defineWorkflow`: `personLookupWorkflow`. Handler steps: `searching` → `cross-verification` (skipped for `{ emplId }` inputs) → `active-status`. Output: resolved EID, active/HDH status, department, termination date.

Each dashboard input run enqueues N names/EIDs as N kernel items to an alive daemon (session reused — no re-Duo between items). A one-person input run is a `single` row. A multi-person input run is a batch surface: every person row is stamped `batch-member` under the shared input-run `parentRunId`.

## Internal primitive: `lookupPersonInUcpath`

`lookup.ts` exports `lookupPersonInUcpath` — the raw UCPath Person Org search. Other workflows (OCR orchestrator, force-research, retry-page) call this function or delegate to `personLookupWorkflow` for EID-resolution work. Do not call `searchByName` / `searchByEid` directly from composing workflows — route through `lookupPersonInUcpath` so hidden Employment Instances are handled consistently.

## Status derivation

`outcome.ts` exports:

- `deriveActiveCheckOutcome` — derives the operator-facing `ActiveCheckOutcome` (activeStatus: `active` | `inactive` | `not-found` | `non-hdh` | `ambiguous`; `isActive`; `isHdhAccepted`; `terminationDate`; `candidateEids`).
- `derivePersonLookupSelection` — selects the preferred result row for multi-instance EID sets (active row wins over inactive for the same EID).
- `resolvePersonLookupForEidLookup` — narrows a multi-result name search by CRM-matched EID.

## Selector intelligence

This workflow touches two systems: **ucpath** and **crm**.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`, `"crm name search"`, `"sdcmp filter"`).
- Per-system lessons:
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Per-system catalogs:
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Shared-context pool semantics

- Up to 4 workers share UCPath + CRM `BrowserContext`s. Each worker opens its own Page on first `ctx.page(id)` call (lazy allocation).
- Queue-based distribution inside `runWorkflowSharedContextPool` — workers pull items from a shared queue until empty.
- Per-item failures become `failed` tracker rows; the worker continues to the next queue item.
- Duplicate names/EIDs in an input run are deduped before enqueue (`prepareNames` / `dedupeNames`). Duplicate-item requests would collide on the derived `itemId`.

## Name Search Strategy

Input is first normalized via `normalizeName` → "Last, First Middle" title-case. Search then tries strategies in order:

1. Try full name: `lastName, firstName middleName`
2. If no SDCMP candidates: try `lastName, firstName` (drop middle)
3. If still nothing: try `lastName, middleName` (middle as first)

After each successful strategy the SDCMP candidate list is filtered by `isAcceptedHdhDepartment` (HDH keyword whitelist). A candidate is **only** accepted if its department passes the HDH filter — a SDCMP-BU row at a non-HDH dept (e.g. QUALCOMM INSTITUTE) is rejected and lets the CRM-only fallback surface a better EID.

EID inputs skip cross-verification entirely and go straight to `active-status`.

## HDH department filtering

`isAcceptedHdhDepartment` (in `src/domain/hdh/departments.ts`) matches: `"Housing"`, `"Dining"`, `"Hospitality"`, `"On Campus Housing"`, and the canonical `"HOUSING/DINING/HOSPITALITY"` string. Case-insensitive. `keepNonHdh: true` bypasses the filter (Active Check–style operator review).

## Gotchas

- PeopleSoft search results table ID: `tdgbrPTS_CFG_CL_STD_RSL$0`
- Valid data rows must have exactly 9 cells with numeric Empl ID (5+ digits) in first cell
- Drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact
- Assignment table scan: finds first row with 12+ cells where cell[3] matches business unit pattern and cell[6] is department description
- "View All" button may need re-clicking after drill-in if results are paginated (rowIndex > 10)
- CRM search uses different strategy: last name first, then first name
- CRM date matching uses ±7 day tolerance for hire date comparison
- Each worker gets its own UCPath tab AND its own CRM tab — concurrent CRM name searches on separate pages
- Person Org may return multiple SDCMP rows for the same EID / employment history. `lookupPersonInUcpath` expands Employment Instances and selects the preferred assignment row (active first, HDH-active before non-HDH) before workflow status derivation.

## Dead code note

The `ocr-active-check` task dependency kind and `createOcrActiveCheckDependencyBatch` (in `src/tracker/tasks/store.ts`) are vestigial dead code — OCR only ever delegates to person-lookup via `ocr-eid-lookup`. These are intentionally retained for historical reasons; do not remove or rename them.

## Lessons Learned

- **2026-05-28: Person Lookup merged from EID Lookup + Active Check.** Both former workflows are deleted. All callers import from `src/workflows/person-lookup/`. The workflow name is `"person-lookup"`, label `"Person Lookup"`.
- **2026-05-28: Retired workflow ids are not dashboard surfaces.** Historical `eid-lookup` and `active-check` tracker rows stay readable for audit/debugging, but dashboard workflow lists/counts filter them out. Do not re-add either id to workflow metadata, input-run registries, or dashboard rail logic.
- **Normalize and dedupe names before enqueue.** `normalizeName` title-cases and canonicalizes separator; `prepareNames` + `dedupeNames` prevent itemId collisions.
- **HDH acceptance is department-level, not BU-level.** SDCMP alone is too broad. Rejected SDCMP/non-HDH rows should log why they were ignored so CRM-only fallback can surface the better EID.
- **Person Org active-row selection is shared.** Do not fork active/inactive parsing. Keep status derivation fed by `lookupPersonInUcpath` / `derivePersonLookupSelection` so hidden active Employment Instances are handled consistently.
- **Runtime policy uses default row actions + memberRow person title.** `PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY` spreads `DEFAULT_WORKFLOW_RUNTIME_POLICY` and sets `memberRow.titleSource: "person"` for grouped input-run rows and OCR utility children. Direct one-person input runs are `single`; direct multi-person input runs are grouped `batch-member` rows under the input-run `parentRunId`; OCR lookup children remain flat delegated utility rows unless the caller explicitly renders them as a batch.
- **2026-05-28: Batch means multiple people, not one daemon/session.** Keep `personLookupWorkflow.archetype` as `single` because each schema item is one person. The `/api/enqueue` boundary marks multi-value input runs with `__runtimeOptions.rowShape = "batch-member"` and a shared `parentRunId`, which is what makes a 5-ID Person Lookup request a batch surface.
- **Dashboard input run is the public start path.** `npm run person-lookup:stop` stops the daemon pool. Typed name/EID starts go through `InputRunPanel` and `/api/enqueue`. There is no `npm run person-lookup` launch script.
