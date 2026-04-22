# EID Lookup Workflow

Searches UCPath Person Organizational Summary for employees by name, filters for SDCMP business unit + HDH-accepted departments (Housing / Dining / Hospitality keyword match), with optional CRM cross-verification and optional I-9 Section 2 signer lookup.

**Kernel-based (shared-context-pool mode for `--direct`, daemon mode by default).** Four `defineWorkflow` definitions in `workflow.ts`, one per feature combination — the CLI picks the right one based on `--no-crm` / `--i9` flags:
- `eidLookupWorkflow` (no CRM, no I9): 1 system (UCPath), 1 step — `searching`
- `eidLookupCrmWorkflow` (CRM on): 2 systems (UCPath + CRM), 2 steps — `searching` → `cross-verification` **← daemon-mode default**
- `eidLookupI9Workflow` (I9 on, no CRM): 2 systems (UCPath + I9), 2 steps — `searching` → `i9-signer-lookup`
- `eidLookupCrmI9Workflow` (CRM + I9): 3 systems (UCPath + CRM + I9), 3 steps — `searching` → `cross-verification` → `i9-signer-lookup`

Each CLI invocation runs N names as N kernel items: in daemon mode one-at-a-time per alive daemon (session is reused across batches so no re-Duo); in `--direct` / `--no-crm` / `--i9` mode N workers fan out across per-worker tabs spawned lazily from each system's shared `BrowserContext`. Each name produces its own `pending → running → done/failed` tracker row in the dashboard with per-step timing.

## Selector intelligence

This workflow touches up to three systems: **ucpath** (always), **crm** (in default or `--i9` mode; skipped by `--no-crm`), **i9** (only with `--i9`).

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`, `"crm name search"`, `"sdcmp filter"`, `"i9 summary signer"`).
- Per-system lessons (read before re-mapping):
  - [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
  - [`src/systems/crm/LESSONS.md`](../../systems/crm/LESSONS.md)
  - [`src/systems/i9/LESSONS.md`](../../systems/i9/LESSONS.md)
- Per-system catalogs (auto-generated):
  - [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)
  - [`src/systems/crm/SELECTORS.md`](../../systems/crm/SELECTORS.md)
  - [`src/systems/i9/SELECTORS.md`](../../systems/i9/SELECTORS.md)

## Files

- `schema.ts` — Zod schemas + `normalizeName` (title-case "Last, First Middle" normalizer applied at every CLI entry point). `EidLookupItemSchema` = per-kernel-item shape (`{ name }`); `EidLookupInputSchema` / `EidLookupCrmInputSchema` = legacy CLI-boundary batch shape (`{ names, workers }`) kept for backward compatibility.
- `search.ts` — Multi-strategy name search (`searchByName`, `parseNameInput`): "Last, First Middle" → tries full → first → middle, drills into SDCMP candidates, then applies `isAcceptedDept` (HDH keyword whitelist: housing / dining / hospitality) to narrow to the accepted subset. Kernel-agnostic.
- `crm-search.ts` — CRM cross-verification helpers (`searchCrmByName`, `datesWithinDays`): last/first name search, extracts PPS ID + UCPath EID + hire date + dept, ±7 day date matching. Kernel-agnostic.
- `workflow.ts` — Kernel definitions (`eidLookupWorkflow`, `eidLookupCrmWorkflow`, `eidLookupI9Workflow`, `eidLookupCrmI9Workflow`) + shared step helpers (`searchingStep`, `crossVerificationStep`, `i9SignerStep`) + CLI adapters: `runEidLookup` (legacy in-process) and `runEidLookupCli` (daemon-mode — default for `npm run eid-lookup`). Also `dedupeNames` + `prepareNames` (normalize + dedupe). I-9 lookup delegates to `src/systems/i9/signer.ts::lookupSection2Signer`. Dry-run branch bypasses kernel + daemon.
- `index.ts` — Barrel exports.

No `tracker.ts` — dashboard JSONL only. The xlsx tracker was removed on 2026-04-21 (see Lessons Learned).

## Kernel Config

| Field | `eidLookupWorkflow` | `eidLookupCrmWorkflow` | `eidLookupI9Workflow` | `eidLookupCrmI9Workflow` |
|-------|---------------------|------------------------|------------------------|--------------------------|
| `systems` | `[ucpath]` | `[ucpath, crm]` | `[ucpath, i9]` | `[ucpath, crm, i9]` |
| `steps` | `["searching"]` | `["searching", "cross-verification"]` | `["searching", "i9-signer-lookup"]` | `["searching", "cross-verification", "i9-signer-lookup"]` |
| `schema` | `EidLookupItemSchema` | same | same | same |
| `authSteps` | `true` | `true` | `true` | `true` |
| `authChain` | `"sequential"` | `"sequential"` | `"sequential"` | `"sequential"` |
| `tiling` | `"single"` | `"auto"` | `"auto"` | `"auto"` |
| `batch` | `{ mode: "shared-context-pool", poolSize: 4, preEmitPending: true }` | same | same | same |
| `detailFields` | `searchName, emplId, department` | `+ crmMatch` | `+ i9Signer, i9Status` | `+ crmMatch, i9Signer, i9Status` |
| `getName` / `getId` | `d.searchName` | same | same | same |
| `initialData` | `{ searchName: input.name }` | same | same | same |

## Data Flow

```
CLI: npm run eid-lookup "Last, First Middle" [...] [--new] [--parallel N]       (daemon mode — default)
  → runEidLookupCli (daemon-mode CLI adapter)
    → prepareNames: normalizeName(n) → dedupeNames (drop + warn on dup post-normalize)
    → if --dry-run: log normalized + deduped name list, exit 0 (no browser, no spawn)
    → else: ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, [{name}], { new, parallel })
      - Discovers alive daemons via .tracker/daemons/eid-lookup-*.lock.json + /whoami liveness
      - Spawns N additional daemons via computeSpawnPlan(aliveCount, flags) — Duo once per new daemon (UCPath + CRM)
      - Validates every input with EidLookupItemSchema, fails fast if invalid
      - Appends `enqueue` events to .tracker/daemons/eid-lookup.queue.jsonl
      - POST /wake to every alive daemon; daemons race to claim via fs.mkdir mutex

