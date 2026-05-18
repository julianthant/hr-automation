# Workflows — Orchestration Layer

Each subdirectory is one composed workflow. As of 2026-04-17, every workflow is kernel-based: it declares its shape via `defineWorkflow` in `workflow.ts` and is run by `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` in `src/core/`.

See the root `CLAUDE.md` "Writing a new workflow" section for the minimal `defineWorkflow` example. This file lists what's specific to this directory.

## Directory layout

```
src/workflows/{name}/
  schema.ts      # Zod input validation + any data-transform helpers
  workflow.ts    # defineWorkflow(...) + CLI adapter (runMyWorkflow)
  enter.ts       # ActionPlan builder (UCPath workflows) — optional
  config.ts      # Workflow-specific constants
  index.ts       # Barrel exports
  CLAUDE.md      # This module's doc (template: what / data flow / kernel config / gotchas / lessons)
```

Do **not** create `tracker.ts` for new workflows. The kernel's JSONL emissions + dashboard are the only observability. **Grandfathered `tracker.ts`:** only `old-kronos-reports/tracker.ts` (Excel Kronos report log) remains — do not add new ones. Separations never had one.

## Dashboard Integration (kernel — automatic)

Declare `label`, `getName`, `getId`, and labeled `detailFields` inside `defineWorkflow({ ... })`. Every key you list in `detailFields` should be populated by at least one `ctx.updateData({ [key]: ... })` call before the handler returns — a runtime `log.warn` fires if not. That's the entire dashboard wiring for kernel workflows.

All workflows are kernel-based as of 2026-04-17. New workflows must follow the kernel path exclusively.

Frontend requires no edits — the dashboard reads everything from the server-side registry via `/api/workflow-definitions`.

### Required: archetype

Every `defineWorkflow({...})` must declare `archetype`. The
architecture guard at `tests/unit/architecture/archetype-coverage.test.ts`
fails CI if a workflow omits it. Valid `WorkflowArchetype` values:

- `single` — one item, one row (e.g. work-study, active-check).
- `batch` — N peer items under a batch-parent (e.g. emergency-contact, oath-signature).
- `delegating` — emits a `dispatch` row and N `delegate-child` runs in other workflows.
- `delegating-batch` — batch-parent that delegates each member to another workflow (e.g. oath-upload).
- `utility` — child-only workflow that holds no operator attention (e.g. eid-lookup as a passive child).

See the canonical glossary in root `CLAUDE.md` → "Row & Workflow Archetypes".

## Naming and ownership conventions

Workflow-local functions should describe orchestration steps. Reusable behavior must move to `src/domain/`, `src/systems/`, `src/core/`, or `src/services/ocr/forms/`. Use the naming verbs in `docs/engineering/codebase-conventions.md`; avoid vague helpers like `processData` or `handleThing`.

### Shared fixes before workflow-local helpers

Before adding a helper in a workflow folder, check whether the same behavior already exists in:
- `src/domain/identity/`
- `src/domain/operator-subject.ts`
- `src/domain/log-events.ts`
- `src/domain/notifications/`
- `src/core/task-display.ts`
- `src/core/task-control.ts`
- `src/services/ocr/forms/`
- `src/systems/ucpath/person-org-summary.ts`
- `src/domain/hdh/departments.ts`

If the helper would be useful to another workflow, add or extend the shared module instead. Keep compatibility exports only as migration shims.

## CLI Integration

Add a Commander subcommand to `src/cli.ts` invoking your workflow's CLI adapter. Add the normal and `:stop` scripts to `package.json`.

## Daemon-mode conversion template

As of 2026-04-22, CLI-driven workflows should default to **daemon mode** (see root `CLAUDE.md` → "Daemon mode"). This avoids re-Duo per invocation and enables shared-queue load balancing across multiple alive daemons.

As of 2026-05-16, use `buildCliAdapter` from `src/core/cli-adapter.ts` for CLI-driven daemon
adapters. It centralizes the `ensureDaemonsAndEnqueue` call, pre-emits pending
tracker rows with operator-subject fields, and exposes narrow hooks for
workflow-specific shapes:

