# Workflow Patterns — Full Reference

Extended guides extracted from `src/workflows/CLAUDE.md`. See that file for orientation, archetype vocabulary, and the existing-workflows table.

## Daemon-mode conversion

As of 2026-04-22, CLI-driven workflows should default to **daemon mode** (see `src/core/CLAUDE.md`). This avoids re-Duo per invocation and enables shared-queue load balancing across multiple alive daemons.

As of 2026-05-16, use `buildCliAdapter` from `src/core/cli-adapter.ts` for CLI-driven daemon adapters. It centralizes the `ensureDaemonsAndEnqueue` call, pre-emits pending tracker rows with operator-subject fields, and exposes narrow hooks for workflow-specific shapes:

- `buildPendingData(input, itemId)` — required pending-row fields.
- `pendingExtras(input, itemId, runId, parentRunId)` — optional per-row fields such as batch display ordinals.
- `onPreEmitFailed(input, runId, error, itemId)` — optional failure cleanup for rows that were pre-emitted before daemon spawn/enqueue failed.

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

## Edit-data opt-in

The dashboard's "Edit Data" tab + kernel `prefilledData` channel let an operator override extracted values and re-run a workflow against the same id without re-extracting. Opting a workflow in is four steps; only **separations** is opted in today (canonical reference: `src/workflows/separations/workflow.ts`).

1. **Mark editable fields in `detailFields`** with the object form + `editable: true`. Optional flags: `displayInGrid: false` hides the field from LogPanel's detail grid (still shown in Edit Data tab); `multiline: true` switches the input to a textarea.
   ```ts
   detailFields: [
     { key: "name", label: "Employee", editable: true },
     { key: "amount", label: "Amount" }, // not editable
   ],
   ```

2. **Capture prefilled state at the top of the handler.** Read the flags BEFORE the first step runs — once `kuali-extraction` (or any other step that calls `ctx.updateData`) fires, you can't distinguish "user prefilled this" from "extraction wrote it":
   ```ts
   handler: async (ctx, input) => {
     const namePrefilled =
       typeof ctx.data.name === "string" && (ctx.data.name as string).length > 0;
     // ... capture every flag the gates below need ...
   }
   ```

3. **Gate each extraction step on the prefilled flags.** Use `ctx.skipStep` (NOT `ctx.markStep`) so the dashboard pipeline shows the distinct "skipped" treatment and the tracker JSONL records `status: "skipped"`:
   ```ts
   if (allRequiredPrefilled) {
     ctx.skipStep("extraction-step-name");
     log.step(`[Step: extraction-step-name] SKIPPED — using manual input from edit-data ...`);
     // synthesize the data object the rest of the handler expects
   } else {
     await ctx.step("extraction-step-name", async () => { /* extract */ });
   }
   ```
   When the bypass set is narrower than the editable set (e.g. an internal field like `rawTerminationType` is consumed only by a step that is itself being skipped), narrow `requiredFields` accordingly so a missing internal field doesn't force re-extraction.

4. **Always log the skip reason and the field values used.** Operators reading the dashboard need to confirm the workflow saw the values they typed, not stale data. Use the canonical phrase `SKIPPED — using manual input from edit-data` so cross-workflow logs read consistently.

The kernel automatically: strips the `prefilledData` channel from the input before Zod validation (see `splitPrefilled` in `src/core/workflow.ts`), merges it into `ctx.data` via `updateData(...)` BEFORE the handler runs, and persists the original input (with channel) on the pending tracker row so retry recovers the channel verbatim. Lineage across reduced-data rows (cancel-queued, save-data) is preserved by the merge-across-rows fold in `findLatestEntryData` (`src/tracker/dashboard-ops.ts`).

**When NOT to opt in:** workflows whose only inputs are already user-supplied (e.g. work-study takes `emplId + effectiveDate` directly, oath-signature takes `emplId`) — there's nothing to extract, so the Edit Data tab adds no value over the existing Retry button. Leave their `detailFields` non-editable.
