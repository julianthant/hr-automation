---
name: custom-hr-workflow-scaffold
description: Scaffold a new kernel-based workflow in hr-automation. Use whenever the user wants to add, create, build, or wire up a new workflow (onboarding/separations/lookup/upload/OCR-fanout style), a new OCR form type, or a delegated subworkflow. Produces the workflow directory (schema.ts, workflow.ts, config.ts, index.ts, AGENTS.md), the exact dashboard + daemon wiring, and a typecheck-backed pre-flight checklist grounded in the current kernel API (archetype / inputSubject / code / runtimePolicy / delegation / approve fan-out). Reach for this even if the user just says "make a workflow that does X" without naming the scaffold.
---

# Workflow Scaffold

Create a new kernel-based workflow that matches the **current** hr-automation architecture. The kernel evolved a lot — there is no `tiling`, no `authChain`, no Commander subcommand, and no `npm run <workflow>` start script anymore. Workflows start **only** from the dashboard (typed input run or file-upload run). If you find yourself writing those legacy shapes, stop and re-read this skill.

Read the nearest AGENTS.md before you start: `src/workflows/AGENTS.md` (workflow rules + shared homes), `src/core/AGENTS.md` (kernel contracts), and the AGENTS.md of any `src/systems/<system>` you'll drive.

## Step 1 — Decide the shape (ask only what you can't infer)

A workflow sits on three orthogonal axes plus a start surface. Pin these down first — they drive every later choice. (Full model: `references/row-model.md`.)

1. **inputSubject** — what one run receives: `name | eid | email | kualiId | pdf | selector`. A literal, or a resolver `(input) => subject` for input-variant workflows. This is **mandatory** (an architecture guard, `queue-row-kind-coverage`, fails the build without it). The presentation kind (`person | file | catalog`) is *derived* from it — never declared.
2. **archetype** (shape) — `single` (one subject/row), `preview` (an approval/review card), or `batch` (an anchor over N members). Defaults to `batch` when `batch:` config is set, else `single`.
3. **scope** — root vs delegated. You don't declare this; it's `parentRunId`, stamped by the kernel when another workflow delegates to this one.
4. **start surface** — `input` (operator types IDs/names → `InputRunPanel`) or `upload` (operator uploads a PDF/file → `RunModal`). A workflow that only ever runs as a *delegated child* (e.g. a subworkflow) needs **no** start surface.

Ask the user only for: workflow name (kebab-case), which **systems** it drives (`ucpath`, `crm`, `i9`, `kuali`, `servicenow`, `sharepoint`, `old-kronos`, `new-kronos`), the **steps** (business steps; auth steps are auto-prepended), and the start surface. Infer the rest from the task.

## Step 2 — Create `src/workflows/<name>/`

### `schema.ts`
```ts
import { z } from "zod";

export const <Name>InputSchema = z.object({
  // one run's input — keep it the minimal natural key + payload
});
export type <Name>Input = z.infer<typeof <Name>InputSchema>;
```

### `config.ts`
```ts
// Narrow/re-export from src/config.ts. Never hardcode URLs/paths here.
export const CONFIG = {} as const;
```

### `workflow.ts`
This skeleton reflects the real API (see `oath-signature/workflow.ts` for a live example). Fill the bracketed parts.

```ts
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { <Name>InputSchema, type <Name>Input } from "./schema.js";

const <NAME>_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  // override only what differs — see references/row-model.md
};

const steps = ["<business-step-1>", "<business-step-2>"] as const;

export const <camelName>Workflow = defineWorkflow({
  name: "<name>",
  label: "<Human Label>",
  archetype: "single",          // single | preview | batch
  inputSubject: "eid",          // REQUIRED — name|eid|email|kualiId|pdf|selector (or resolver)
  code: "<xx>",                 // 2 chars, unique across workflows (trace-id prefix)
  category: "<Onboarding|Separations|Utils|...>",
  iconName: "<LucideIconName>",
  systems: [
    {
      id: "ucpath",
      // Auth runs at the matching auth:<id> step. Defer Duo-bearing logins to a
      // handler step (no-op login here) when the run may sit pending first.
      login: async (page, instance, context) => {
        const ok = await loginToUCPath(page, instance, context?.abortSignal);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  steps,
  schema: <Name>InputSchema,
  runtimePolicy: <NAME>_RUNTIME_POLICY,
  detailFields: [
    { key: "emplId", label: "Empl ID" }, // must be populated via ctx.updateData before handler returns
  ],
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "eid", value: input.emplId, prefix: "<Human Label>" }),
  handler: async (ctx, input) => {
    const page = await ctx.page("ucpath");
    await ctx.step("<business-step-1>", async () => {
      // Playwright work via src/systems/<system> drivers + selectors registry.
      // ctx.updateData({ emplId: input.emplId, name: "..." }); // populate detailFields
    });
  },
});

export async function run<Name>Workflow(input: <Name>Input) {
  await runWorkflow(<camelName>Workflow, input);
}
```