CLI: npm run eid-lookup:direct | --direct | --no-crm | --i9   (legacy in-process path)
  → runEidLookup (legacy CLI adapter)
    → prepareNames: normalizeName(n) → dedupeNames
    → if --dry-run: log planned name list + CRM/I9 mode, exit 0 (no browser)
    → names.map(n => ({ name: n }))  → kernel items
    → onPreEmitPending: trackEvent("pending") per item with searchName seeded
    → workflow = pickBy(useCrm, useI9) over the 4 kernel variants
    → runWorkflowBatch(workflow, items, { poolSize: workers, deriveItemId, onPreEmitPending })
      → Dispatch to runWorkflowSharedContextPool
        → Session.launch([ucpath(, crm)(, i9)]) ONCE: 1–3 browsers, Duo ×1–2 (I9 has no Duo)
        → N workers, each a Session.forWorker view of the parent:
          - Lazy per-worker Page opens on first ctx.page(id) from shared context
          - runOneItem wraps each item in withTrackedWorkflow
          - handler: updateData({ searchName }); step("searching", ...)
                     [CRM mode] step("cross-verification", ...)
                     [I9 mode]  step("i9-signer-lookup", ...)
          - step failures become per-item `failed` tracker rows; batch continues
        → Worker teardown: closeWorkerPages (no context/browser close)
      → Parent session.close: close contexts + browsers exactly once
    → Final log: "N/M succeeded, K failed"
