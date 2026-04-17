# Subsystem D — Dashboard Richness Leveling (Design Sketch)

**Status:** Sketch only. Not yet brainstormed or specced. Starts after subsystem A (selector registry) lands, or in parallel with it.
**Priority:** #3 of 4 remaining subsystems.
**Estimated effort:** ~1-2 working days.

## Problem

Dashboard event richness is uneven across workflows:

| Workflow | setStep calls | updateData calls | Detail fields shown | Perceived richness |
|----------|---------------|------------------|---------------------|---------------------|
| onboarding | 7 | ~5 (first/last/dept/position/wage) | 8 | High |
| separations | 7 | ~3 (name, docId, dates) | 4 | High |
| emergency-contact | 3 | 6 | 4 | Medium |
| eid-lookup | 4 | 2 | 4 | Low |
| kronos-reports | 3 | ~2 | 4 | Medium |
| work-study | 2 | Minimal | 4 | Low |

When a user opens the dashboard during a work-study run, the detail panel is nearly empty. When they open it during an onboarding run, it's a rich live view. The UX is inconsistent.

Two deferred items from Phase 1 also belong here:
- **Tracker stringifies all values** at the adapter boundary. Rich types (Date, number, boolean) round-trip as strings and lose fidelity in the dashboard.
- **`WF_CONFIG` in `src/dashboard/components/types.ts` was not fully eliminated** during Phase 1. It still carries per-workflow UI metadata (`label`, `getName`, `getId`, labeled `detailFields`) that the registry doesn't expose. This subsystem fully removes it.

## Goal

Every workflow emits a baseline set of dashboard-relevant events, the tracker preserves type fidelity, and the frontend renders the detail panel from workflow-declared metadata (no hardcoded per-workflow UI).

## Rough approach

### Minimum data contract per workflow

Every workflow must emit, at minimum:

| Event | When | Fields |
|-------|------|--------|
| identity | Soon after start (first successful extraction) | `name`, `id` (email/emplId/docId) |
| step transitions | Between each `ctx.step` | `step` name + entry timestamp |
| current action | Every major operation within a step | Free-form `action` string (optional but encouraged) |
| outcome data | On success | Anything useful for post-hoc review (e.g. transaction ID, affected record count) |

The floor is `name + id + step transitions`. Everything else is encouraged but not enforced.

### Enforcement mechanism

Two options:

**Option A: Declarative `detailFields` + runtime check.** Kernel's existing `detailFields?: (keyof TData)[]` declaration gets promoted from optional to required. Runner emits a warning if a declared field hasn't been populated via `updateData` before `done` fires.

**Option B: Convention + code review only.** Document the contract in CLAUDE.md; rely on review to catch under-emitters.

**Lean: Option A.** Reasoning: the user's stated pain was drift. Runtime enforcement makes drift audible; convention-only reverts to the status quo.

### Extend tracker for rich types

Current tracker signature:
```ts
updateData(data: Record<string, string>): void  // string only
```

Proposed:
```ts
updateData(data: Record<string, TrackerValue>): void
type TrackerValue = string | number | boolean | Date | null
```

Dashboard components render by type (Date → localized date, number → locale-formatted, boolean → ✓/✗ pill). JSONL serialization uses `superjson` or a minimal custom encoder to preserve types across the SSE wire.

### Fully eliminate frontend `WF_CONFIG`

Phase 1 left `WF_CONFIG` in place because it carries UI-specific fields the registry doesn't expose:
- `label` — human-readable workflow name (e.g. "Onboarding")
- `getName(data)` / `getId(data)` — functions to extract display name/id from tracker data
- Labeled `detailFields` — `[{ key: 'firstName', label: 'First Name' }]`

To remove it entirely, extend `defineWorkflow` with these fields:

```ts
defineWorkflow({
  name: 'onboarding',
  label: 'Onboarding',                          // NEW
  getName: (data) => `${data.firstName} ${data.lastName}`,  // NEW
  getId: (data) => data.email,                  // NEW
  detailFields: [                               // UPGRADED: now labeled
    { key: 'firstName', label: 'First Name' },
    { key: 'emplId', label: 'Empl ID' },
    // ...
  ],
  // ... rest of config
})
```

Registry serializes these over `/api/workflow-definitions`. Frontend's `WorkflowsProvider` exposes them via `useWorkflow(name)`. `WF_CONFIG` is deleted from `src/dashboard/components/types.ts`.

