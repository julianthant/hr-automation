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

## Daemon-mode conversion template

As of 2026-04-22, CLI-driven workflows should default to **daemon mode** (see root `CLAUDE.md` → "Daemon mode"). This avoids re-Duo per invocation and enables shared-queue load balancing across multiple alive daemons.

Converting a workflow is mechanical — five edits:

1. **Add a `runXxxCli` adapter** to `workflow.ts` that wraps `ensureDaemonsAndEnqueue`:
   ```ts
   export async function runXxxCli(
     // ...workflow-specific args...
     options: { dryRun?: boolean; new?: boolean; parallel?: number } = {},
   ): Promise<void> {
     if (options.dryRun) {
       // preview path — no daemon, no Duo
       return;
     }
     const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
     const inputs = [/* ...build typed WorkflowInput[]... */];
     await ensureDaemonsAndEnqueue(xxxWorkflow, inputs, {
       new: options.new,
       parallel: options.parallel,
     });
   }
   ```
   Do **not** remove the existing `runXxx` / `runXxxBatch` functions — they stay for in-process use (`--direct` flag, tests, composed workflows that spawn workflows from inside their handler).
2. **Re-export `runXxxCli` from the workflow's `index.ts`** barrel so the CLI and `cli-daemon.ts` can import it.
3. **Register the workflow in `src/cli-daemon.ts`**'s `WORKFLOWS` map (lazy-import loader). The daemon process exec's `tsx src/cli-daemon.ts <workflow>` — this map is how it finds the `defineWorkflow` result.
4. **Update the workflow's Commander subcommand in `src/cli.ts`** to call `runXxxCli` by default, expose `-n, --new` and `-p, --parallel <count>` options, and keep a `--direct` flag that invokes the legacy in-process `runXxx` / `runXxxBatch` path for tests / scripts / composed pipelines.
5. **Add `npm run <workflow>:status` / `:stop` / `:attach` scripts** in `package.json` (they're thin wrappers over `daemon-status`, `daemon-stop`, `daemon-attach` from `src/cli.ts`).

Workflows where daemon mode is **not** appropriate (do NOT convert):
- **Non-CLI workflows** like `sharepoint-download` (dashboard button, fire-and-forget `runWorkflow`) — daemon mode solves "avoid re-Duo on repeated CLI runs," which doesn't apply when the dashboard holds one long-lived session.
- **Workflows invoked programmatically from other workflows** — daemon mode is client/daemon IPC; an in-process caller should keep using `runWorkflow` / `runWorkflowBatch` directly.

Currently converted: `separations`, `work-study`, `eid-lookup`, `onboarding`. Pending: `old-kronos-reports`, `emergency-contact`. No behavior change intended — daemon mode wraps the same `runOneItem` kernel primitive, so per-item tracker output is byte-identical to the legacy path.

**Onboarding note** — one alive daemon = one single-worker session with 3 browsers (CRM + UCPath + I9) and 2 Duos (I9 is SSO no-2FA). Heaviest per-daemon cost of any converted workflow, but biggest savings per repeat invocation (CRM Duo alone is ~30-60s). The workflow's `batch.mode: "pool"` is orthogonal: it governs `runWorkflowBatch` fan-out in the legacy `--direct` path. Daemon-mode parallelism comes from running N daemons (`-p N`), each a single worker claiming off the shared queue. `--dry-run` and `--batch` both auto-force `--direct` (dry-run skips the full session launch; batch.yaml is read in-process).

## Existing Workflows

| Workflow | CLI | Systems | Kernel? | Parallelism |
|---|---|---|---|---|
| onboarding | `npm run onboarding` (positional emails; `--batch` reads batch.yaml; `:dry` for preview) | CRM, UCPath, I9 | Yes | Single mode for one email; pool mode (N workers, kernel) via `runWorkflowBatch` for multi |
| separations | `npm run separation` | Kuali, Old Kronos, New Kronos, UCPath | Yes (sequential batch via runWorkflowBatch) | 4 tiled browsers, interleaved auth, ctx.parallel for Phase-1 4-way fan-out |
| eid-lookup | `tsx src/cli.ts eid-lookup` | UCPath + optional CRM | Yes | N tabs in one shared context (runWorkerPool in handler) |
| old-kronos-reports | `npm run kronos` | UKG | Yes | Pool mode (N workers, kernel) |
| work-study | `npm run work-study` | UCPath | Yes | Single |
| emergency-contact | `npm run emergency-contact` | UCPath | Yes (batch, `preEmitPending`) | Single browser, one record at a time |
| sharepoint-download | _Dashboard button_ (fire-and-forget) / `tsx src/workflows/emergency-contact/scripts/download-roster.ts` (non-kernel CLI) | SharePoint | Yes (single-item, module-level URL injection) | Single (headed browser, gated by Duo) |

### `sharepoint-download` — notable shape

Kernel workflow (since 2026-04-22), but with two non-standard wrinkles documented in its `CLAUDE.md`: (1) `systems[].login` reads the per-run file URL from a module-level mutable (`pendingLandingUrl`) because the kernel's `SystemConfig.login` signature doesn't pass `input`, and (2) the dashboard HTTP handler fires `runWorkflow` fire-and-forget and returns 202, so the socket isn't held open for the 2-3 min download window. Both are safe under the handler's cross-id in-flight lock. See `src/workflows/sharepoint-download/CLAUDE.md` before copying either pattern.

## Lessons Learned

- **2026-04-10: Batch mode pattern for sequential processing** — For workflows that reuse browser sessions across multiple items (e.g. separations, emergency-contact), the pattern is: (1) pre-emit `pending` for all items with pre-assigned `runId`s (kernel: `preEmitPending: true` + `onPreEmitPending` callback), (2) auth once, (3) process each item sequentially. The kernel's `runWorkflowBatch` does this declaratively; legacy workflows wire `preAssignedRunId` into `withTrackedWorkflow` manually.
- **2026-04-22: Daemon-mode conversion template.** The `runXxxCli` adapter pattern (see above) is intentionally a thin function, not a kernel abstraction — input shaping (`docId` vs `{emplId, effectiveDate}` vs ...) is workflow-specific and a base class would just re-expose every parameter as `unknown`. The common logic IS abstracted: `ensureDaemonsAndEnqueue` handles daemon discovery, spawning, validation, enqueue, and wake in one call. Adapters are ~10 lines of boilerplate that ship typed arguments into the shared core. If that boilerplate ever grows a third concern (e.g. a cross-workflow priority field), promote the adapter into a helper — until then, keep it explicit in each workflow so the call site reads naturally.
- **2026-04-10: ensurePageHealthy() before each phase (historical, legacy workflows)** — SAML errors and session expiry can happen silently between phases. Pre-kernel workflows wrapped each major phase with `ensurePageHealthy()` from `src/core/page-health.ts`. Removed 2026-04-18 — every workflow is now kernel-based, and the kernel's `Session.launch` retries failed auth up to 3 attempts. Don't reach for `ensurePageHealthy` — use `ctx.session.healthCheck(id)` if you need an explicit mid-handler probe.
