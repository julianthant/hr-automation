# Workflows

Every workflow is kernel-based. Declare shape via `defineWorkflow` in `workflow.ts`; run through `runWorkflow`, `runWorkflowBatch`, or `runWorkflowPool` from `src/core/`.

## New Workflow Rules

- `defineWorkflow` owns `name`, `label`, `archetype`, `runtimePolicy`, `systems`, `steps`, `schema`, `tiling`, `detailFields`, display-name/id helpers, operator subject, and handler.
- The kernel owns browser launch, Duo-aware auth, tracker emissions, screenshots on step failure, SIGINT cleanup, batch/pool wrapping, and dashboard registry data.
- Do not add Commander subcommands or package scripts for operator starts. Public starts are dashboard input/upload runs.
- Do not create workflow-local `tracker.ts`; kernel JSONL emissions + dashboard are the observability surface. The only grandfathered workflow tracker is `old-kronos-reports/tracker.ts`.

## Kernel Contracts

- `ctx.page(id)` returns a Playwright Page proxy that injects per-run `ctx.signal` into Playwright methods with `signal?: AbortSignal`. Do not add handler-side cancel polling for ordinary browser calls.
- For non-Playwright awaits that accept an `AbortSignal`, pass `ctx.signal`.
- Compose workflows with `ctx.delegateTo` and `ctx.delegateToAll`. Do not call `runWorkflow(child, ..., { parentRunId })` or `ensureDaemonsAndEnqueue(child, ..., { parentRunId })` directly inside handlers; architecture guards block this.
- `renderAs` is projection-only: `"flat"`, `"preview"`, or `"batch"` changes dashboard presentation, not stamped row archetype.

## Dashboard Integration

- Declare `label`, `getName`, `getId`, and labeled `detailFields` in `defineWorkflow`.
- Every `detailFields` key should be populated by `ctx.updateData`; a runtime `log.warn` fires if a declared field never appears.
- Input runs: add the workflow to `DASHBOARD_INPUT_RUN_WORKFLOWS`, configure `src/dashboard/lib/input-run-registry.ts`, and ensure `src/core/workflow-loaders.ts` resolves it for `/api/enqueue`.
- Upload runs: add the workflow to `DASHBOARD_UPLOAD_RUN_WORKFLOWS` and configure `src/dashboard/lib/run-modal-registry.ts`.
- Add a `:stop` script only for workflows with long-lived daemons.

## Archetypes

Every workflow must declare `archetype` and `runtimePolicy`; architecture guards fail if either is missing. Spread `DEFAULT_WORKFLOW_RUNTIME_POLICY` unless the workflow needs delegation, preview, memberRow, or prepRow overrides.

- `single` — one item, one row.
- `preview` — one review/approval row; OCR is the current preview workflow.
- `batch` — anchor row over peer `batch-member` rows.
- `parentRunId` means delegated scope only; it never changes stamped row shape.
- Dispatch markers are `single` rows with `data.delegationRole = "dispatch"` for terminal-at-enqueue handoffs.

## Shared Ownership

Workflow-local functions describe orchestration steps. Reusable behavior belongs in `src/domain/`, `src/core/`, `src/services/ocr/forms/`, or the relevant `src/systems/` module. If another workflow could use it, promote it.

Internal helper workflow modules may live under `src/workflows/<name>/` without being operator-startable. They must stay out of `WORKFLOW_LOADERS` and dashboard run-surface lists. `src/workflows/person-lookup/` is the operator-facing merged workflow (formerly EID Lookup + Active Check); it is registered in `WORKFLOW_LOADERS` and dashboard input runs, and also exports the `lookupPersonInUcpath` primitive for internal callers (OCR orchestrator, force-research, retry-page).

## Opt-Ins

Daemon-capable workflow registration lives in `src/core/workflow-loaders.ts`. Do not convert in-process callers spawned from inside other workflow handlers.

The dashboard's "Edit Data" tab + kernel `prefilledData` channel lets an operator override extracted values and re-run without re-extracting. Only **separations** is opted in today. Do not opt in workflows whose inputs are already fully user-supplied.

## Lessons Learned

- **2026-05-28: Person Lookup is the merged operator-facing workflow (formerly EID Lookup + Active Check).** `src/workflows/person-lookup/` is registered in `WORKFLOW_LOADERS` and dashboard input runs. It also exports the `lookupPersonInUcpath` primitive for internal callers. Do not add separate `eid-lookup` or `active-check` entries back to any registry.
- **2026-05-25: Dashboard run surfaces are the public start paths.** New operator starts must be input runs or upload runs. Do not add `npm run <workflow>` launch scripts or YAML/batch-file starts; keep CLI adapters internal when tests or composed workflows still need them.
- **2026-05-16: `buildCliAdapter` remains the internal daemon adapter pattern.** Use it for "shape inputs → enqueue typed items → pre-emit pending rows"; keep pending-data helpers small when reused by in-process paths.
- **`ensurePageHealthy` is gone.** Use `ctx.session.healthCheck(id)` for an explicit mid-handler probe if needed.
