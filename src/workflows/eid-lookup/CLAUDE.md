# EID Lookup Workflow

Searches UCPath Person Organizational Summary for employees by name, filters for SDCMP business unit and Housing/Dining/Hospitality departments, with optional CRM cross-verification.

**Kernel-based (shared-context-pool mode).** Two `defineWorkflow` definitions in `workflow.ts`:
- `eidLookupWorkflow` (no-CRM): 1 system (UCPath), 1 handler step per item (`searching`)
- `eidLookupCrmWorkflow` (CRM-on): 2 systems (UCPath + CRM, sequential auth), 2 handler steps per item (`searching` → `cross-verification`)

Each CLI invocation runs N names as N kernel items concurrently: one browser per system + one Duo per system for the whole pool, N per-worker tabs spawned lazily from each system's shared `BrowserContext`. Each name produces its own `pending → running → done/failed` tracker row in the dashboard with per-step timing.

## Selector intelligence

This workflow touches two systems: **ucpath**, **crm** (CRM only in `--crm` mode).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`, `"crm name search"`, `"sdcmp filter"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)

## Files

- `schema.ts` — Zod schemas. `EidLookupItemSchema` = per-kernel-item shape (`{ name }`); `EidLookupInputSchema` / `EidLookupCrmInputSchema` = legacy CLI-boundary batch shape (`{ names, workers }`) kept for backward compatibility.
- `search.ts` — Multi-strategy name search (`searchByName`, `parseNameInput`): "Last, First Middle" → tries full → first → middle, drills into SDCMP results, filters by HDH keywords. Kernel-agnostic.
- `crm-search.ts` — CRM cross-verification helpers (`searchCrmByName`, `datesWithinDays`): last/first name search, extracts PPS ID + UCPath EID + hire date + dept, ±7 day date matching. Kernel-agnostic.
- `workflow.ts` — Kernel definitions (`eidLookupWorkflow`, `eidLookupCrmWorkflow`) + shared step helpers (`searchingStep`, `crossVerificationStep`) + CLI adapter (`runEidLookup`) + `dedupeNames` helper. Dry-run branch bypasses the kernel.
- `index.ts` — Barrel exports.

No `tracker.ts` — dashboard JSONL only. The xlsx tracker was removed on 2026-04-21 (see Lessons Learned).

## Kernel Config

| Field | `eidLookupWorkflow` | `eidLookupCrmWorkflow` |
|-------|---------------------|------------------------|
| `systems` | `[ucpath]` | `[ucpath, crm]` |
| `steps` | `["searching"]` | `["searching", "cross-verification"]` |
| `schema` | `EidLookupItemSchema` | `EidLookupItemSchema` |
| `authSteps` | `false` | `false` |
| `authChain` | `"sequential"` | `"sequential"` |
| `tiling` | `"single"` | `"auto"` |
| `batch` | `{ mode: "shared-context-pool", poolSize: 4, preEmitPending: true }` | same |
| `detailFields` | `searchName, emplId, department, jobTitle` | `+ crmMatch` |
| `getName` / `getId` | `d.searchName` | `d.searchName` |
| `initialData` | `{ searchName: input.name }` | same |

## Data Flow

```
CLI: tsx src/cli.ts eid-lookup "Last, First Middle" [...] [--no-crm] [--workers N] [--dry-run]
  → runEidLookup (CLI adapter)
    → if --dry-run: log planned name list + CRM mode, exit 0 (no browser)
    → dedupeNames: drop + warn on exact duplicates
    → names.map(n => ({ name: n }))  → kernel items
    → onPreEmitPending: trackEvent("pending") per item with searchName seeded
    → runWorkflowBatch(wf, items, { poolSize: workers, deriveItemId, onPreEmitPending })
      → Dispatch to runWorkflowSharedContextPool
        → Session.launch([ucpath(, crm)]) ONCE: 1-2 browsers, Duo ×1 or ×2
        → N workers, each a Session.forWorker view of the parent:
          - Lazy per-worker Page opens on first ctx.page(id) from shared context
          - runOneItem wraps each item in withTrackedWorkflow
          - handler: updateData({ searchName }); step("searching", ...)
                     [CRM mode] step("cross-verification", ...)
          - step failures become per-item `failed` tracker rows; batch continues
        → Worker teardown: closeWorkerPages (no context/browser close)
      → Parent session.close: close contexts + browsers exactly once
    → Final log: "N/M succeeded, K failed"
```

## Shared-context pool semantics

- N workers (`--workers`, default `min(names.length, 4)`) share per-system `BrowserContext`s. Each worker opens its own Page on first `ctx.page(id)` call (lazy allocation).
- Queue-based distribution inside `runWorkflowSharedContextPool` — workers pull items from a shared queue until empty.
- Per-name failures become `failed` tracker rows via `runOneItem`'s catch; the worker continues to the next queue item.
- Duplicate names in the CLI input are deduped at the adapter level (warn + drop). Duplicate-name requests would collide on the name-derived `itemId`.
- JSONL writes (kernel-owned `trackEvent`) need no coordination — `appendFileSync` is atomic per-line.

## Dashboard integration

- Workflow name: `eid-lookup`
- Steps (per-item): `["searching"]` no-CRM / `["searching", "cross-verification"]` CRM mode.
  - One-time auth runs BEFORE the pool starts and does NOT emit per-item auth rows.
- Detail fields: `searchName, emplId, department, jobTitle` (+ `crmMatch` in CRM mode).
- Item ID on the dashboard = the searched name (deduped). `__name` / `__id` seeded on the initial pending row via `onPreEmitPending` so the row reads correctly before `searching` runs.

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
- Each worker gets its own UCPath tab AND its own CRM tab — concurrent CRM name searches on separate pages. If ACT CRM ever rate-limits, revert is to collapse `cross-verification` into a post-pool pass (separate step list, single CRM page).
- Browsers kept open for inspection (no automatic close past `parent.close()` at end of pool)
- Only the FIRST SDCMP result per name stamps the detail fields; the full result list lives in the step log output. Multi-result names are rare (one employee ≈ one SDCMP record).

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-21: Shared-context-pool + xlsx removal.** Replaced the handler-side `runWorkerPool` with the kernel's new `batch.mode: "shared-context-pool"`. TData is now `{ name: string }` — one kernel item per name, one dashboard row per name, same "1 Duo per system, N tabs" browser topology. CRM cross-verification moved inside the per-item handler (was a post-pool pass). Excel tracker (`tracker.ts` + `eid-lookup-tracker.xlsx`) fully removed — JSONL + dashboard are the only observability. `async-mutex` use dropped with the xlsx writes. Kernel addition: `Session.forWorker(parent)` + lazy `page(id)` branch + `closeWorkerPages()`. **Live run pending user verification** — UCPath + CRM Duo can't be approved this session; dry-run + unit tests validate this migration.
- **2026-04-17: Migrated to kernel (historical).** First kernel cut used `runWorkerPool` inside `ctx.step("searching", ...)` as a helper. One workflow run per CLI invocation; per-name JSONL rows were the "Acceptable regression" closed by the 2026-04-21 change. Left here to explain why `search.ts` / `crm-search.ts` are kernel-agnostic helpers (they were authored before the kernel existed and survive the 2026-04-21 rewrite untouched).
