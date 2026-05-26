# Workflows — Orchestration Layer

Each subdirectory is one composed workflow. As of 2026-04-17, every workflow is kernel-based: it declares its shape via `defineWorkflow` in `workflow.ts` and is run by `runWorkflow` / `runWorkflowBatch` / `runWorkflowPool` in `src/core/`.

This file covers what's specific to the workflows layer. See below for writing new workflows, archetypes, and daemon conversion.

## Writing a new workflow

Declare it with `defineWorkflow`. The kernel handles browser launch, auth (Duo-aware, sequential or interleaved), tracker emissions, SIGINT cleanup, screenshotting on step failure, per-item `withTrackedWorkflow` wrapping in batch/pool modes, and the dashboard registry. Your handler just drives Playwright.

Minimal example:

```ts
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { MyInputSchema, type MyInput } from "./schema.js";

const steps = ["ucpath-auth", "transaction"] as const;

export const myWorkflow = defineWorkflow({
  name: "my-workflow",
  label: "My Workflow",
  archetype: "single",
  systems: [{
    id: "ucpath",
    login: async (page) => {
      const ok = await loginToUCPath(page);
      if (!ok) throw new Error("UCPath authentication failed");
    },
  }],
  steps,
  schema: MyInputSchema,
  tiling: "single",
  authChain: "sequential",
  detailFields: [{ key: "emplId", label: "Empl ID" }, { key: "name", label: "Employee" }],
  getName: (d) => d.name ?? "",
  getId: (d) => d.emplId ?? "",
  operatorSubject: (d) => buildOperatorSubject({ kind: "eid", value: d.emplId, prefix: "My Workflow" }),
  handler: async (ctx, input: MyInput) => {
    ctx.updateData({ emplId: input.emplId });
    ctx.markStep("ucpath-auth");
    const page = await ctx.page("ucpath");
    await ctx.step("transaction", async () => {
      // ... Playwright work ...
      ctx.updateData({ name: "Jane Doe" });
    });
  },
});

export async function runMyWorkflow(input: MyInput) {
  await runWorkflow(myWorkflow, input);
}
```

Add a Commander subcommand in `src/cli.ts`, add npm scripts to `package.json`, fill in the schema + handler — no dashboard registry edits needed.

### Cancellation — `ctx.page(id)` is signal-aware (Contract 5)

`ctx.page(id)` returns a Playwright Page wrapped in a Proxy that auto-injects `ctx.signal` (a per-run `AbortSignal`) into every method that accepts `signal?: AbortSignal` — `click`, `fill`, `goto`, `waitForSelector`, `waitForFunction`, `screenshot`, locator methods, keyboard/mouse sub-objects, etc. `evaluate` / `evaluateHandle` / `$eval` / `$$eval` are intentionally NOT wrapped — their second arg is the page-function's `arg` payload, not an options bag (see `page-proxy.ts`); cancel for those flows through the between-step `isCancelRequested` probe instead. Operator cancel aborts the per-run controller, the in-flight call rejects within ms, the kernel remaps the error to `CancelledError('cancelled')` + stamps `step: "cancelled"` — no handler-side cancel boilerplate needed.

Handlers writing non-Playwright awaits that accept an AbortSignal should pass `ctx.signal` for the same fast-cancel behavior:

```ts
// fetch — uses ctx.signal directly:
const res = await fetch(url, { signal: ctx.signal });

// Custom long await — wire ctx.signal so cancel breaks it too:
await new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, 30_000);
  ctx.signal.addEventListener("abort", () => {
    clearTimeout(t);
    reject(new Error("aborted"));
  }, { once: true });
});
```

The kernel preserves caller-supplied signals: passing your own `{ signal: myController.signal }` to `page.click(...)` does NOT clobber `myController.signal` with `ctx.signal` — but `ctx.signal` still aborts your wait via the stepper's between-step probe at the next `ctx.step` boundary.

### Delegating to a child workflow