- `buildPendingData(input, itemId)` — required pending-row fields.
- `pendingExtras(input, itemId, runId, parentRunId)` — optional per-row fields
  such as batch display ordinals.
- `onPreEmitFailed(input, runId, error, itemId)` — optional failure cleanup for
  rows that were pre-emitted before daemon spawn/enqueue failed.

Converting a workflow is mechanical — five edits:

1. **Add a `runXxxCli` adapter** to `workflow.ts` using `buildCliAdapter`:
   ```ts
   export const runXxxCli = buildCliAdapter<[string[]], XxxInput>({
     workflow: xxxWorkflow,
     emptyMessage: "runXxxCli: no inputs provided",
     buildInputs: (ids) => ids.map((id) => ({ id })),
     deriveItemId: (input) => input.id,
     buildPendingData: (input) => ({ id: input.id }),
   });
   ```
   Do **not** remove the existing `runXxx` / `runXxxBatch` functions — they stay for in-process use (tests, composed workflows that spawn workflows from inside their handler).
2. **Re-export `runXxxCli` from the workflow's `index.ts`** barrel so the CLI and `cli-daemon.ts` can import it.
3. **Register the workflow in `src/cli-daemon.ts`**'s `WORKFLOWS` map (lazy-import loader). The daemon process exec's `tsx src/cli-daemon.ts <workflow>` — this map is how it finds the `defineWorkflow` result.
4. **Update the workflow's Commander subcommand in `src/cli.ts`** to call `runXxxCli` by default and expose `-n, --new` and `-p, --parallel <count>` options.
5. **Add `npm run <workflow>:stop` script** in `package.json` (thin wrapper over `daemon-stop` from `src/cli.ts`).

Workflows where daemon mode is **not** appropriate (do NOT convert):
- **Non-CLI workflows** like `sharepoint-download` (dashboard button, fire-and-forget `runWorkflow`) — daemon mode solves "avoid re-Duo on repeated CLI runs," which doesn't apply when the dashboard holds one long-lived session.
- **Workflows invoked programmatically from other workflows** — daemon mode is client/daemon IPC; an in-process caller should keep using `runWorkflow` / `runWorkflowBatch` directly.

Daemon-capable workflows (lazy-imported in `src/core/workflow-loaders.ts` for daemon spawn and dashboard `/api/enqueue`): `separations`, `work-study`, `eid-lookup`, `onboarding`, **`crm-doc-download`**, `oath-signature`, `emergency-contact`, `oath-upload`, `active-check`.

**Not** in `WORKFLOW_LOADERS`: **`old-kronos-reports`** (the `npm run kronos` / `runParallelKronos` path is pool-only in-process + not wired to daemon spawn). No behavior change intended for converted workflows — daemon mode wraps the same `runOneItem` kernel primitive, so per-item tracker output matches the in-process path.

**Emergency-contact note** — default `npm run emergency-contact` uses `runEmergencyContactCli` (`buildCliAdapter` in `workflow.ts`): load YAML + roster preflight in-process, then enqueue each record with `deriveItemId: recordItemId` (`p{NN}-{emplId}`) because the EID lives under `input.employee.employeeId`, not a top-level field. In-process batch without daemon remains `runEmergencyContact` → `runWorkflowBatch`.

**Onboarding note** — one alive daemon = one single-worker session with 3 browsers (CRM + UCPath + I9) and 2 Duos (I9 is SSO no-2FA). Heaviest per-daemon cost of any converted workflow, but biggest savings per repeat invocation (CRM Duo alone is ~30-60s). Daemon-mode parallelism comes from running N daemons (`-p N`), each a single worker claiming off the shared SQLite tasks queue.

## Edit-data opt-in recipe

The dashboard's "Edit Data" tab + kernel `prefilledData` channel let an
operator override extracted values and re-run a workflow against the same
id without re-extracting. Opting a workflow in is four steps; only
**separations** is opted in today (canonical reference: `src/workflows/separations/workflow.ts`).

