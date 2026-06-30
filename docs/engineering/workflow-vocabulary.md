# Workflow Vocabulary

The canonical terms for describing how workflows run, what their rows look like,
and how delegation appears. **If a term is not in this doc, it is not part of
the user-facing model** — it is either an internal implementation detail or
accidental complexity that should be removed.

This doc is the spec. Code that disagrees with it is wrong and should be
brought in line.

> **2026-06-30 — `batch` retired.** The `batch` / `batch-member` row shapes were
> renamed to `operation` / `operation-member` across the codebase. They are no
> longer stampable; old JSONL rows on disk normalize on read via
> `resolveRowArchetype` (`batch → operation`, `batch-member → operation-member`).
> The word "batch" now refers ONLY to batch *processing* (a daemon multi-item
> run, `withBatchLifecycle`, dependency batches) — never a row shape.

---

## Row Display Fields

| Field | Meaning |
|---|---|
| **title** | The main title of the row. |
| **subtitle** | The footer text shown beside the run number. |

## The Row Archetypes

Every row in the dashboard is one of these things:

| Primitive | What it is |
|---|---|
| **single row** | One flat row in a workflow's tab. Represents one run. |
| **approval row** | A review surface over an OCR'd document that **gates downstream fan-out on operator approval**. The operator approves/discards extracted records; on approve they fan out to downstream rows. Today: oath, emergency-contact. (Formerly called the "preview row".) |
| **preview row** | A review surface over an OCR'd document that needs **no approval** — read-only. The operator inspects, then discards; nothing fans out. Today: verify (the mixed oath+EC completeness report). |
| **operation row** | A parent/coordinator row that houses N operation members. Represents one logical multi-person operation (a fan-out or a multi-value input run). |
| **operation member** | A single row that lives inside an operation row. |

**Approval row and preview row are the same code archetype (`preview`).** What
separates them is whether the OCR form spec declares approve fan-out targets
(`approveTo` / `approveDocumentTo`): a form that declares either is an approval
row and shows an **Approve** button in the review pane; a form that declares
neither is a preview row with no Approve button. Both block at
`awaiting-approval` until the operator acts (approve vs discard).

### Rules

1. **Operations don't nest.** An operation row's members are always single rows,
   never other operation rows.
2. **Approval/preview is not an operation.** OCR can own child work and approval
   state, but its row archetype is `preview`, not `operation`.
3. **Every row lives in its own workflow's tab.** A row produced by workflow
   `X` always renders in workflow `X`'s queue panel. Delegation never moves a
   row to a different tab.

---

## The 3 delegation variants

When a workflow calls `ctx.delegateTo(child, input)` or
`ctx.delegateToAll(child, inputs)`, the child appears as one of:

| Variant | What the child looks like | When to use |
|---|---|---|
| **delegated single** | A single row in the child workflow's tab | The child is a one-shot task — utility lookup, single download, single transaction |
| **delegated approval** | An approval row | The child needs operator approval before it can continue (e.g. OCR extraction that fans out on approve) |
| **delegated operation** | An operation row (with N members) in the child workflow's tab | The child is itself a group — multiple peers of the same kind belong together |

(A preview row — read-only, no approval — is almost always a standalone run, not
a delegation target; nothing downstream waits on it.)

The "delegated" prefix means **a parent is waiting on this run**. It does not
change where the row renders. The row lives in the child workflow's own tab
either way; the kernel just tracks the parent-child relationship internally so
the parent can `await` the child's terminal status.

### Picking a variant

- **Use delegated operation when you fan out N children of the same kind.**
  Example: oath-signature operation → N per-signer members.
- **Use delegated approval when the child needs operator approval mid-run.**
  Example: OCR row that waits for the operator to confirm extracted rows
  before fanning out.
- **Use delegated single otherwise.**
  Example: OCR delegating person-lookup once per unmatched name.

### How the variant is decided

There are two ways a delegation can become an operation:

**1. The child workflow declares its delegated members are always grouped.**

A workflow whose fan-outs are conceptually always a group of people (a roster /
PDF) sets `runtimePolicy.delegation.alwaysOperationDelegatedMembers` so even a
single delegated child renders as a one-member operation surface. Workflows
declare their per-run archetype on the definition:

```ts
defineWorkflow({
  name: "oath-signature",
  archetype: "single",  // the workflow row is a single; its PDF surface is
                        // the operation coordinator with operation-member children
});

defineWorkflow({
  name: "ocr",
  archetype: "preview",
});

defineWorkflow({
  name: "person-lookup",
  archetype: "single",
});
```

When a parent calls `ctx.delegateTo(oathSignature, { pdfPath })`, the result
is a single row in oath-signature's tab. The per-signer rows are
`operation-member` rows stamped under the operation coordinator — not members
of oath-signature itself.

**2. The parent fans out N peers via `delegateToAll`.**

Even if the child workflow's archetype is `single`, calling
`ctx.delegateToAll(child, inputs)` with N≥2 inputs groups them into one
operation row in the child's tab, with each input as an operation member.

