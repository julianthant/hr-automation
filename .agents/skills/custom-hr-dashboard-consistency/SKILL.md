---
name: custom-hr-dashboard-consistency
description: >
  Project specialization of the global `custom-consistency-audit` skill for the
  hr-automation dashboard. Preloaded with the dashboard's sibling vocabulary,
  canonical patterns, and authoritative source references so the audit can
  immediately name the canon and flag divergences — no rediscovery required.
  Invoke when the user says "/custom-hr-dashboard-consistency", "are these rows/panels/footers
  consistent", "all footer rows should look the same", "make the queue rows
  consistent", "does this panel match the others", "consistency check the
  dashboard", or "do all log panels look the same".
---

# /custom-hr-dashboard-consistency

This skill specializes the global `custom-consistency-audit` skill for the
**hr-automation dashboard** (`src/dashboard/`). Read that skill first for the
full audit METHOD — sibling-finding heuristics, the comparison-matrix
dimensions, divergence ranking, and the unify-or-patch decision. This file
supplies only the hr-automation specifics the base skill would otherwise spend
a pass discovering.

Base skill: `~/.Codex/skills/custom-consistency-audit/SKILL.md`

---

## Authoritative references (read before auditing)

| Source | What it governs |
|---|---|
| Root `AGENTS.md` — "Architecture" section | Three orthogonal axes of a queue row; shape/scope/kind model; RowFooter standing rule; trace-id format; status extensions; operation semantics |
| `docs/engineering/workflow-vocabulary.md` | Canonical vocab: 3 row primitives + 3 delegation variants; "terms to delete" list (flag synonym drift against this) |
| `src/dashboard/AGENTS.md` | Component-tree layout, UI editing rules (color tokens, icon library, interactive elements, focus, contrast), Tailwind compliance, operator-text rule |
| `src/dashboard/components/AGENTS.md` | Folder ownership: which surface owns which components |

---

## Known sibling families

Use these as the starting sibling set when the user's target is ambiguous.
The base skill's heuristics still apply — these are the pre-discovered names.

### 1. Queue row renderers (`src/dashboard/components/queue-panel/`)

Every row a user sees in a workflow's queue panel:

| Component | Row shape | File |
|---|---|---|
| `EntryItem.tsx` | `single` (+ batch-member, operation-member nested use) | `queue-panel/EntryItem.tsx` |
| `DaemonBatchRow.tsx` + `batch-row-variants.tsx` | `batch` coordinator card | `queue-panel/DaemonBatchRow.tsx`, `batch-row-variants.tsx` |
| `OperationRow.tsx` + `operation-row-variants.tsx` | `operation` coordinator card | `queue-panel/OperationRow.tsx`, `operation-row-variants.tsx` |
| `group-row-base.tsx` | Shared structure underlying batch + operation card bodies | `queue-panel/group-row-base.tsx` |

**Card shell:** All four route through `QueueRowCard` (`queue-panel/QueueRowCard.tsx`), which
owns the border/rounded/hover/selection-ring chrome and renders `RowFooter` inside.

**Footer:** `RowFooter` (`queue-panel/RowFooter.tsx`) is the ONE shared footer. Standing rule from root `AGENTS.md`:
> "Every queue row renders its footer via RowFooter through QueueRowCard (never a bespoke footer — this is a documented standing rule)."

A footer that does not pass through `QueueRowCard → RowFooter` is a **Bug** divergence.

### 2. Status chips / badges (`src/dashboard/components/queue-panel/`)

Every status badge uses the same house tint pattern (from `src/dashboard/AGENTS.md`):
`bg-<token>/12–15 + text-<token> + border-<token>/30`. Canonical status keys live in
`EntryItem`'s `STATUS_CONFIG` and `operation-row-variants.tsx`'s `HEADER_STATUS`
(mirrors `STATUS_CONFIG` for coordinator headers). Both tables must track the same
statuses: `running`, `done`, `failed`, `cancelled`, `pending`, `skipped`, `needsReview`, `notFound`.
A status present in one but absent in the other is an inconsistency to flag.

Shared classifier: `statusKeyForEntry` (`shared/status-styles.ts`) — the single source for
the `failed + step==="cancelled" → "cancelled"` override. Every chip that derives
status must route through this function; inline `entry.status === "failed" && entry.step === "cancelled"`
checks are a divergence.