Functions (`getName`/`getId`) can't cross the wire, so they either:
- Run server-side in the tracker before emission (computed names travel as data fields)
- Get serialized as string templates (`getName: '${firstName} ${lastName}'`) — evaluated client-side

**Lean: server-side computation.** Simpler, more flexible.

### Dashboard UI: adaptive detail panel

Current detail panel has per-workflow hardcoding. Replace with a generic renderer:

- Reads `detailFields` metadata from registry
- For each field, looks up value in tracker data
- Renders with type-aware formatter (see above)
- Handles missing values gracefully (show `—`, not blank)

This means new workflows get a functional dashboard detail panel automatically — no frontend change needed.

## Key decisions for brainstorm

1. **Enforce the data contract at runtime (emit warning) or via tests only?**
2. **Extend tracker to accept rich types, or keep stringifying and format on the dashboard?** Format-on-dashboard is simpler but loses precision (e.g. large numbers, Dates).
3. **Where do `getName` / `getId` compute?** Server-side (kernel runs them before emission) vs. client-side (ship functions as strings/code). Client-side is a security smell.
4. **Is the dashboard detail panel auto-rendered or hand-designed per workflow?** Auto = consistency; hand = polish. Pick one.
5. **Migration mechanic** — audit each workflow and add missing `updateData` calls, or change the kernel contract and fix fallout?
6. **Should step timings be computed + shown?** E.g. "extraction took 12s, transaction took 45s" — useful for finding slow steps.

## Scope

### In scope
- Audit current `updateData` calls across all 6 workflows; document gaps
- Add missing `updateData` calls to meet the minimum contract
- Extend `defineWorkflow` with `label`, `getName`, `getId`, labeled `detailFields`
- Extend tracker to preserve rich types (or alternate decision: format on client)
- Refactor dashboard detail panel to render generically from metadata
- Delete `WF_CONFIG` from frontend

### Out of scope
- New dashboard layouts / redesign — last redesign was 2026-04-10, not revisiting
- Real-time dashboard features (collaborative cursors, etc.) — scope creep
- Selector registry (subsystem A)
- Retry logic for failed events — belongs in kernel or tracker, not dashboard

## Dependencies

- **Requires:** Subsystem B+E kernel landed. Ideally after all 6 migrations complete, so richness audit reflects real workflow behavior, not the mid-migration transitional state.
- **Blocks:** Subsystem C (the CLAUDE.md rewrite documents the final dashboard contract).

## Risk and open questions

1. **Changing the tracker signature breaks existing JSONL files on disk.** Need a read-compatibility path (old string-only records stay readable). Worth doing a tracker schema version bump.
2. **Server-side `getName` execution** means the kernel must have access to the workflow config when emitting events. Currently the tracker is a separate layer. Refactor scope: small but not zero.
3. **What defines "richness"** is subjective. If the detail panel has 8 fields and shows 4, is that under-rich or is half of the info not useful? Needs a clear minimum, not an ideal.
4. **Batch workflows emit many pending items upfront** via `preEmitPending`. Those don't yet have data — `getName` / `getId` on empty data returns placeholders. Need a "pending display" fallback.

## Rough plan shape (for post-brainstorm)

5-6 tasks:

1. Audit: document current emissions per workflow and gaps (inspection PR, no code changes)
2. Extend `defineWorkflow` config: add `label`, `getName`, `getId`, labeled `detailFields`
3. Extend tracker: rich-type preservation + version bump
4. Refactor frontend detail panel: render from metadata; delete `WF_CONFIG`
5. Per-workflow: fill `updateData` gaps to meet minimum contract (6 small commits)
6. Add a test that runs a mock workflow and asserts all declared `detailFields` get populated
7. Tag `subsystem-d-dashboard-richness-complete`

## Unresolved tension

Adding `label`/`getName`/`getId` to `defineWorkflow` grows the config surface. Reviewer's concern from subsystem B+E applies again: "declarative config tempts adding more fields over time until it's a tiny framework."

Counter-argument: these fields already exist in `WF_CONFIG` — we're just relocating them from a static frontend constant into the workflow's own definition, where they belong. Net config size across the codebase stays flat; co-location improves.

Worth an explicit brainstorm decision rather than assumed inclusion.