1. **Mark editable fields in `detailFields`** with the object form +
   `editable: true`. Optional flags: `displayInGrid: false` hides the
   field from LogPanel's detail grid (still shown in Edit Data tab);
   `multiline: true` switches the input to a textarea.
   ```ts
   detailFields: [
     { key: "name", label: "Employee", editable: true },
     { key: "amount", label: "Amount" }, // not editable
   ],
   ```

2. **Capture prefilled state at the top of the handler.** Read the flags
   BEFORE the first step runs — once `kuali-extraction` (or any other
   step that calls `ctx.updateData`) fires, you can't distinguish "user
   prefilled this" from "extraction wrote it":
   ```ts
   handler: async (ctx, input) => {
     const namePrefilled =
       typeof ctx.data.name === "string" && (ctx.data.name as string).length > 0;
     // ... capture every flag the gates below need ...
   }
   ```

3. **Gate each extraction step on the prefilled flags.** Use
   `ctx.skipStep` (NOT `ctx.markStep`) so the dashboard pipeline shows
   the distinct "skipped" treatment and the tracker JSONL records
   `status: "skipped"`:
   ```ts
   if (allRequiredPrefilled) {
     ctx.skipStep("extraction-step-name");
     log.step(`[Step: extraction-step-name] SKIPPED — using manual input from edit-data ...`);
     // synthesize the data object the rest of the handler expects
   } else {
     await ctx.step("extraction-step-name", async () => { /* extract */ });
   }
   ```
   When the bypass set is narrower than the editable set (e.g. an
   internal field like `rawTerminationType` is consumed only by a
   step that is itself being skipped), narrow `requiredFields`
   accordingly so a missing internal field doesn't force re-extraction.

4. **Always log the skip reason and the field values used.** Operators
   reading the dashboard need to confirm the workflow saw the values
   they typed, not stale data. Use the canonical phrase
   `SKIPPED — using manual input from edit-data` so cross-workflow
   logs read consistently.

The kernel automatically: strips the `prefilledData` channel from the
input before Zod validation (see `splitPrefilled` in `src/core/workflow.ts`),
merges it into `ctx.data` via `updateData(...)` BEFORE the handler runs,
and persists the original input (with channel) on the pending tracker
row so retry recovers the channel verbatim. Lineage across reduced-data
rows (cancel-queued, save-data) is preserved by the merge-across-rows
fold in `findLatestEntryData` (`src/tracker/dashboard-ops.ts`).

**When NOT to opt in:** workflows whose only inputs are already user-
supplied (e.g. work-study takes `emplId + effectiveDate` directly,
oath-signature takes `emplId`) — there's nothing to extract, so the
Edit Data tab adds no value over the existing Retry button. Leave
their `detailFields` non-editable.

## Existing Workflows

Representative CLI workflows (flags and full command list: `src/cli.ts`).

| Workflow | CLI | Systems | Kernel? | Parallelism |
|---|---|---|---|---|
| onboarding | `npm run onboarding` (positional emails; `-n` / `-p` only) | CRM, UCPath, I9 | Yes | Single-worker daemon per spawn; scale with N daemons (`-p N`) on the shared SQLite queue |
| crm-doc-download | `npm run crm-doc-download` (emails; `-n` / `-p`) | CRM | Yes | Pool batch config; daemon mode reuses CRM like other loaders |
| separations | `npm run separation` (`-n` / `-p`) | Kuali, Old Kronos, New Kronos, UCPath | Yes (per-doc handler; daemon default) | 4 tiled browsers, **`authChain: "parallel-staggered"`** (Duos overlap — see `separations/workflow.ts`); `ctx.parallel` Phase-1 4-way fan-out |
| eid-lookup | `npm run eid-lookup` (`-n` / `-p`) | UCPath + CRM | Yes | **`batch.mode: "shared-context-pool"`** — one Duo per system per batch, N worker tabs |
| active-check | `npm run active-check` (`-n` / `-p`) | UCPath | Yes | Same shared-context pool pattern as eid-lookup |
| old-kronos-reports | `npm run kronos` (**`--workers N`** overrides pool size) | UKG | Yes | Pool mode (N workers); **not** in `WORKFLOW_LOADERS` |
| work-study | `npm run work-study` (`-n` / `-p`) | UCPath | Yes | Single |
| emergency-contact | `npm run emergency-contact` | UCPath | Yes (batch, `preEmitPending`) | Single browser, one record at a time; daemon via `runEmergencyContactCli` |
| oath-signature | `npm run oath-signature <emplId...>` | UCPath | Yes (daemon default; sequential batch + `preEmitPending`) | Single browser; N daemons via `-p N` |
| oath-upload | `npm run oath-upload` | ServiceNow + delegated OCR / oath-signature | Yes | Sequential steps + child-run waits; daemon default |
| sharepoint-download | _Dashboard button_ (fire-and-forget) / `tsx src/workflows/emergency-contact/scripts/download-roster.ts` (non-kernel CLI) | SharePoint | Yes (single-item, module-level URL injection) | Single (headed browser, gated by Duo) |
| ocr | _Dashboard Run button_ (HTTP only — no CLI, no daemon) | _none_ | Yes (`systems: []`, `authSteps: false`) | In-process (single fire-and-forget via `/api/ocr/prepare`) |

