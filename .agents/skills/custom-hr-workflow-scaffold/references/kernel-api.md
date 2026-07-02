# Kernel API reference — `defineWorkflow` config

Source of truth: `src/core/kernel/types.ts` (`WorkflowConfig<TData, TSteps>`) and `src/core/kernel/workflow.ts` (`defineWorkflow`). When in doubt, read those — this is a distilled map.

## Table of contents
- [Required fields](#required-fields)
- [Identity & display](#identity--display)
- [Row classification](#row-classification)
- [Data & detail panel](#data--detail-panel)
- [Behavior](#behavior)
- [The handler & `ctx`](#the-handler--ctx)
- [Auth & systems](#auth--systems)

## Required fields

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | kebab-case, the canonical id used everywhere (loaders, surfaces, registries). |
| `systems` | `SystemConfig[]` | Each `{ id, login }`. Drives auto-prepended `auth:<id>` steps. |
| `steps` | `readonly string[]` (`as const`) | Business step names. Kernel prepends `auth:<id>` per system unless `authSteps: false`. |
| `schema` | `ZodType<TData>` | Validates one run's input. |
| `handler` | `(ctx, data) => Promise<void>` | The orchestration. |

`inputSubject` is *typed* optional but **practically required**: the `queue-row-kind-coverage` architecture guard fails the build if a real workflow omits it.

## Identity & display

| Field | Purpose |
|-------|---------|
| `label` | Human label in the dashboard (e.g. "Oath Signature"). |
| `code` | **2-char**, unique across workflows. Prefix of the trace id `<code>-<HHMMSS>-<runId4>` (`src/domain/queue-trace-id.ts`) and the daemon instance prefix. Defaults to `name.slice(0,2)` — set it explicitly to avoid collisions. |
| `category` | Dashboard `WorkflowRail` group header (e.g. "Onboarding"). Omit → "Other". |
| `iconName` | Lucide-react icon name; unknown names fall back + warn. New icon → one entry in `src/dashboard/lib/workflow-icons.ts`. |

## Row classification

| Field | Purpose |
|-------|---------|
| `inputSubject` | `name\|eid\|email\|kualiId\|pdf\|selector`, literal or `(input)=>subject`. Derives `queueRowKind` (person/file/catalog). See `references/row-model.md`. |
| `archetype` | `single \| preview \| batch`, literal or resolver. Defaults: `batch` if `batch:` set, else `single`. |
| `runtimePolicy` | Serializable projection/action policy (delegation scoping, preview affordances, member-row titles, prep-row titles). Spread `DEFAULT_WORKFLOW_RUNTIME_POLICY` and override. |
| `statusExtensions` | Optional workflow-specific derived status + supplemental status chip (e.g. person-lookup A/IA tag). `src/domain/queue-row-status.ts`. |
| `queueTitle` | Optional global queue-row title policy. |

## Data & detail panel

| Field | Purpose |
|-------|---------|
| `detailFields` | Dashboard detail-panel rows: `{ key, label }`. Labeled entries are runtime-warned if never populated via `ctx.updateData`. |
| `getName` / `getId` | Derive display name/id from accumulated stringified `data`. Run server-side on each emit → `data.__name` / fallback to entry id. |
| `initialData` | Seed `data` from input **before** the first `pending` emit (so the queue shows something during the auth window, before handler `updateData` runs). |
| `matchKey` | Data key powering EditDataTab "Copy from prior run" (e.g. `"eid"`). Surfaces past runs of the same workflow sharing that value. |
| `operatorSubject` | `(input) => OperatorSubject \| null`. The operator-facing label for queue rows, toasts, task rows. Build via `buildOperatorSubject({ kind, value, prefix })`. |
| `deriveItemId` | Stable tracker/queue item id from input when the natural key isn't a top-level id/docId/email (e.g. person-name searches). Derive from a **stable input field** and **never return `""`** — an empty id makes rows invisible (the JSONL validator rejects them) and the enqueue boundary now throws on it. The kernel calls this with the **cleaned logical input** (`__runtimeOptions`/`prefilledData` already stripped), so don't key on object identity / `JSON.stringify` of the wrapped input. See the "Item identity" pitfall in `references/pitfalls.md`. |

## Behavior

| Field | Purpose |
|-------|---------|
| `batch` | `BatchConfig` — `{ mode: "sequential" \| "pool", preEmitPending?, betweenItems? }`. Presence flips default archetype to `batch`. `betweenItems: ["reset"]` resets the browser to about:blank between items. |
| `authSteps` | Default `true` (auto-prepend `auth:<id>`). Set `false` if the workflow declares its own auth step names (e.g. onboarding's `crm-auth`, `ucpath-auth`). |
| `presets` | Named run-mode presets in the input-run gear menu. Handler must honor each via `ctx.shouldSkipStep(name)`. |
| `version` | Optional. |

## The handler & `ctx`

`handler: async (ctx, input) => { ... }`. Key `ctx` members:

- `ctx.step(name, fn)` — run a declared business step (emits running/done/failed + screenshots). Step names must be in the `steps` tuple.
- `ctx.skipStep(name)` — mark a declared step skipped (e.g. EID input path skipping cross-verification).
- `ctx.shouldSkipStep(name)` — honor a selected preset's skip list.
- `ctx.page(systemId)` — get the authenticated Playwright page for a system.
- `ctx.updateData({ ... })` — accumulate display/detail data (populates `detailFields`, `getName`, etc.).
- `ctx.delegateTo(child, input, opts?)` / `ctx.delegateToAll(child, inputs, opts?)` — compose subworkflows (see `references/delegation-and-fanout.md`).
- `ctx.runId` — this run's id (the kernel stamps it as children's `parentRunId`).

## Auth & systems

```ts
systems: [
  {
    id: "ucpath",
    login: async (page, instance, context) => {
      const ok = await loginToUCPath(page, instance, context?.abortSignal);
      if (!ok) throw new Error("UCPath authentication failed");
    },
  },
]
```

- Login imports come from `src/infra/auth/login.js` (`loginToUCPath`, `loginToACTCrm`, …) — **not** `src/auth`.
- **Deferred-Duo pattern:** when a run may sit pending (e.g. an OCR fan-out child that shouldn't open Duo until approval), make the system `login` a **no-op** and perform the real `loginTo*` inside a handler step (`ucpath-auth`). `loginToUCPath` is idempotent, so a daemon Duos once and reuses the warm session. See `oath-signature/workflow.ts`.
