# Wiring a new workflow into the dashboard + daemon

Exact files and shapes. A new workflow does **nothing** until it's wired here. Verified against current source.

## 1. Daemon loader — always

`src/core/workflow-loaders.ts` → add one entry to `WORKFLOW_LOADERS`. Both daemon spawn and dashboard `/api/enqueue` pick it up automatically.

```ts
"<name>": async () => {
  const mod = await import("../workflows/<name>/index.js");
  return mod.<camelName>Workflow as unknown as AnyRegisteredWorkflow;
},
```

## 2. Eager metadata import — always

`src/tracker/dashboard/workflows.ts` → add a side-effect import so `/api/workflow-definitions` exposes the workflow's metadata (label, steps, detailFields, category, icon) to the SPA.

```ts
import "../../workflows/<name>/index.js";
```

## 3. Start surface — if it has one

`src/domain/dashboard-run-surfaces.ts` → add the name to exactly one list:

- `DASHBOARD_INPUT_RUN_WORKFLOWS` — operator types IDs/names (uses `InputRunPanel`).
- `DASHBOARD_UPLOAD_RUN_WORKFLOWS` — operator uploads a file (uses `RunModal`).

A **delegated-only subworkflow** goes in **neither** list (and not in `RETIRED_DASHBOARD_WORKFLOWS`). Steps 1 + 2 are still required.

## 4a. Input parser — input-run workflows only

`src/dashboard/lib/input-run-registry.ts` → add an entry keyed by `<name>`:

```ts
"<name>": {
  placeholder: "Enter EIDs or names, semicolon-separated (e.g. 10873698; Battistessa, Johnnie)",
  parseInput: parsePersonLookupInputs, // or parseCommaSeparated("emplId", {...}) — reuse existing parsers
},
```

`parseInput(raw)` returns `{ ok: true, inputs: TData[] }` (one object per row) or `{ ok: false, error }`.

## 4b. Upload modal — upload-run workflows only

`src/dashboard/lib/run-modal-registry.ts` → add an entry to `RUN_MODAL_REGISTRY` keyed by `<name>`. Fields include `endpoint` (often the shared `/api/ocr/prepare`), optional `formType` picker, and `lockedFormType` to pin a workflow's run button to a specific OCR form (how `emergency-contact` and `oath-upload` surface dedicated Run buttons that delegate to the shared OCR prepare endpoint).

## 5. OCR form type — new form only

See `references/delegation-and-fanout.md` §4: add the spec file under `src/services/ocr/forms/`, a record renderer in `src/dashboard/components/ocr/`, and register in `FORM_SPECS` (`src/services/ocr/forms/registry.ts`).

## Retired patterns — do not add

- ❌ `cli.ts` Commander subcommand for the workflow. `src/cli.ts` keeps only `test-login`, dashboard, export, and daemon controls.
- ❌ `npm run <name>` / `<name>:stop` start scripts. Dashboard is the only public start path; only daemon-`stop` scripts remain for already-wired workflows.
- ❌ workflow-local `tracker.ts`. Kernel JSONL + dashboard are the only observability surface.
- ❌ default exports anywhere in `src/`.
- ❌ YAML/batch-file starts.

## Post-wiring verification

```bash
npm run typecheck
npm run test:architecture   # inputSubject coverage, default-export ban, inline-locator ban, delegation routing
npm run test
npm run lint
```