### 3. Queue row title + subtitle

Single source of truth: `resolveQueueRowPresentation` (`src/domain/queue-row-presentation.ts`).
Title by kind:
- `person` — resolved employee name (pending: typed name/EID)
- `file` — PDF filename (`data.pdfOriginalName`)
- `catalog` — registry/spec label

Subtitle rule: **EID if present** (flat `single` rows only) **else trace id**.
Batch/preview group anchors and member rows: always trace id (EID is already on the title line).
This is the `preferTraceIdSubtitle` flag on `resolveQueueRowPresentation`.

Audit flag: any component that produces a title or subtitle by a path OTHER than
`resolveEntryName` / `resolveEntryId` (`shared/entry-display.ts`, which calls
`resolveQueueRowPresentation` internally) is a divergence — unless it is explicitly
overriding via `projection.title` / `projection.subtitle` from the kernel projection,
which is the sanctioned override path.

### 4. Footer action button schema (`src/dashboard/components/shared/`)

Canonical schema (status-gated by `rowActionEnabledForStatus` in `src/domain/workflow-runtime/projection.ts`):

```
time · #run · id · ⟨spacer⟩ · elapsed|duration · ▲ bump · ↻ retry · × cancel · 🗑 delete
```

- `running` → `×` only
- `queued` → `▲ ×`
- `done/failed` → `↻ 🗑`

Individual action button components: `BumpButton`, `RetryButton`, `RowCancelButton`,
`DeleteButton` (all in `shared/`). They self-hide on their descriptor's `enabled` flag;
they never branch on `entry.status` themselves. Status gating lives in the projection,
not the component. Any button that branches on `entry.status` directly is a **Bug**.

Batch/operation bulk footers (`BatchFooterActions`, `ApprovalDelegationFooterActions`) have
their own bulk schema (retry-all / delete-all / cancel-all) and are intentionally different
from the per-row schema — flag only when the bulk schema is used where a single-row schema
is required or vice versa.

### 5. Log panels (`src/dashboard/components/log-panel/`)

Every workflow's detail pane uses a single `LogPanel` (`log-panel/LogPanel.tsx`), which
contains `LogStream` (`log-panel/LogStream.tsx`). The panel renders:
- `StepPipeline` — step-by-step progress bar (gated; operation coordinators use
  `computeOperationPipelineView`, OCR rows use `computeOcrPipelineView`, others use default)
- Surface segmented control: `Logs | Screenshots | Preview | Edit Data`
- Category dropdown under Logs: `All | Errors | Fill | Navigate | Extract | Debug | Events`
- `ScreenshotsPanel` / `BatchScreenshotsPanel` (Screenshots surface)
- `EditDataTab` (Edit Data surface)
- `previewSlot` / `previewHeaderSlot` (Preview surface — OCR review body)

Audit target: if any workflow's LogPanel shows a component that other workflows' LogPanels
do not show (e.g. a workflow-specific hard-coded chip or extra header row), that is
a divergence. The detail-grid (detailFields) is intentionally per-workflow — it is NOT a
divergence. Operation coordinator rows intentionally hide detailFields (no person
detailFields on a file/operation row — showing empty cells reads as broken).

### 6. Session cards (`src/dashboard/components/terminal-drawer/`)

`WorkflowBox.tsx` — one session card per daemon instance. Every card has:
- Title: workflow label, ordinal stripped (`displayInstance` strips `\s\d+$` always)
- Subtitle: `currentTraceId` only while `itemInFlight`; falls back to phase text otherwise
- Footer: current step (`currentStep`, never raw `currentItemId`)
- Stop pill: per-instance stop (`/api/daemon/stop-instance`), never workflow-scoped

Audit: any session card that shows the trailing ordinal in its title, or shows a raw item id
(not a trace id or phase text) in its subtitle, or uses a workflow-scoped stop, is a Bug.

### 7. Workflow rail badges (`src/dashboard/components/navigation/WorkflowRail.tsx`)

Badge counts are backend-authoritative. The frontend must consume SSE `wfCounts` via
`buildWorkflowRailEntryCounts` without override from local QueuePanel state. Any local
count override on the rail is a Bug.

### 8. Status filter / StatPills (`src/dashboard/components/queue-panel/StatPills.tsx`)