> `batch`, `presets`, `matchKey`, `initialData`, `statusExtensions`, `queueTitle`, `deriveItemId` are optional — add only when needed. Full field reference: `references/kernel-api.md`.

### `index.ts`
```ts
export { <camelName>Workflow, run<Name>Workflow } from "./workflow.js";
// Re-export any primitive other callers need (mirror person-lookup/index.ts).
```

### `AGENTS.md`
Document what it does, the data flow, kernel config (systems/steps/archetype/inputSubject/code), gotchas, and a Lessons Learned section. This is read before any future edit — make it real, not a stub.

## Step 3 — Wire it (this is where workflows actually break)

Do **all** that apply. Exact contents and line anchors: `references/wiring.md`.

| Wire | File | When |
|------|------|------|
| Daemon loader | `src/core/workflow-loaders.ts` → `WORKFLOW_LOADERS` | Always (any workflow that runs as a daemon/enqueue target) |
| Eager metadata import | `src/tracker/dashboard/workflows.ts` | Always (so `/api/workflow-definitions` exposes it) |
| Start surface list | `src/domain/dashboard-run-surfaces.ts` → `DASHBOARD_INPUT_RUN_WORKFLOWS` or `DASHBOARD_UPLOAD_RUN_WORKFLOWS` | If it has a start surface |
| Input parser | `src/dashboard/lib/input-run-registry.ts` | Input-run workflows (parse typed IDs/names → input objects) |
| Upload modal | `src/dashboard/lib/run-modal-registry.ts` → `RUN_MODAL_REGISTRY` | Upload-run workflows |
| OCR form spec | `src/services/ocr/forms/` + `registry.ts` `FORM_SPECS` | New OCR **form type** (see `references/delegation-and-fanout.md`) |

A **delegated-only subworkflow** still needs the daemon loader + eager import, but **no** start surface and **no** input/upload registry entry — its only caller is a parent via `ctx.delegateTo`.

**Do NOT:** add a `cli.ts` subcommand, add `npm run <name>` / `<name>:stop` scripts, create a workflow-local `tracker.ts`, or use default exports. These are all retired or guarded.

## Step 4 — Delegation & fan-out (if it composes)

If this workflow delegates to children, or is an OCR form that fans out approved records to downstream workflows, read `references/delegation-and-fanout.md` before wiring. Key rules: delegation routes only through `ctx.delegateTo` / `ctx.delegateToAll` (direct child `runWorkflow(...parentRunId...)` is guard-forbidden); cross-daemon coordination uses `watchChildRuns`; OCR approve fan-out is form-spec-driven via `approveTo` (per-record) and `approveDocumentTo` (once-per-document). Before delegating onto your own daemon or self-emitting rows, skim `references/pitfalls.md` — the single-worker self-delegation deadlock and the self-emit re-stamping rule both live there.

## Step 5 — Verify

```bash
npm run typecheck            # the workflow must compile
npm run test:architecture    # guards: inputSubject coverage, no default exports, no inline page.locator, delegation routing
npm run test                 # unit + scenario tests
npm run lint                 # lint failures are task failures
```

Pre-flight checklist — confirm each before declaring done:

- [ ] `schema.ts` / `workflow.ts` / `config.ts` / `index.ts` / `AGENTS.md` created
- [ ] `inputSubject`, `archetype`, `code` (unique), `operatorSubject` all set
- [ ] `detailFields` keys are populated by `ctx.updateData(...)` before the handler returns
- [ ] `WORKFLOW_LOADERS` entry added; eager import in `tracker/dashboard/workflows.ts`
- [ ] Start surface + matching registry entry added (or intentionally omitted for a delegated-only child)
- [ ] Delegation/fan-out wired through the kernel (if composing)
- [ ] `npm run typecheck` + `npm run test:architecture` + `npm run lint` pass
- [ ] Cross-checked the design against `references/pitfalls.md` (no self-daemon `delegateToAll`, no hand-spelled `.tracker/` paths, batching via `delegation` flags not `archetype`)

## Conventions

- No default exports anywhere in `src/`.
- No inline `page.locator(...)` in system files — go through the selectors registry (`custom-hr-selector-map` skill / `npm run selector:search`).
- Shared helpers used by 2+ workflows belong in `src/domain`, `src/core`, `src/services`, or `src/systems` — not in `src/workflows/<name>/`.
- Structured `log.*` only; no `console.*`, toasts, or Telegram from workflow code.