```

### Daemon-mode rules

- **Default variant**: `eidLookupCrmWorkflow` (UCPath + CRM, no I-9). `src/cli-daemon.ts::WORKFLOWS["eid-lookup"]` hard-wires this — a daemon's `Session` is launched with a fixed systems list, so only ONE variant can run per daemon.
- **`--no-crm` / `--i9` force `--direct`**: These flags change the systems list, which the daemon can't accommodate mid-life. The CLI router announces the override (`[eid-lookup] --i9 forces --direct mode…`) and routes to `runEidLookup`.
- **Commands**:
  - `npm run eid-lookup "Last, First" [more...]` — enqueue to alive daemon (or spawn one).
  - `npm run eid-lookup -- "Last, First" -p 2` — two parallel daemons sharing the queue.
  - `npm run eid-lookup -- "Last, First" -n` — force-spawn a new daemon.
  - `npm run eid-lookup:direct "Last, First" [--no-crm|--i9|--workers N]` — legacy path.
  - `npm run eid-lookup:status` / `:stop` / `:attach` — daemon control-plane.

## Shared-context pool semantics

- N workers (`--workers`, default `min(names.length, 4)`) share per-system `BrowserContext`s. Each worker opens its own Page on first `ctx.page(id)` call (lazy allocation).
- Queue-based distribution inside `runWorkflowSharedContextPool` — workers pull items from a shared queue until empty.
- Per-name failures become `failed` tracker rows via `runOneItem`'s catch; the worker continues to the next queue item.
- Duplicate names in the CLI input are deduped at the adapter level (warn + drop). Duplicate-name requests would collide on the name-derived `itemId`.
- JSONL writes (kernel-owned `trackEvent`) need no coordination — `appendFileSync` is atomic per-line.

## Dashboard integration

- Workflow name: `eid-lookup`
- Steps (per-item): `["searching"]` no-CRM / `["searching", "cross-verification"]` CRM mode.
  - `authSteps: true` → the kernel prepends per-system `auth:<systemId>` step labels to the visible pipeline. Actual auth timing is **captured once per batch** by a `SessionObserver` wired via `withBatchLifecycle`, then injected into each item's tracker rows as synthetic pre-handler `running` entries (step = `auth:ucpath`, `auth:crm`) with the real `onAuthStart` timestamp. The pool runs auth ONCE but every per-item row tiles exactly to elapsed with accurate per-system durations.
- **Batch instance (2026-04-21):** Every item in a batch shares a single workflow instance (e.g. `EID Lookup 1`). `runWorkflowSharedContextPool` emits exactly one `workflow_start` + one `workflow_end(done|failed)` per CLI invocation. The dashboard's SessionPanel therefore shows ONE row per batch, not N.
- Detail fields: `searchName, emplId, department, jobTitle` (+ `crmMatch` in CRM mode).
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
- Each worker gets its own UCPath tab AND its own CRM tab — concurrent CRM name searches on separate pages. If ACT CRM ever rate-limits, revert is to collapse `cross-verification` into a post-pool pass (separate step list, single CRM page).
- Browsers kept open for inspection (no automatic close past `parent.close()` at end of pool)
- Only the FIRST SDCMP result per name stamps the detail fields; the full result list lives in the step log output. Multi-result names are rare (one employee ≈ one SDCMP record).

## Verified Selectors

*(Add selectors here after each playwright-cli mapping session — include date and page)*

## Lessons Learned

- **2026-04-22: Daemon mode + HDH dept filter + name normalization.** Three bugs surfaced after the first live `zaw, hein thant` lookup: (1) the CLI didn't run in daemon mode — every invocation re-Duo'd UCPath + CRM; (2) the dashboard showed "zaw, hein thant" verbatim; (3) UCPath surfaced an old QUALCOMM INSTITUTE appointment (EID 10417041, ended 08/12/2020) as if it were the active match even though CRM had the correct current-HDH EID (10848110). Root causes + fixes:
  - **Daemon mode**: added `runEidLookupCli` adapter on the same template as `runSeparationCli` / `runWorkStudyCli` and registered `"eid-lookup": eidLookupCrmWorkflow` in `src/cli-daemon.ts::WORKFLOWS`. The daemon hard-wires the default CRM-on variant because `Session` systems are fixed at spawn; `--no-crm` and `--i9` force `--direct` (with an announcing log line). CLI gets `-n / -p / --direct`, plus npm scripts `eid-lookup`, `eid-lookup:dry`, `eid-lookup:direct`, `eid-lookup:status`, `eid-lookup:stop`, `eid-lookup:attach`.
  - **Name normalization**: `normalizeName(raw)` in `schema.ts` title-cases "Last, First Middle" and canonicalizes the separator to `", "`. Applied via `prepareNames` (= `map(normalizeName) → dedupeNames`) at BOTH CLI entry points (`runEidLookup` AND `runEidLookupCli`). UCPath/CRM forms are case-insensitive so title-casing doesn't affect matching; the win is on display (`searchName`), the `deriveItemId` key, and dedupe (case-insensitive duplicates now collapse).
  - **HDH dept filter**: the old filter was `r.businessUnit === "SDCMP"` which is BU-level, not dept-level — QUALCOMM INSTITUTE is SDCMP so it passed. Added `isAcceptedDept(dept)` in `search.ts` (keyword whitelist: `housing | dining | hospitality`, substring, case-insensitive). `searchByName` now drills into every SDCMP candidate to populate dept, then filters by `isAcceptedDept`. Rejected rows are logged (`"Filtered out 2 non-HDH SDCMP result(s): EID … (QUALCOMM INSTITUTE), …"`). This ALSO fixes the "CRM match = none" display: when `sdcmp.length === 0` after the HDH filter, `crossVerificationStep`'s CRM-only branch fires, stamps the CRM-sourced EID, and sets `crmMatch: "crm-only"` instead of `"none"`.
- **2026-04-22: `--i9` Section 2 signer lookup.** Added two new kernel variants (`eidLookupI9Workflow`, `eidLookupCrmI9Workflow`) that add I-9 Complete as a second/third system, plus `i9SignerStep` that delegates to `src/systems/i9/signer.ts::lookupSection2Signer`. Signer sourced from the "Electronic I-9 Audit Trail" row whose event cell reads "Signed Section 2" (4th cell = Created By); mapped live on 2026-04-22 against profile 2082422 via `/form-I9/summary/{profileId}/{i9Id}?isRemoteAccess=False`. Historical (paper) records land on `/form-I9-historical/…` and lack the signed-section-2 row — those are surfaced as `i9Status=historical` rather than conflating with "unsigned". `i9Signer` is always a non-empty human-readable string (signer name / "Not signed" / "Historical (paper)" / "Not found in I-9" / error detail) so the dashboard detail cell never em-dashes for a completed lookup. I-9 login is email+password, no Duo, so the extra system adds zero MFA overhead.
- **2026-04-21: Batch-level instance + injected authTimings.** Shared-context-pool now runs inside `withBatchLifecycle` (`src/core/batch-lifecycle.ts`). One `workflow_start` / `workflow_end` per batch instead of N. A single `SessionObserver` captures `authTimings` during `Session.launch`; those timings are passed to every `runOneItem` call and become synthetic pre-handler `running` entries (`auth:ucpath`, `auth:crm`) with real start timestamps. Sum of step durations now tiles exactly to the per-item elapsed. SIGINT mid-batch fans out `failed` tracker rows for every un-terminated item and emits one `workflow_end(failed)`. `authSteps` was always `true` in code — earlier doc listed `false`, which was wrong.
- **2026-04-21: Shared-context-pool + xlsx removal.** Replaced the handler-side `runWorkerPool` with the kernel's new `batch.mode: "shared-context-pool"`. TData is now `{ name: string }` — one kernel item per name, one dashboard row per name, same "1 Duo per system, N tabs" browser topology. CRM cross-verification moved inside the per-item handler (was a post-pool pass). Excel tracker (`tracker.ts` + `eid-lookup-tracker.xlsx`) fully removed — JSONL + dashboard are the only observability. `async-mutex` use dropped with the xlsx writes. Kernel addition: `Session.forWorker(parent)` + lazy `page(id)` branch + `closeWorkerPages()`. **Live run pending user verification** — UCPath + CRM Duo can't be approved this session; dry-run + unit tests validate this migration.
- **2026-04-17: Migrated to kernel (historical).** First kernel cut used `runWorkerPool` inside `ctx.step("searching", ...)` as a helper. One workflow run per CLI invocation; per-name JSONL rows were the "Acceptable regression" closed by the 2026-04-21 change. Left here to explain why `search.ts` / `crm-search.ts` are kernel-agnostic helpers (they were authored before the kernel existed and survive the 2026-04-21 rewrite untouched).
