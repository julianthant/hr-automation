# Person Lookup Workflow

Resolves an employee by name or EID via UCPath Person Organizational Summary + CRM cross-verification, then derives active/HDH status. Merges the former **EID Lookup** and **Active Check** workflows into one operator-facing daemon workflow.

**Kernel-based (daemon mode).** Registered in `WORKFLOW_LOADERS` and dashboard input runs. One `defineWorkflow`: `personLookupWorkflow`. Handler steps: `searching` → `cross-verification` (runs for **both** name and `{ emplId }` inputs) → `active-status` → `crm-dates` (skipped unless `input.includeCrmDates === true`). Output: resolved EID, active/HDH status, department, **CRM-sourced payroll title** (Title Code/Payroll Title, code prefix stripped), **CRM-sourced start date**, assignment EFFDT context, termination date, **UCPath termination reason** (action-reason, e.g. "Resign - Personal Reasons"), and optional CRM dates.

Each dashboard input run enqueues N names/EIDs as N kernel items to an alive daemon (session reused — no re-Duo between items). A one-person input run is a `single` row. A multi-person input run is a batch surface: every person row is stamped `batch-member` under the shared input-run `parentRunId`.

## Internal primitive: `lookupPersonInUcpath`

`lookup.ts` exports `lookupPersonInUcpath` — the raw UCPath Person Org search. Other workflows (OCR orchestrator, force-research, retry-page) call this function or delegate to `personLookupWorkflow` for EID-resolution work. Do not call `searchByName` / `searchByEid` directly from composing workflows — route through `lookupPersonInUcpath` so hidden Employment Instances are handled consistently.

## Delegated by separations (name↔EID verification)

`separations` delegates to `personLookupWorkflow` via `ctx.delegateTo` on **every** run, at its `identity-check` step, to verify the Kuali-extracted EID against the employee NAME: in `{ name: employeeName }`, out the resolved EID at `result.data.emplId` (the 8-digit `emplId` stamped by the `searching`/`active-status` steps). The name is authoritative — separations proceeds when the resolved EID matches, takes the name-derived EID when it differs (e.g. a valid-format but wrong EID like the Perez `10694136` case), and **fails loud** when person-lookup resolves no valid EID (never proceeds with an unverified EID). person-lookup is daemon-capable, so this routes through a person-lookup daemon (its own UCPath + CRM auth — adds an auth pass + latency to *every* separation). See `src/workflows/separations/CLAUDE.md` ("Name ↔ EID verification", 2026-06-18).

## Status derivation

`outcome.ts` exports:

- `deriveActiveCheckOutcome` — derives the operator-facing `ActiveCheckOutcome` (activeStatus: `active` | `inactive` | `not-found` | `non-hdh` | `ambiguous`; `isActive`; `isHdhAccepted`; `terminationDate`; `terminationReason` (blank unless terminated); `candidateEids`).
- `derivePersonLookupSelection` — selects the preferred result row for multi-instance EID sets (active row wins over inactive for the same EID).
- `resolvePersonLookupForEidLookup` — narrows a multi-result name search by CRM-matched EID.

`startDate` (the operator-facing **Start Date**) is **CRM First Day of Service only** — sourced in `cross-verification` via `searchCrmByEidOrName` + `pickCrmStartDate`, never from UCPath. It is left **blank** when CRM has no matching record / no date (no UCPath fallback). The UCPath Last Hire (`ActiveCheckOutcome.startDate`) is kept only as backend context on the row as `ucpathStartDate`; `effdt` remains the assignment row EFFDT. `stampActiveCheckFields` must NOT write `startDate`, or active-status (which runs after cross-verification) would clobber the CRM value.

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

EID inputs skip the name-disambiguation logic in `cross-verification`, but the step still runs for them to fetch the CRM record (by EID first, then the UCPath-resolved name) and stamp the CRM-sourced Start Date.

## HDH department filtering

`isAcceptedHdhDepartment` (in `src/domain/hdh/departments.ts`) matches: `"Housing"`, `"Dining"`, `"Hospitality"`, `"On Campus Housing"`, and the canonical `"HOUSING/DINING/HOSPITALITY"` string. Case-insensitive. `keepNonHdh: true` bypasses the filter (Active Check–style operator review).

## Gotchas

- PeopleSoft search results table ID: `tdgbrPTS_CFG_CL_STD_RSL$0`
- Valid data rows must have exactly 9 cells with numeric Empl ID (5+ digits) in first cell
- Drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact
- Assignment table scan: finds first row with 12+ cells where cell[3] matches business unit pattern and cell[6] is department description
- "View All" button may need re-clicking after drill-in if results are paginated (rowIndex > 10)
- CRM search uses different strategy: last name first, then first name. For EID inputs, `searchCrmByEidOrName` searches CRM by the EID (`?q=<eid>`) first and selects the record whose `ucpathEmployeeId` matches, then falls back to the name search.
- The operator-facing Start Date is `pickCrmStartDate(records, eid)` = the CRM First Day of Service of the EID-matched record (else first record); blank when CRM has none. Screenshots: `cross-verification` captures the CRM **record** page (`crmRecordScreenshot`), not the search grid.
- CRM `crmMatch` date matching uses ±7 day tolerance against UCPath `startDate` (Last Hire / first day of service), falling back to assignment EFFDT only when `startDate` is missing. (This UCPath date drives EID disambiguation only — it is not the displayed Start Date.)
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

