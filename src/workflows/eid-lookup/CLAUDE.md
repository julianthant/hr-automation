# EID Lookup Workflow

Searches UCPath Person Organizational Summary for employees by name, filters for SDCMP business unit + HDH-accepted departments (Housing / Dining / Hospitality keyword match), with CRM cross-verification.

**Kernel-based (daemon mode only).** One active `defineWorkflow`: `eidLookupCrmWorkflow` (UCPath + CRM). Handler steps: `searching` → `cross-verification` (skipped for `{ emplId }` inputs) → **`active-status`** (Person Org disposition / HDH rules — same outcome derivation as standalone Active Check). This variant is wired to dashboard input runs, the daemon registry, and `WORKFLOW_LOADERS`.

Downstream prep flows (OCR orchestrator, etc.) enqueue `{ emplId }` items into this workflow for verify-only lookups — they import `eidLookupCrmWorkflow` / `runEidLookupCli` from this package, not deleted `prepare.ts` shims.

Each dashboard input run enqueues N names as N kernel items to an alive daemon (session is reused so no re-Duo between items). Each name produces its own `pending → running → done/failed` tracker row with per-step timing.

## Selector intelligence

This workflow touches two systems: **ucpath** and **crm**.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`, `"crm name search"`, `"sdcmp filter"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Files

- `schema.ts` — Zod per-item schemas (`EidLookupNameInputSchema` / `EidLookupEidInputSchema`) + `EidLookupItemSchema` union; `normalizeName` helper.
- `crm-search.ts` — CRM cross-verification helpers (`searchCrmByName`, `datesWithinDays`).
- `workflow.ts` — Kernel definition (`eidLookupCrmWorkflow`), `searchingStep`, `crossVerificationStep`, `activeStatusStep`, `runEidLookupCli`, `prepareNames` / `dedupeNames` exports.
- `index.ts` — Barrel exports.

Person Org search + HDH acceptance logic lives in **`src/systems/ucpath/person-org-summary.ts`** (`searchByName`, `searchByEid`, filters) — not a `search.ts` file in this folder.

No `tracker.ts` — dashboard JSONL only. The xlsx tracker was removed on 2026-04-21 (see Lessons Learned).

## Kernel Config (`eidLookupCrmWorkflow`)

| Field | Value |
|-------|-------|
| `systems` | `[ucpath, crm]` |
| `steps` | `["searching", "cross-verification", "active-status"]` |
| `schema` | `EidLookupItemSchema` — `{ name, ... }` **or** `{ emplId, ... }` |
| `authSteps` | `true` — kernel prepends `auth:ucpath`, `auth:crm` |
| `authChain` | `"sequential"` |
| `tiling` | `"auto"` |
| `batch` | `{ mode: "shared-context-pool", poolSize: 4, preEmitPending: true }` |
| `detailFields` | `searchName`, `emplId`, `department`, `hrStatus`, `effdt`, `terminationDate` (declared keys — see `workflow.ts`) |
| `getName` / `getId` | `d.searchName` |
| `initialData` | Name path: `{ searchName: normalizeName(name) }`; EID path: `{ searchName: emplId, emplId }` |

**`crmMatch`**, **`crmMatchedEmplId`**, and the **active-check overlay fields** (`activeStatus`, `isActive`, `isHdhAccepted`, `candidateEids`, `expectedJobEndDate`, …) are written via `ctx.updateData` in the step helpers — useful in JSONL / dashboards — but are **not** listed in `detailFields` (avoids “declared but optional” grid noise).

## Data Flow

```
InputRunPanel → /api/enqueue
  → enqueueFromHttp
    → validate each input with EidLookupItemSchema
    → ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, [{name}])
      - Discovers alive daemons via .tracker/daemons/eid-lookup-*.lock.json + /whoami liveness
      - Spawns a daemon when none is alive — Duo once per new daemon (UCPath + CRM)
      - Inserts SQLite task rows and appends `enqueue` audit events to .tracker/daemons/eid-lookup.queue.jsonl
      - POST /wake to every alive daemon; daemons race to claim via atomic SQLite transaction
      - Each daemon runs items sequentially under shared-context-pool semantics
```

**Public start path:** dashboard input run with semicolon-separated names.

## Shared-context pool semantics

- N workers (default `min(names.length, 4)`) share per-system `BrowserContext`s. Each worker opens its own Page on first `ctx.page(id)` call (lazy allocation).
- Queue-based distribution inside `runWorkflowSharedContextPool` — workers pull items from a shared queue until empty.
- Per-name failures become `failed` tracker rows via `runOneItem`'s catch; the worker continues to the next queue item.
- Duplicate names in an input run should be deduped before enqueue. Duplicate-name requests would collide on the name-derived `itemId`.
- JSONL writes (kernel-owned `trackEvent`) need no coordination — `appendFileSync` is atomic per-line.

## Dashboard integration

