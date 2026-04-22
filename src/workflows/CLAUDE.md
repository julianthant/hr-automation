# Workflows — Orchestration Layer

Each subdirectory is one composed workflow. As of 2026-04-17, every workflow is kernel-based: it declares its shape via `defineWorkflow` in `workflow.ts` and is run by `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` in `src/core/`. The legacy `defineDashboardMetadata` / inline `withTrackedWorkflow` shape is retained in `src/core/` only as a registration affordance for any future non-kernel workflow that lands — no caller in `src/workflows/*` uses it today.

See the root `CLAUDE.md` "Writing a new workflow" section for the minimal `defineWorkflow` example. This file lists what's specific to this directory.

## Directory layout

```
src/workflows/{name}/
  schema.ts      # Zod input validation + any data-transform helpers
  workflow.ts    # defineWorkflow(...) + CLI adapter (runMyWorkflow)
  enter.ts       # ActionPlan builder (UCPath workflows) — optional
  config.ts      # Workflow-specific constants
  index.ts       # Barrel exports (legacy workflows also call defineDashboardMetadata here)
  CLAUDE.md      # This module's doc (template: what / data flow / kernel config / gotchas / lessons)
```

Do **not** create `tracker.ts` for new workflows. The kernel's JSONL emissions + dashboard are the only observability. Pre-kernel workflows that still have `tracker.ts` (onboarding, work-study, eid-lookup, kronos-reports) — leave those alone for now, but don't add new ones. Separations never had one.

## Dashboard Integration (kernel — automatic)

Declare `label`, `getName`, `getId`, and labeled `detailFields` inside `defineWorkflow({ ... })`. Every key you list in `detailFields` should be populated by at least one `ctx.updateData({ [key]: ... })` call before the handler returns — a runtime `log.warn` fires if not. That's the entire dashboard wiring for kernel workflows.

Legacy workflows would call `defineDashboardMetadata({ name, label, steps, systems, detailFields })` at module load in `index.ts`, but as of 2026-04-17, all workflows (including onboarding's parallel mode, migrated to kernel pool mode) are kernel-based — no `defineDashboardMetadata` callers remain in `src/workflows/*`. New workflows must follow the kernel path exclusively.

Add the workflow's step list to the "Step Tracking Per Workflow" table in root `CLAUDE.md` for documentation. Frontend requires no edits — the dashboard reads everything from the server-side registry via `/api/workflow-definitions`.

## CLI Integration

Add a Commander subcommand to `src/cli.ts` invoking your workflow's CLI adapter. Add both normal and `:dry` variants to `package.json`.

## Existing Workflows

| Workflow | CLI | Systems | Kernel? | Parallelism |
|---|---|---|---|---|
| onboarding | `npm run start-onboarding` | CRM, UCPath, I9 | Yes | Pool mode (N workers, kernel) via `runWorkflowBatch` |
| separations | `npm run separation` | Kuali, Old Kronos, New Kronos, UCPath | Yes (sequential batch via runWorkflowBatch) | 4 tiled browsers, interleaved auth, ctx.parallel for Phase-1 4-way fan-out |
| eid-lookup | `tsx src/cli.ts eid-lookup` | UCPath + optional CRM | Yes | N tabs in one shared context (runWorkerPool in handler) |
| old-kronos-reports | `npm run kronos` | UKG | Yes | Pool mode (N workers, kernel) |
| work-study | `npm run work-study` | UCPath | Yes | Single |
| emergency-contact | `npm run emergency-contact` | UCPath | Yes (batch, `preEmitPending`) | Single browser, one record at a time |
| sharepoint-download | _Dashboard button_ / `tsx src/workflows/emergency-contact/scripts/download-roster.ts` | SharePoint | **No** (intentionally non-kernel — operator utility, not an HR record) | Single (headed browser, gated by Duo) |

### Non-kernel workflow exception: `sharepoint-download/`

This is the **only** directory under `src/workflows/` that deliberately does NOT call `defineWorkflow` — it's a one-shot operator utility (the dashboard queue-header Download button + emergency-contact pre-flight roster download) that produces a file, not a tracker record. Because it has no `defineWorkflow` registration and writes no `.tracker/*.jsonl` files, it never surfaces in the TopBar dropdown (the dropdown unions `registered` + `listWorkflows()` — both ignore it). See `src/workflows/sharepoint-download/CLAUDE.md` for when to NOT copy this pattern.

## Lessons Learned

- **2026-04-10: Batch mode pattern for sequential processing** — For workflows that reuse browser sessions across multiple items (e.g. separations, emergency-contact), the pattern is: (1) pre-emit `pending` for all items with pre-assigned `runId`s (kernel: `preEmitPending: true` + `onPreEmitPending` callback), (2) auth once, (3) process each item sequentially. The kernel's `runWorkflowBatch` does this declaratively; legacy workflows wire `preAssignedRunId` into `withTrackedWorkflow` manually.
- **2026-04-10: ensurePageHealthy() before each phase (historical, legacy workflows)** — SAML errors and session expiry can happen silently between phases. Pre-kernel workflows wrapped each major phase with `ensurePageHealthy()` from `src/core/page-health.ts`. Removed 2026-04-18 — every workflow is now kernel-based, and the kernel's `Session.launch` retries failed auth up to 3 attempts. Don't reach for `ensurePageHealthy` — use `ctx.session.healthCheck(id)` if you need an explicit mid-handler probe.
