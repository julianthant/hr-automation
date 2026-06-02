# Person Lookup Workflow

Resolves an employee by name or EID via UCPath Person Organizational Summary + CRM cross-verification, then derives active/HDH status. Merges the former **EID Lookup** and **Active Check** workflows into one operator-facing daemon workflow.

**Kernel-based (daemon mode).** Registered in `WORKFLOW_LOADERS` and dashboard input runs. One `defineWorkflow`: `personLookupWorkflow`. Handler steps: `searching` → `cross-verification` (skipped for `{ emplId }` inputs) → `active-status` → `crm-dates` (skipped unless `input.includeCrmDates === true`). Output: resolved EID, active/HDH status, department, start date, assignment EFFDT context, termination date, and optional CRM dates.

Each dashboard input run enqueues N names/EIDs as N kernel items to an alive daemon (session reused — no re-Duo between items). A one-person input run is a `single` row. A multi-person input run is a batch surface: every person row is stamped `batch-member` under the shared input-run `parentRunId`.

## Internal primitive: `lookupPersonInUcpath`

`lookup.ts` exports `lookupPersonInUcpath` — the raw UCPath Person Org search. Other workflows (OCR orchestrator, force-research, retry-page) call this function or delegate to `personLookupWorkflow` for EID-resolution work. Do not call `searchByName` / `searchByEid` directly from composing workflows — route through `lookupPersonInUcpath` so hidden Employment Instances are handled consistently.

## Status derivation

`outcome.ts` exports:

- `deriveActiveCheckOutcome` — derives the operator-facing `ActiveCheckOutcome` (activeStatus: `active` | `inactive` | `not-found` | `non-hdh` | `ambiguous`; `isActive`; `isHdhAccepted`; `terminationDate`; `candidateEids`).
- `derivePersonLookupSelection` — selects the preferred result row for multi-instance EID sets (active row wins over inactive for the same EID).
- `resolvePersonLookupForEidLookup` — narrows a multi-result name search by CRM-matched EID.

`startDate` is the UCPath Last Hire / first-day-of-service date used for operator display and CRM date matching. `effdt` remains the assignment row effective date for backend context. Prefer `startDate` when comparing to CRM First Day of Service; fall back to EFFDT only when Last Hire is missing.

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
- CRM date matching uses ±7 day tolerance against UCPath `startDate` (Last Hire / first day of service), falling back to assignment EFFDT only when `startDate` is missing
- Each worker gets its own UCPath tab AND its own CRM tab — concurrent CRM name searches on separate pages
- Person Org may return multiple SDCMP rows for the same EID / employment history. `lookupPersonInUcpath` expands Employment Instances and selects the preferred assignment row (active first, HDH-active before non-HDH) before workflow status derivation.

## CRM-date enrichment (`includeCrmDates`)

Set `includeCrmDates: true` in the input to run an extra `crm-dates` step after `active-status`. The step searches CRM by the resolved `searchName`, then stamps two fields onto the tracker row's output data:

- `employmentDate` — CRM "First Day of Service (Effective Date)" field
- `oathDate` — CRM "Date Signed" field (the oath taken-and-subscribed date)

Selection: prefers the CRM record whose `ucpathEmployeeId` matches the resolved EID; falls back to the first record when no EID match is found.

**Best-effort:** parse failures, CRM search errors, and empty result sets all log and return gracefully without failing the overall lookup. Never throws.

**Off by default.** Omitting `includeCrmDates` (or setting it to `false`) causes the step to be skipped via `ctx.skipStep("crm-dates")` so the step list stays consistent across all runs. Normal dashboard input runs are unaffected.

**Not in `detailFields`:** `employmentDate` and `oathDate` are output-data fields for a delegating parent to read. Adding them to `detailFields` would trigger a runtime warning for every run where the flag is off.

Currently used by: the OCR `verify` flow.

## Dead code note