Workflows compose like functions via `ctx.delegateTo` and `ctx.delegateToAll` (Contract 3). The kernel owns parentRunId stamping, archetype derivation, the pre-emit pending row, and pristine input persistence. Direct calls to `runWorkflow(child, ..., { parentRunId })` or `ensureDaemonsAndEnqueue(child, ..., { parentRunId })` inside a handler are blocked by the architecture guard.

```ts
// Single sequential child — parent awaits its terminal status.
const ocrResult = await ctx.delegateTo(ocrWorkflow, ocrInput, {
  renderAs: "preview",  // approval-delegation surface card with preview tab
  itemId: ocrSessionId, // pin a stable child id for restart recovery
});
if (ocrResult.status !== "done") throw new Error("OCR failed");

// N children fanned out — daemon-capable children dispatch via ensureDaemonsAndEnqueue;
// non-daemon children run in-process with optional concurrency.
const results = await ctx.delegateToAll(
  oathSignatureWorkflow,
  perSignerInputs,
  { renderAs: "batch" },  // batch-delegation group rows under parent card
);
```

`renderAs` overrides the child's row archetype (and therefore its dashboard surface):
- `"flat"` → stamps `passive-child`; renders as `delegation-member` flat row (OCR's utility children).
- `"preview"` → stamps `delegate-child`; renders as `approval-delegation` preview card (OCR under an oath-signature PDF run).
- `"batch"` → stamps `delegate-child`; renders as `batch-delegation` group member (signature fan-out under a parent).

Omit `renderAs` to use the child workflow's declared archetype.

Reference workflows:
- `src/workflows/work-study/` — clean one-system example
- `src/workflows/emergency-contact/` — batch-mode with `preEmitPending`
- `src/workflows/onboarding/` — multi-system sequential auth + pool-mode parallel
- `src/workflows/old-kronos-reports/` — pool-mode with per-worker sessionDir injection
- `src/workflows/eid-lookup/` — `shared-context-pool` mode (N per-item tabs, single Duo per system)

All production workflows are kernel-based as of 2026-04-17. New workflows must follow the kernel path exclusively.

## Directory layout

```
src/workflows/{name}/
  schema.ts      # Zod input validation + any data-transform helpers
  workflow.ts    # defineWorkflow(...) + optional internal adapter
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

### Required: archetype and runtimePolicy

Every `defineWorkflow({...})` must declare `archetype`. The
architecture guard at `tests/unit/architecture/archetype-coverage.test.ts`
fails CI if a workflow omits it.

Every kernel workflow must also declare `runtimePolicy` (spread
`DEFAULT_WORKFLOW_RUNTIME_POLICY` from `src/domain/workflow-runtime/default-policy.ts`
unless the workflow needs delegation/preview/memberRow/prepRow overrides).
Guard: `tests/unit/architecture/runtime-policy-coverage.test.ts`.

Valid `WorkflowArchetype` values:

- `single` — one item, one row (e.g. work-study, active-check).
- `batch` — N peer items under a batch-parent (e.g. emergency-contact).
- `delegating` — emits a `dispatch` row and N `delegate-child` runs in other workflows.
- `delegating-batch` — batch-parent that delegates each member to another workflow (legacy/currently OCR).
- `utility` — child-only workflow that holds no operator attention (e.g. eid-lookup as a passive child).

### Row vocabulary

Every tracker row carries `data.archetype`. The vocabulary is canonical — use these nouns in code, comments, log strings, and CLAUDE.md files.

| WorkflowArchetype (declared) | RowArchetype (emitted) |
|------------------------------|------------------------|
| `single` | `single` |
| `batch` | `batch-parent` + `batch-member` (×N) |
| `delegating` | `single` + `dispatch` + `delegate-child` (×N) |
| `delegating-batch` | `batch-parent` + `delegate-child` / `passive-child` |
| `utility` | `passive-child` only |

- **single** — one item, one row, flat in the queue.
- **batch-parent** — anchor row over N peers. Stamped via `data.archetype` at every emit site (Contract 1 — no legacy heuristics). `resolveRowArchetype` throws on rows with an invalid stamped value; missing archetype falls back to the canonical mapping (`delegate-child` with parent, else `single`).
- **batch-member** — peer item under a batch-parent.
- **dispatch** — terminal-at-enqueue row recording "I delegated to N children in another workflow."
- **delegate-child** — child run spawned from a parent in a different workflow; holds operator attention.
- **passive-child** — collapsed delegate-child rendered as a sub-row inside its parent's card; never holds operator attention.

The kernel auto-stamps the appropriate `RowArchetype` based on the workflow's `WorkflowArchetype` declaration and the row's `parentRunId`. See `src/domain/row-archetype.ts` (`resolveRowArchetype` and `deriveRowArchetype`).

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

## Dashboard Start Integration

Do not add Commander subcommands or `npm run <workflow>` launch scripts. Public operator starts belong in the dashboard:

- **Input runs:** add the workflow to `DASHBOARD_INPUT_RUN_WORKFLOWS`, add parser config in `src/dashboard/lib/input-run-registry.ts`, and ensure `src/core/workflow-loaders.ts` can resolve it for `/api/enqueue`.
- **Upload runs:** add the workflow to `DASHBOARD_UPLOAD_RUN_WORKFLOWS` and configure `src/dashboard/lib/run-modal-registry.ts`.
- **Daemon lifecycle:** add a `:stop` script only when the workflow owns long-lived daemons.

## Daemon-mode conversion

Use the dashboard enqueue path for new daemon-capable workflow starts. Daemon-capable workflows (in `src/core/workflow-loaders.ts`): `separations`, `work-study`, `eid-lookup`, `onboarding`, `crm-doc-download`, `oath-signature`, `emergency-contact`, `oath-upload`, `active-check`. **Not** daemon-capable: `old-kronos-reports`, `sharepoint-download`, `ocr`. Do NOT convert in-process callers (workflows spawned from inside other workflow handlers).

→ Full guide: `docs/engineering/workflow-patterns.md#daemon-mode-conversion`

## Edit-data opt-in

The dashboard's "Edit Data" tab + kernel `prefilledData` channel let an operator override extracted values and re-run a workflow without re-extracting. Only **separations** is opted in today. Do NOT opt in workflows whose inputs are already fully user-supplied (work-study, oath-signature, etc.) — the Edit Data tab adds no value over Retry for those.

→ Full recipe: `docs/engineering/workflow-patterns.md#edit-data-opt-in`

## Existing Workflows

Representative workflows. Operator starts are dashboard-only: input runs use `InputRunPanel` / `/api/enqueue`, upload runs use `RunModal` / upload endpoints. CLI commands are lifecycle/support only.

| Workflow | Dashboard start surface | Systems | Kernel? | Parallelism |
|---|---|---|---|---|
| onboarding | Not currently exposed in input-run registry | CRM, UCPath, I9 | Yes | Single-worker daemon per spawn on the shared SQLite queue |
| crm-doc-download | Input run (EIDs) | CRM | Yes | Pool batch config; daemon mode reuses CRM like other loaders |
| separations | Input run (doc IDs) | Kuali, Old Kronos, New Kronos, UCPath | Yes (per-doc handler; daemon default) | 4 tiled browsers, **`authChain: "parallel-staggered"`** (Duos overlap — see `separations/workflow.ts`); `ctx.parallel` Phase-1 4-way fan-out |
| eid-lookup | Input run (names) | UCPath + CRM | Yes | **`batch.mode: "shared-context-pool"`** — one Duo per system per batch, N worker tabs |
| active-check | Input run (names or EIDs) | UCPath | Yes | Same shared-context pool pattern as eid-lookup |
| old-kronos-reports | Not exposed; retired batch-file adapter is not a valid dashboard run surface | UKG | Yes | Pool mode (N workers); **not** in `WORKFLOW_LOADERS` |
| work-study | Not currently exposed in input-run registry | UCPath | Yes | Single |
| emergency-contact | Upload run through OCR prep | UCPath | Yes (batch, `preEmitPending`) | Single browser, one record at a time; daemon via OCR approval |
| oath-signature | Input run (EIDs) or upload run through OCR prep | UCPath | Yes (daemon default; sequential batch + `preEmitPending`) | Single browser |
| oath-upload | Upload run | ServiceNow + delegated oath-signature PDF run | Yes | Delegates signatures first, then files ServiceNow; daemon default |
| sharepoint-download | _Dashboard button_ (fire-and-forget) — canonical entry is `src/workflows/sharepoint-download/`; legacy wrapper `src/workflows/emergency-contact/scripts/download-roster.ts` still exists for direct CLI invocation | SharePoint | Yes (single-item, module-level URL injection) | Single (headed browser, gated by Duo) |
| ocr | _Dashboard Run button_ (HTTP only — no CLI, no daemon) | _none_ | Yes (`systems: []`, `authSteps: false`) | In-process (single fire-and-forget via `/api/ocr/prepare`) |

### `ocr` — notable shape

The only workflow with `systems: []` and `authSteps: false`. No browsers, no Duo. Runs in the dashboard's Node process via fire-and-forget `runWorkflow` called from `/api/ocr/prepare`. The thin kernel handler delegates entirely to `runOcrOrchestrator` which owns its own tracker emissions (the kernel's per-step machinery doesn't model "wait for user approval mid-handler"). NOT in `WORKFLOW_LOADERS` — spawning an OCR daemon is a bug. See `src/workflows/ocr/CLAUDE.md` for form-type spec contract, carry-forward, and force-research.

### `sharepoint-download` — notable shape

Kernel workflow (since 2026-04-22), but with two non-standard wrinkles documented in its `CLAUDE.md`: (1) `systems[].login` reads the per-run file URL from a module-level mutable (`pendingLandingUrl`) because the kernel's `SystemConfig.login` signature doesn't pass `input`, and (2) the dashboard HTTP handler fires `runWorkflow` fire-and-forget and returns 202, so the socket isn't held open for the 2-3 min download window. Both are safe under the handler's cross-id in-flight lock. See `src/workflows/sharepoint-download/CLAUDE.md` before copying either pattern.

## Lessons Learned

- **2026-04-10: Batch mode pattern for sequential processing** — For workflows that reuse browser sessions across multiple items (e.g. separations, emergency-contact), the pattern is: (1) pre-emit `pending` for all items with pre-assigned `runId`s (kernel: `preEmitPending: true` + `onPreEmitPending` callback), (2) auth once, (3) process each item sequentially. The kernel's `runWorkflowBatch` does this declaratively; legacy workflows wire `preAssignedRunId` into `withTrackedWorkflow` manually.
- **2026-05-25: Dashboard run surfaces are the public start paths.** New operator starts must be either input runs or upload runs. Do not add `npm run <workflow>` launch scripts or YAML/batch-file starts; keep CLI adapters internal when tests or composed workflows still need them.
- **2026-05-16: `buildCliAdapter` remains the internal daemon adapter pattern.** Existing adapters use `buildCliAdapter` instead of hand-rolled `ensureDaemonsAndEnqueue` calls when their job is "shape inputs → enqueue typed items → pre-emit pending rows." Keep workflow-specific pending data in small `buildPendingData` helpers when it is reused by in-process batch paths (emergency-contact is the current example). Separations previously rebuilt its adapter per call to dodge a TDZ cycle; the safe hoist required exporting CLI runners from `src/workflows/separations/index.ts` directly instead of re-exporting them from `workflow.ts`.
- **`ensurePageHealthy` is gone.** Pre-kernel workflows used it before each phase; removed 2026-04-18 when all workflows moved to the kernel. Use `ctx.session.healthCheck(id)` for an explicit mid-handler probe if needed.