- Workflow name: `eid-lookup`
- Steps (per-item): `auth:ucpath` → `auth:crm` → `searching` → `cross-verification` (skipped when input is `{ emplId }`) → **`active-status`**.
  - `authSteps: true` → the kernel prepends per-system `auth:<systemId>` step labels to the visible pipeline. Actual auth timing is **captured once per batch** by a `SessionObserver` wired via `withBatchLifecycle`, then injected into each item's tracker rows as synthetic pre-handler `running` entries with the real `onAuthStart` timestamp. The pool runs auth ONCE but every per-item row tiles exactly to elapsed with accurate per-system durations.
- **Batch instance:** Every item in a batch shares a single workflow instance (e.g. `EID Lookup 1`). `runWorkflowSharedContextPool` emits exactly one `workflow_start` + one `workflow_end(done|failed)` per input-run batch. The dashboard session drawer therefore shows ONE row per batch, not N.
- Detail fields: see `detailFields` in `workflow.ts` — excludes `crmMatch` / active-status extras (those are tracker `updateData` fields for orchestration and OCR panes).
- Item ID on the dashboard = the searched name (deduped). `__name` / `__id` seeded on the initial pending row via `onPreEmitPending` so the row reads correctly before `searching` runs.

## Name Search Strategy

Input is first normalized via `normalizeName` → "Last, First Middle" title-case. Search then tries three strategies in order against the normalized form:

1. Try full name: `lastName, firstName middleName`
2. If no SDCMP candidates: try `lastName, firstName` (drop middle)
3. If still nothing: try `lastName, middleName` (middle as first)

After each successful strategy the SDCMP candidate list is drilled into to fill in department details, then filtered by `isAcceptedDept` (HDH keyword whitelist). A candidate is **only** considered found if its department passes the HDH filter — a SDCMP-BU row at a non-HDH dept (e.g. QUALCOMM INSTITUTE) is rejected and treated as "no result", which lets the CRM-only branch of `crossVerificationStep` surface a better CRM-sourced EID when one exists.

## Gotchas

- PeopleSoft search results table ID: `tdgbrPTS_CFG_CL_STD_RSL$0`
- Valid data rows must have exactly 9 cells with numeric Empl ID (5+ digits) in first cell
- Drill-in selector: `PTS_CFG_CL_RSLT_PTS_DRILLIN$40$$IMG${rowIndex}` — row index must be exact
- Assignment table scan: finds first row with 12+ cells where cell[3] matches business unit pattern (4-5 uppercase chars + optional digit) and cell[6] is department description
- "View All" button may need re-clicking after drill-in if results are paginated (rowIndex > 10)
- CRM search uses different strategy: last name first, then first name
- CRM date matching uses ±7 day tolerance for hire date comparison
- Each worker gets its own UCPath tab AND its own CRM tab — concurrent CRM name searches on separate pages. If ACT CRM ever rate-limits, the remedy is to collapse `cross-verification` into a post-pool pass (separate step list, single CRM page).
- Browsers kept open for inspection (no automatic close past `parent.close()` at end of pool)
- Only the FIRST SDCMP result per name stamps the detail fields; the full result list lives in the step log output. Multi-result names are rare (one employee ≈ one SDCMP record).

## Verified Selectors

No workflow-local selectors live here. Use the UCPath and CRM system selector catalogs listed above; add selector lessons to the relevant system `LESSONS.md` after searching/updating existing entries.

## Lessons Learned

- **Lesson maintenance rule:** Search this section and the UCPath/CRM system docs before adding EID lookup guidance. Merge old variant/removal notes into the current daemon-only CRM workflow shape.
- **Runtime policy leaves utility child flattening to OCR.** `EID_LOOKUP_WORKFLOW_RUNTIME_POLICY` uses default row actions and `memberRow.titleSource: "person"`; OCR controls whether utility children render flat via its own runtime policy.
- **2026-05-25: Dashboard input run is the public start path.** `npm run eid-lookup` is retired; typed name starts belong in `InputRunPanel` and `/api/enqueue`. The removed `--no-crm`, `--i9`, and legacy non-daemon variants should not be restored. If I-9 signer lookup is needed again, add a separate daemon workflow shape.
- **Normalize and dedupe names before enqueue.** `normalizeName` title-cases `Last, First Middle` and canonicalizes the separator to `", "`; `prepareNames` drops duplicates after normalization so item ids do not collide.
- **HDH acceptance is department-level, not BU-level.** SDCMP alone is too broad. `src/systems/ucpath/person-org-summary.ts` filters department descriptions by HDH keywords; rejected SDCMP/non-HDH rows should log why they were ignored so CRM-only fallback can surface the better EID.
- **Shared-context pool is the current batch model.** One UCPath/CRM auth pair per batch, N worker tabs, one dashboard row per name, one workflow instance per input-run batch, and synthetic auth timings injected into each item. Excel tracking is gone; JSONL/dashboard are the only observability.