```ts
await ctx.delegateToAll(personLookup, [oneInput]);
// → 1 single row in person-lookup's tab
//   (unless the workflow sets alwaysOperationDelegatedMembers, then a 1-member operation)

await ctx.delegateToAll(personLookup, [input1, input2, input3]);
// → 1 operation row in person-lookup's tab, with 3 operation members
```

The rule: **N=1 degenerates to a single row. N≥2 produces an operation row
with N members** (unless the workflow opts every delegated member into an
operation surface via `alwaysOperationDelegatedMembers`).

Overrides at the call site exist but should be rare. A workflow that
constantly needs overriding is a workflow with the wrong default.

---

## Worked example: the full oath flow

### Case A — PDF with multiple people

```
ocr tab:
└── OCR for the PDF [approval row]

person-lookup tab:
└── person-lookup operation [operation row, delegated from OCR]
    ├── lookup for "John D."   [operation member]
    ├── lookup for "Mary S."   [operation member]
    └── lookup for "Sam K."    [operation member]

oath-signature tab:
└── PDF filename [operation coordinator — display only, no daemon task]
    subtitle: Oath · <last4 oath-signature PDF run id>
    ├── Alice (12345)  [operation member]
    ├── Bob   (67890)  [operation member]
    └── Carol (11223)  [operation member]
└── oath-signature [single row, the actual daemon task]

oath-upload tab:
└── oath-upload [single row, waiting on the oath-signature run above]
    (then files HR ticket when the operation completes)
```

### Case B — PDF with one person

```
ocr tab:
└── OCR for the PDF [approval row]

person-lookup tab:
└── lookup for "John D." [single row, delegated from OCR]
    (no operation — only one person, so a single is enough)

oath-signature tab:
└── PDF filename [operation coordinator — display only, no daemon task]
    subtitle: Oath · <last4 oath-signature PDF run id>
    └── John D. (12345) [operation member]
└── oath-signature [single row, the actual daemon task]

oath-upload tab:
└── oath-upload [single row, waiting on the oath-signature run above]
```

Notice the EID rule: **N≥2 OCR lookup peers fan out into an operation row; N=1
stays as a single row.** The oath-signature PDF surface is the operation
coordinator — a display-only row stamped at OCR approve time; the actual daemon
run is a `single` row and operation-member rows are its fanned-out signer
children.

Every row is in its own workflow's tab. No synthesized parents in other tabs.
No cross-tab nesting. Each workflow's queue panel shows only that workflow's
own work.

---

## Code aliases (current state → canonical term)

This section maps the canonical vocabulary to the `RowArchetype` /
`WorkflowArchetype` values in code.

| Canonical term | Name in code | Notes |
|---|---|---|
| single row | `RowArchetype: "single"`, `WorkflowArchetype: "single"` | Aligned |
| approval row | `RowArchetype: "preview"`, `WorkflowArchetype: "preview"` + a form spec with `approveTo`/`approveDocumentTo` | OCR oath / emergency-contact. The code archetype is still `"preview"`; "approval row" is the canonical name for the variant that gates fan-out on approval. |
| preview row | `RowArchetype: "preview"`, `WorkflowArchetype: "preview"` + a form spec with **no** approve targets | OCR verify (read-only completeness report). Same `"preview"` code archetype; no Approve button. |
| operation row | `RowArchetype: "operation"`, `WorkflowArchetype: "operation"` (display-only coordinator) | oath-signature / emergency-contact / onbase PDF-upload coordinator, and multi-value input runs. The OCR run delegates under it; fan-out children stamp `operation-member`. |
| operation member | `RowArchetype: "operation-member"` | Signer/contact rows fanned out under an `operation` coordinator. Stamped via the `rowShape: "operation-member"` runtime option (gated on `isOperationCoordinatorWorkflow`). Projects to a `single` surface when rendered. |
| delegated single | `RowArchetype: "single"` + `parentRunId` | Scope is parentage, not a separate archetype |
| delegated approval | `RowArchetype: "preview"` + `parentRunId`, `runtimePolicy.preview`, OCR's approval surface | Scope is parentage, not a separate archetype |
| delegated operation | `RowArchetype: "operation"` + `parentRunId`, with peer children stamped `operation-member` | Scope is parentage, not a separate archetype |

### Retired / removed terms

These existed historically and have no place in the canonical vocabulary:

- **`RowArchetype: "batch"` / `WorkflowArchetype: "batch"` / `RowArchetype: "batch-member"`** —
  renamed 2026-06-30 to `operation` / `operation-member`. No longer stampable;
  old JSONL normalizes on read. "Batch" now means batch *processing* only.
- `WorkflowArchetype: "delegating"` — redundant; a workflow that delegates is
  still a single or operation from a row-shape perspective. Delegation is what
  its handler does, not what its row looks like.
- Legacy `WorkflowArchetype: "delegating-batch"` — same redundancy. The
  workflow's row is an operation; "delegating" is handler behavior.