The `ocr-active-check` task dependency kind and `createOcrActiveCheckDependencyBatch` (in `src/tracker/tasks/store.ts`) are vestigial dead code — OCR only ever delegates to person-lookup via `ocr-eid-lookup`. These are intentionally retained for historical reasons; do not remove or rename them.

## Lessons Learned

- **2026-05-28: Person Lookup merged from EID Lookup + Active Check.** Both former workflows are deleted. All callers import from `src/workflows/person-lookup/`. The workflow name is `"person-lookup"`, label `"Person Lookup"`.
- **2026-05-28: Retired workflow ids are not dashboard surfaces.** Historical `eid-lookup` and `active-check` tracker rows stay readable for audit/debugging, but dashboard workflow lists/counts filter them out. Do not re-add either id to workflow metadata, input-run registries, or dashboard rail logic.
- **Normalize and dedupe names before enqueue.** `normalizeName` title-cases and canonicalizes separator; `prepareNames` + `dedupeNames` prevent itemId collisions.
- **HDH acceptance is department-level, not BU-level.** SDCMP alone is too broad. Rejected SDCMP/non-HDH rows should log why they were ignored so CRM-only fallback can surface the better EID.
- **Person Org active-row selection is shared.** Do not fork active/inactive parsing. Keep status derivation fed by `lookupPersonInUcpath` / `derivePersonLookupSelection` so hidden active Employment Instances are handled consistently.
- **2026-06-02: Start Date is Last Hire, not assignment EFFDT.** Person Org extraction carries both dates: `startDate` from UCPath Last Hire / first-day-of-service and `effdt` from the selected assignment row's EFFDT. CRM cross-verification should compare CRM First Day of Service to `startDate` first. Dashboard detail fields show `Start Date`; keep EFFDT as backend context instead of relabeling it for operators.
- **Runtime policy uses default row actions + memberRow person title + always-batch-when-delegated.** `PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY` spreads `DEFAULT_WORKFLOW_RUNTIME_POLICY`, sets `memberRow.titleSource: "person"`, and sets `delegation.alwaysBatchDelegatedMembers: true`. Direct one-person input runs are `single`; direct multi-person input runs are grouped `batch-member` rows under the input-run `parentRunId`.
- **2026-06-02: Delegated lookups always render as a batch, even one.** OCR's EID-resolution fan-out used to render a lone delegated lookup as a flat single row (the queue classifier collapses a 1-member delegated set to a flat single). `delegation.alwaysBatchDelegatedMembers: true` on the person-lookup policy keeps even one delegated lookup as a one-member batch surface in the Person Lookup tab. Only delegated rows are affected — direct one-person input runs (root rows, no `parentRunId`) stay `single`. The flag rides the serialized `runtimePolicy` to the client classifier; `queue-surfaces.ts` reads it via `getWorkflowRuntimePolicy(...).delegation?.alwaysBatchDelegatedMembers`.
- **2026-05-28: Batch means multiple people, not one daemon/session.** Keep `personLookupWorkflow.archetype` as `single` because each schema item is one person. The `/api/enqueue` boundary marks multi-value input runs with `__runtimeOptions.rowShape = "batch-member"` and a shared `parentRunId`, which is what makes a 5-ID Person Lookup request a batch surface.
- **Dashboard input run is the public start path.** `npm run person-lookup:stop` stops the daemon pool. Typed name/EID starts go through `InputRunPanel` and `/api/enqueue`. There is no `npm run person-lookup` launch script.
- **2026-06-02: `oathDate` = CRM "Date Signed"; `includeCrmDates` is purely additive and gated.** The CRM date enrichment step (`crm-dates`) stamps `employmentDate` (First Day of Service) and `oathDate` (Date Signed — the oath taken-&-subscribed date) only when `input.includeCrmDates === true`. The step is always declared in the `steps` tuple and skipped via `ctx.skipStep("crm-dates")` when the flag is off, so the step list is consistent across all runs. Neither field is in `detailFields` — they are output-data fields for delegating parents (OCR verify flow) to read. Normal dashboard input runs are unaffected.
