# Active Check Workflow

Checks UCPath **Person Organizational Summary** for active/inactive HR status by employee **name** or **8-digit EID**, using `searchByName` / `searchByEid` (`src/systems/ucpath/person-org-summary.js`) with outcome derivation in `deriveActiveCheckOutcome` (`src/domain/active-check-outcome.ts`). Name search uses `keepNonHdh: true` so non-HDH rows can surface for operator review; EID search drills a single row set.

**Kernel-based (daemon mode by default)** — `activeCheckWorkflow` in `workflow.ts`, CLI via `runActiveCheckCli` (`buildCliAdapter`).

## Selector intelligence

This workflow touches **ucpath** only.

- Before mapping or remapping any selector, run `npm run selector:search "<intent>"` (e.g. `"person org summary"`).
- Per-system lessons: [`src/systems/ucpath/LESSONS.md`](../../systems/ucpath/LESSONS.md)
- Catalog: [`src/systems/ucpath/SELECTORS.md`](../../systems/ucpath/SELECTORS.md)

## Files

- `schema.ts` — `ActiveCheckItemSchema` (name **or** `emplId` per-item), `buildActiveCheckCliInput`, `deriveActiveCheckItemId`, display helpers.
- `workflow.ts` — `defineWorkflow` (`activeCheckWorkflow`), `runActiveCheck`, `runActiveCheckCli`.
- `index.ts` — Barrel exports.

## Kernel config (`activeCheckWorkflow`)

| Field | Value |
|-------|-------|
| `systems` | `[ucpath]` |
| `steps` | `["checking"]` |
| `schema` | `ActiveCheckItemSchema` |
| `authChain` | `"sequential"` |
| `authSteps` | default (`true`) — kernel prepends `auth:ucpath` before `checking` |
| `batch` | `{ mode: "shared-context-pool", poolSize: 4, preEmitPending: true }` |
| `detailFields` | `name`, `emplId`, `hrStatus`, `effdt`, `terminationDate`, `department` |

## Data flow / CLI

```
npm run active-check "Last, First Middle" [more names or EIDs...] [--new] [--parallel N]
npm run active-check 10873698
npm run active-check:stop
```

- Positional tokens: strings of digits (after normalize) that look like an 8-digit EID are treated as **EID**; otherwise **name** (see `buildActiveCheckCliInput`).
- Multi-item CLI uses a shared parent run id + `batchDisplayOrdinal` for dashboard batch grouping (`allocateLowestBatchDisplayOrdinal`).
- Daemons claim work via the shared SQLite queue like other daemon-mode workflows (see `src/core/CLAUDE.md`).

## Inputs and outputs

- **Inputs (per item):** `{ name }` or `{ emplId, name? }` — see `ActiveCheckItemSchema` in `schema.ts`.
- **Outputs:** `ActiveCheckOutcome` from `src/domain/active-check-outcome.ts` — merged into tracker `data` (`activeStatus`, `isActive`, `isHdhAccepted`, `emplId`, `hrStatus`, `department`, `candidateEids`, stringified booleans for grid columns, etc.). On success with results, a Person Org screenshot may be captured (`person-org-summary-active-check`).

## Shared-context pool

Same topology as **eid-lookup**: up to 4 workers share UCPath browser contexts; items are pulled from a queue until empty. See [`src/workflows/eid-lookup/CLAUDE.md`](../eid-lookup/CLAUDE.md) → Shared-context pool semantics for general behavior.

## Operator notes

*(Empty — when something non-obvious surfaces, search this file and the UCPath system docs first. Add a new lesson only if no existing entry can be updated or merged.)*

## Lessons Learned

- **2026-05-20: Runtime policy mirrors eid-lookup utility defaults.** `ACTIVE_CHECK_WORKFLOW_RUNTIME_POLICY` spreads the shared default policy and sets `memberRow.titleSource: "person"` for OCR utility children. Direct `npm run active-check` rows stay normal surfaces; OCR fan-out flatness comes from the OCR parent policy's `utilityChildWorkflows` list.