- Legacy `WorkflowArchetype: "utility"` — collapse into `delegated single` (a utility
  child is just a delegated single that the parent uses for plumbing).
- Legacy `RowArchetype: "passive-child"` — collapse into `delegated single`. There is
  no "passive" vs "active" child in the canonical model — a child is just a
  delegated row.
- Legacy `RowArchetype: "dispatch"` — a dispatch marker is now a `single` row
  with `data.delegationRole = "dispatch"`.
- `renderAs: "flat"` — collapse into `delegated single`. "Flat" was the
  rendering hack for "put this under the parent inline"; in the canonical model
  every delegated row lives in its own tab, so there's no flat/grouped
  distinction. (`renderAs: "operation"` — formerly `"batch"` — stamps an
  `operation-member` under the parent.)
- `originWorkflow` — the entire mechanism for synthesizing a parent row in a
  different workflow's tab is deleted. Rows always live in their own tab.

### Terms that stay

These map cleanly and just need consistent use:

- `defineWorkflow` — the way you declare a workflow. Unchanged.
- `ctx.step(name, fn)` — wraps a unit of work in your handler. Unchanged.
- `ctx.delegateTo(child, input)` / `ctx.delegateToAll(child, inputs)` — the
  only way to call another workflow as a step. Unchanged.
- `ctx.page(id)` — get an authenticated Playwright page for a system.
  Unchanged.
- `ctx.signal` — abort signal for the current run. Unchanged.
- `ctx.updateData(patch)` — merge data into the row's display fields.
  Unchanged.
- `runId`, `parentRunId`, `workflowInstance` — internal identifiers, not
  user-facing vocabulary. Stay as internal terms.

---

## Presentation Config

These terms describe the operator-configurable display layer introduced in 2026-06.
They are **purely presentational** — none affects workflow execution logic.

### presentation config

The `WorkflowPresentationConfig` block on a workflow's metadata (`WorkflowMetadata.presentation`). Carries three sub-configs: `naming` (title/subtitle/trace schemes), `steps` (display order + hide/relabel rules), and `delegation` (member and prep naming + coordinator label suffix). Always present after registry normalization — never undefined at runtime.

### naming scheme

The display rule for one of the three naming slots:

| Slot | What it controls | Default |
|---|---|---|
| **title scheme** | Main row title | `person-name` (person), `pdf-filename` (file), `catalog-label` (catalog) |
| **subtitle scheme** | Footer text beside the run number | `eid-else-trace` (person), `trace-only` (file/catalog) |
| **trace scheme** | How new runs compose their `__traceId` | `code-time-runid` — `{code}-{HHMMSS}-{runId4}` |

Each slot accepts a curated scheme id or `custom-template` (a `{token}`-interpolated string). The available scheme ids live in `SCHEME_LIBRARY` (`src/domain/workflow-presentation/schemes.ts`) and are exposed to the frontend via `GET /api/workflow-presentation/:workflow` → `schemeLibrary`. The titleless person-anchor scheme is `operation-anchor` (formerly `batch-anchor`). Changing a trace scheme only affects **new** runs — it never rewrites a row's frozen `data.__traceId`.

### override store / effective presentation

The git-tracked JSON files under `config/workflow-presentation/<workflow>.json`. Every field is optional — only set keys override the code defaults. The runtime merges overrides at serve-time: `effectiveMetadata(meta, repoRoot)` = `applyOverride(meta, readOverride(repoRoot, name))`. Display overrides (`naming`, `steps`, `delegation`, `label`) apply hot on every `/api/workflow-definitions` response with no backend restart; execution-affecting config (`presets`, `skipSteps`) applies at the next daemon spawn. Reads are fail-soft (bad file logs a warn); writes are fail-loud (validated against `WorkflowOverrideSchema`).

### delegation naming

The `DelegationDisplayConfig` sub-block of `WorkflowPresentationConfig`. Controls how rows produced by fan-out appear:

| Field | What it controls |
|---|---|
| `memberTitle` / `memberSubtitle` | Naming for delegated operation-member rows (fanned-out signers / contacts) |
| `prepTitle` | Naming for OCR prep rows delegated under this coordinator |
| `coordinatorLabelSuffix` | Suffix appended to an operation coordinator's label (e.g. `"Operation"`) |

Delegation naming does **not** affect operation member rows produced by a different member workflow (those use the member workflow's own `naming` config) or standalone single rows.

---

## How to use this doc

When designing or describing a workflow:

1. Pick the **row archetype** for your workflow: `single`, `preview`, or
   `operation`.
2. If it's an operation row, what are its members?
3. If other workflows will delegate to it, keep the same row archetype and use
   `parentRunId` for scope.
4. In your handler, call `ctx.delegateTo` / `ctx.delegateToAll` to compose
   other workflows. The child's archetype and the fan-out count decide how it
   appears; override at the call site only if you have a real reason.
5. Every row will appear in your workflow's own tab. Never assume your child
   rows will appear under you in your own tab — they live in their own tab.

That is the whole model.