### `ocr` — notable shape

The only workflow with `systems: []` and `authSteps: false`. No browsers, no Duo. Runs in the dashboard's Node process via fire-and-forget `runWorkflow` called from `/api/ocr/prepare`. The thin kernel handler delegates entirely to `runOcrOrchestrator` which owns its own tracker emissions (the kernel's per-step machinery doesn't model "wait for user approval mid-handler"). NOT in `WORKFLOW_LOADERS` — spawning an OCR daemon is a bug. See `src/workflows/ocr/CLAUDE.md` for form-type spec contract, carry-forward, and force-research.

### `sharepoint-download` — notable shape

Kernel workflow (since 2026-04-22), but with two non-standard wrinkles documented in its `CLAUDE.md`: (1) `systems[].login` reads the per-run file URL from a module-level mutable (`pendingLandingUrl`) because the kernel's `SystemConfig.login` signature doesn't pass `input`, and (2) the dashboard HTTP handler fires `runWorkflow` fire-and-forget and returns 202, so the socket isn't held open for the 2-3 min download window. Both are safe under the handler's cross-id in-flight lock. See `src/workflows/sharepoint-download/CLAUDE.md` before copying either pattern.

## Lessons Learned

- **2026-04-10: Batch mode pattern for sequential processing** — For workflows that reuse browser sessions across multiple items (e.g. separations, emergency-contact), the pattern is: (1) pre-emit `pending` for all items with pre-assigned `runId`s (kernel: `preEmitPending: true` + `onPreEmitPending` callback), (2) auth once, (3) process each item sequentially. The kernel's `runWorkflowBatch` does this declaratively; legacy workflows wire `preAssignedRunId` into `withTrackedWorkflow` manually.
- **2026-05-16: `buildCliAdapter` is the canonical daemon CLI pattern.** Workflow CLI adapters now use `buildCliAdapter` instead of hand-rolled `ensureDaemonsAndEnqueue` calls when their job is "shape CLI args → enqueue typed inputs → pre-emit pending rows." Keep workflow-specific pending data in small `buildPendingData` helpers when it is reused by in-process batch paths (emergency-contact is the current example). Separations previously rebuilt its adapter per call to dodge a TDZ cycle; the safe hoist required exporting CLI runners from `src/workflows/separations/index.ts` directly instead of re-exporting them from `workflow.ts`.
- **2026-04-10: ensurePageHealthy() before each phase (historical, legacy workflows)** — SAML errors and session expiry can happen silently between phases. Pre-kernel workflows wrapped each major phase with `ensurePageHealthy()` from `src/core/page-health.ts`. Removed 2026-04-18 — every workflow is now kernel-based, and the kernel's `Session.launch` retries failed auth up to 3 attempts. Don't reach for `ensurePageHealthy` — use `ctx.session.healthCheck(id)` if you need an explicit mid-handler probe.