Six canonical chips: `All | Running | Queued | Done | Failed | Cancelled`. Cancelled is a
distinct chip (amber/warning, `Ban` icon) — never bucketed under Failed. The count logic
uses `countEntriesByQueueStatus` / `entryMatchesStatusFilter` (`queue-status.ts`), routed
via the canonical `statusKeyForEntry`. Any surface that merges cancelled into failed is a Bug.

---

## Three-axes model (queue row)

Every queue row has exactly three independent axes. Confusion across axes is the #1 source
of inconsistency bugs in this codebase:

| Axis | Field | Values |
|---|---|---|
| **Shape** | `data.archetype` | `single`, `preview`, `batch`, `batch-member`, `operation`, `operation-member` |
| **Scope** | `parentRunId` | root (absent) vs delegated (present) |
| **Kind** | `data.queueRowKind` | `person`, `file`, `catalog` |

Kind drives ONLY title + subtitle (via `resolveQueueRowPresentation`). It never drives
layout, footer buttons, grouping, or status chips. Any component that switches on `queueRowKind`
for anything other than title/subtitle is a divergence.

Shape drives rendering surface — which component renders the card, whether member rows are
expanded inline, whether `OperationCancelButton` appears. Scope (`parentRunId`) only signals
parent-child relationship; it does not change which component renders.

---

## Canonical patterns to compare against

When the base skill asks "what is the canonical pattern?", default to:

1. **Footer:** `QueueRowCard → RowFooter` with `rowAction` (single) or `actions` ReactNode
   (batch bulk). Any deviation is a Bug unless it is the documented `OperationCancelButton`
   slot (post-approval operation coordinators).
2. **Status badge tone:** `bg-<token>/12–15 text-<token> border-<token>/30` (house tint).
   Raw palette classes (`bg-amber-400`, `text-sky-500`) are blocked by architecture tests —
   they are a Bug.
3. **Status derivation:** `statusKeyForEntry` + `resolveQueueRowStatus` for derived statuses.
   No inline `entry.workflow === "..."` status branches in dashboard components.
4. **Title/subtitle:** `resolveEntryName` / `resolveEntryId` (`shared/entry-display.ts`),
   optionally overridden by `projection.title` / `projection.subtitle`.
5. **Icons:** lucide-react components only. Unicode glyphs used as icons are a Bug.
6. **Interactive elements:** `<button>` or `<a>`, not `<div onClick>`. Clickable non-buttons
   need `role`, `tabIndex={0}`, and `onKeyDown` (Enter/Space).
7. **Naming:** canonical vocab from `docs/engineering/workflow-vocabulary.md`. Synonym drift
   (e.g. "passive child", "dispatch row", "flat member", `renderAs:"flat"`, `originWorkflow`,
   `utilityChildSurface`) against the "terms to delete" list in that doc is an **Inconsistent**
   divergence.

---

## Architecture guards that enforce some uniformity

These tests (`npm run test:architecture`) already enforce some consistency automatically.
Cite them when relevant — if a divergence they cover exists, it's already a CI failure:

- `tests/unit/architecture/frontend-tailwind-compliance.test.ts` — raw palette colors, raw hex,
  arbitrary z-index, old `flex-shrink-0`, motion-unsafe animations, `<img>` without srcSet+sizes
- `tests/unit/architecture/code-conventions.test.ts` — no `page.locator(...)` inline in system files,
  no default exports in `src/`
- `tests/unit/architecture/control-layering.test.ts` — layer import boundaries
- `tests/unit/architecture/archetype-coverage.test.ts` — every workflow has an archetype declaration
- `tests/unit/architecture/queue-row-kind-coverage.test.ts` — every workflow declares `inputSubject`

Run `npm run test:architecture` after any unification to confirm guards pass.

---

## Naming-consistency standing rule

The user has a standing preference: use canonical vocab from `docs/engineering/workflow-vocabulary.md`;
do not invent synonyms. The audit MUST flag any of the "terms to delete" list found in
component code, comments, or prop names as an **Inconsistent** divergence. Examples:
`WorkflowArchetype: "delegating"`, `renderAs: "flat"`, `originWorkflow`, `passive-child`,
`dispatch` archetype, `utilityChildSurface`, `waitForOcrApproval`, `prepRow`/`memberRow`
title config.
