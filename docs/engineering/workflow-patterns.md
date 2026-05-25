# Workflow Patterns — Full Reference

Extended guides extracted from `src/workflows/CLAUDE.md`. See that file for orientation, archetype vocabulary, and the existing-workflows table.

## Dashboard input-run conversion

As of 2026-05-25, operator workflow starts are dashboard-only. Typed starts use the dashboard input-run surface (`InputRunPanel` → `/api/enqueue`), and file/PDF starts use upload runs (`RunModal` → workflow-specific upload endpoints). Do not add new `npm run <workflow>` launch commands or YAML/batch-file launch paths.

The reusable enqueue mechanics still live in `buildCliAdapter` / `ensureDaemonsAndEnqueue`; the public operator entry is now the dashboard. `src/core/daemon/enqueue-dispatch.ts` centralizes the dashboard HTTP path and pre-emits pending tracker rows with operator-subject fields.

- `buildPendingData(input, itemId)` — required pending-row fields.
- `pendingExtras(input, itemId, runId, parentRunId)` — optional per-row fields such as batch display ordinals.
- `onPreEmitFailed(input, runId, error, itemId)` — optional failure cleanup for rows that were pre-emitted before daemon spawn/enqueue failed.

Adding a dashboard input-run workflow is mechanical:

1. Register the workflow in `src/core/workflow-loaders.ts` so daemon spawn and `/api/enqueue` can resolve it.
2. Add the workflow to `DASHBOARD_INPUT_RUN_WORKFLOWS` in `src/domain/dashboard-run-surfaces.ts`.
3. Add parser/placeholder config in `src/dashboard/lib/input-run-registry.ts`.
4. Add or preserve a `npm run <workflow>:stop` script only if the workflow owns long-lived daemons.

Workflows where daemon mode is **not** appropriate (do NOT convert):
- **Non-CLI workflows** like `sharepoint-download` (dashboard button, fire-and-forget `runWorkflow`) — daemon mode solves "avoid re-Duo on repeated CLI runs," which doesn't apply when the dashboard holds one long-lived session.
- **Workflows invoked programmatically from other workflows** — daemon mode is client/daemon IPC; an in-process caller should keep using `runWorkflow` / `runWorkflowBatch` directly.

Daemon-capable workflows (lazy-imported in `src/core/workflow-loaders.ts` for daemon spawn and dashboard `/api/enqueue` internals): `separations`, `work-study`, `eid-lookup`, `onboarding`, **`crm-doc-download`**, `oath-signature`, `emergency-contact`, `oath-upload`, `active-check`.

**Not** in `WORKFLOW_LOADERS`: **`old-kronos-reports`**. Its old batch-file adapter was removed; it is not a valid dashboard run surface.

**Emergency-contact note** — operator starts go through the dashboard upload run (`RunModal` → `/api/ocr/prepare` with `formType: "emergency-contact"`). Do not expose YAML batch input as a package script, dashboard input-run option, or exported workflow helper.

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