- **2026-06-11: Never stamp prose into `emplId` — it's the EID identity field (bug A2).** The name-search error and not-found paths in `searchingStep` used to `ctx.updateData({ emplId: "Error" })` / `{ emplId: "Not found" }`. `emplId` is the EID identity field — it feeds the queue-row subtitle (`resolveEid` in `domain/queue-row-presentation.ts`) AND is carried forward as a "resolved" EID by `tracker/queue-row-count.ts`. A prose value there leaked "Not found" / "Error" into the subtitle and propagated across re-run attempts. Fix: prose goes in the **`hrStatus` DETAIL field** instead (matching the EID-input paths, which already stamped `hrStatus` and the real searched EID into `emplId`); the not-found STATE stays structured via `activeStatus: "not-found"` (stamped by the active-status step → drives the `notFound` badge), and a thrown search error already lands the row `failed`. Leaving `emplId` unset lets the subtitle fall through to the trace id, and a later crm-only resolution can still stamp a real EID. `resolveEid` was also hardened to reject non-numeric values (defense in depth). Pinned by `tests/unit/domain/queue-row-presentation.test.ts`.
- **2026-06-05: Termination Reason grid field is UCPath-sourced (Person Org Summary action-reason).** The log-panel grid shows `terminationReason` (label "Term Reason") after End Date. It comes from UCPath Person Org Summary's ORG Instance section, rendered next to the Termination Date — selector `personOrgSummary.terminationReason` = `#PER_INST_EMP_VW_DESCR$0` (same `PER_INST_EMP_VW_*$0` family as Last Hire / Termination Date). Extracted in **both** detail paths (`drillInAndGetDetails` + the single-result detail path) and carried `EidResult.terminationReason → PersonLookupResult → ActiveCheckOutcome.terminationReason`, then stamped in `stampActiveCheckFields`. **Gated on the termination date**: blanked at extraction (`selectedTermDate ? termReason : ""`) AND again in `deriveActiveCheckOutcome` (`terminationDate ? reason : ""`) so an active row never shows a stale action-reason. Unlike Start Date (CRM), this is the one operator-facing field sourced from UCPath, not CRM.
- **2026-06-05: Payroll Title grid field is CRM-sourced and code-stripped.** The log-panel grid now shows `payrollTitle` (label "Payroll Title") immediately before Start Date. It comes from the CRM record's already-extracted `titleCode` ("Title Code/Payroll Title", e.g. `"4921 - STDT 2"`), stripped of the leading PeopleSoft job code via `payrollTitleFromTitleCode` → `"STDT 2"`. `pickCrmPayrollTitle` selects the same CRM record as `pickCrmStartDate` (both now share the private `pickCrmRecord`). Stamped in `stampCrmStartDateAndScreenshot` alongside `startDate`, and stamped `""` on every cross-verification early-return that already blanks `startDate` so the declared detailField never triggers the missing-field runtime warning. CRM-only/best-effort — blank when there is no CRM record (no UCPath fallback), exactly like Start Date.
- **2026-05-28: Person Lookup merged from EID Lookup + Active Check.** Both former workflows are deleted. All callers import from `src/workflows/person-lookup/`. The workflow name is `"person-lookup"`, label `"Person Lookup"`.
- **2026-05-28: Retired workflow ids are not dashboard surfaces.** Historical `eid-lookup` and `active-check` tracker rows stay readable for audit/debugging, but dashboard workflow lists/counts filter them out. Do not re-add either id to workflow metadata, input-run registries, or dashboard rail logic.
- **Normalize and dedupe names before enqueue.** `normalizeName` title-cases and canonicalizes separator; `prepareNames` + `dedupeNames` prevent itemId collisions.
- **HDH acceptance is department-level, not BU-level.** SDCMP alone is too broad. Rejected SDCMP/non-HDH rows should log why they were ignored so CRM-only fallback can surface the better EID.
- **Person Org active-row selection is shared.** Do not fork active/inactive parsing. Keep status derivation fed by `lookupPersonInUcpath` / `derivePersonLookupSelection` so hidden active Employment Instances are handled consistently.
- **2026-06-02: Start Date is CRM First Day of Service only (supersedes "Start Date is Last Hire").** The operator-facing `startDate` is sourced from CRM in `cross-verification` (`searchCrmByEidOrName` → `pickCrmStartDate`), never from UCPath, and is **blank** when CRM has no record/date (no fallback). `cross-verification` now runs for **both** name and EID inputs (EID inputs search CRM by EID first, then the resolved name). `stampActiveCheckFields` no longer writes `startDate` (it would clobber the CRM value since active-status runs after cross-verification); the UCPath Last Hire rides as backend-only `ucpathStartDate`. The UCPath `startDate`/`effdt` distinction in `EidResult`/`ActiveCheckOutcome` is retained for EID disambiguation (`crmMatch` date tolerance) only.
- **2026-06-02: Person Lookup screenshots are system-scoped + post-resolution.** `searching` captures the resolved UCPath detail (`personOrgScreenshot`, `{ systems: ["ucpath"] }`) and only captures the search grid (`personOrgSearchScreenshot`) when nothing resolves (not-found audit). `cross-verification` captures the CRM **record** page (`crmRecordScreenshot`, `{ systems: ["crm"] }`), not the search grid. `ctx.captureAndStampScreenshot(label, dataKey, { systems })` stamps the file for the requested system instead of a blind `files[0]`, so a multi-system run can't stamp the wrong page.
- **Runtime policy uses default row actions + memberRow person title + always-batch-when-delegated.** `PERSON_LOOKUP_WORKFLOW_RUNTIME_POLICY` spreads `DEFAULT_WORKFLOW_RUNTIME_POLICY`, sets `memberRow.titleSource: "person"`, and sets `delegation.alwaysBatchDelegatedMembers: true`. Direct one-person input runs are `single`; direct multi-person input runs are grouped `batch-member` rows under the input-run `parentRunId`.
- **2026-06-02: Delegated lookups always render as a batch, even one.** OCR's EID-resolution fan-out used to render a lone delegated lookup as a flat single row (the queue classifier collapses a 1-member delegated set to a flat single). `delegation.alwaysBatchDelegatedMembers: true` on the person-lookup policy keeps even one delegated lookup as a one-member batch surface in the Person Lookup tab. Only delegated rows are affected — direct one-person input runs (root rows, no `parentRunId`) stay `single`. The flag rides the serialized `runtimePolicy` to the client classifier; `queue-surfaces.ts` reads it via `getWorkflowRuntimePolicy(...).delegation?.alwaysBatchDelegatedMembers`.
- **2026-05-28: Batch means multiple people, not one daemon/session.** Keep `personLookupWorkflow.archetype` as `single` because each schema item is one person. The `/api/enqueue` boundary marks multi-value input runs with `__runtimeOptions.rowShape = "batch-member"` and a shared `parentRunId`, which is what makes a 5-ID Person Lookup request a batch surface.
- **Dashboard input run is the public start path.** `npm run person-lookup:stop` stops the daemon pool. Typed name/EID starts go through `InputRunPanel` and `/api/enqueue`. There is no `npm run person-lookup` launch script.
- **2026-06-02: `oathDate` = CRM "Date Signed"; `includeCrmDates` is purely additive and gated.** The CRM date enrichment step (`crm-dates`) stamps `employmentDate` (First Day of Service) and `oathDate` (Date Signed — the oath taken-&-subscribed date) only when `input.includeCrmDates === true`. The step is always declared in the `steps` tuple and skipped via `ctx.skipStep("crm-dates")` when the flag is off, so the step list is consistent across all runs. Neither field is in `detailFields` — they are output-data fields for delegating parents (OCR verify flow) to read. Normal dashboard input runs are unaffected.
- **2026-06-07: No-data / error paths now capture screenshots for operator evidence.** Every early-return and error path in `searching` and `crossVerificationStep` captures a best-effort screenshot via bare `await ctx.captureAndStampScreenshot(...)` before returning or rethrowing. The helper (`src/core/kernel/ctx.ts`) wraps its body in try/catch and only `log.warn`s on failure — it CANNOT throw — so no workflow-local try/catch wrapper is needed or correct (per `src/core/CLAUDE.md` invariant). Added captures (7 total): (1) EID search ERROR before rethrow → `personOrgSearchScreenshot` label `"UCPath EID search failed"` (ucpath); (2) EID "Not found" → `personOrgSearchScreenshot` label `"no UCPath detail"` (ucpath); (3) name-search ERROR before rethrow → `personOrgSearchScreenshot` label `"UCPath search failed"` (ucpath); (4) `stampCrmStartDateAndScreenshot` no-records path → `crmSearchScreenshot` label `"no CRM record"` (crm); (5) EID CRM search ERROR → `crmSearchScreenshot` label `"CRM search failed"` (crm); (6) name-search CRM ERROR → `crmSearchScreenshot` label `"CRM search failed"` (crm); (7) name-search empty-CRM-results branch in `crossVerificationStep` → `crmSearchScreenshot` label `"no CRM record"` (crm). On rethrow paths the screenshot always runs BEFORE the throw. **Requires live verification** — screens can only be confirmed with real UCPath/CRM sessions.
