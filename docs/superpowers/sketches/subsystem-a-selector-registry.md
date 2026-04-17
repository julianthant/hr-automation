# Subsystem A — Selector Registry (Design Sketch)

**Status:** Sketch only. Not yet brainstormed or specced. Starts when workflow kernel subsystem (B+E) lands.
**Priority:** #2 of 4 remaining subsystems (after B+E).
**Estimated effort:** ~2-3 working days.

## Problem

150+ Playwright selectors are scattered across 8 modules as inline strings. Survey evidence:

| Module | Approx selector count | Fallback strategy |
|--------|----------------------|-------------------|
| UCPath (`src/systems/ucpath/`) | 51+ | Uses `.or()` chain in **1 file only** |
| CRM | 12 | Uses `.or()` chain in **1 file only** |
| Kuali | 25 | None — hardcoded |
| Old Kronos | 37+ | None |
| New Kronos | 29 | None |
| I9 | 37 | None |

**Only 2 files in the whole codebase** use `.or()` fallback chains, despite PeopleSoft grid IDs mutating on page refresh (e.g. `HR_TBH_G_SCR_WK_TBH_G_SH_EDIT1$0` can become `...EDIT1$11` after a position number fill). When UIs change or indexes shift, selectors break silently or crash with unhelpful errors.

Duplicated patterns also exist — the `document.getElementById(...).click()` modal dismiss pattern appears 4+ times across UCPath transaction, emergency-contact, and Kuali modules.

## Goal

Give every selector a single home, a fallback chain, a verified-date stamp, and runtime observability when a fallback matches (signaling that the primary needs updating).

## Rough approach

### Per-system selector modules

Each system gets a `selectors.ts`:

```
src/systems/ucpath/selectors.ts
src/systems/kuali/selectors.ts
src/systems/crm/selectors.ts
src/systems/old-kronos/selectors.ts
src/systems/new-kronos/selectors.ts
src/systems/i9/selectors.ts
```

Selectors are grouped by page/flow within each file. Each entry carries:
- Primary selector (preferred, most specific)
- 1-N fallbacks
- Verified date (`// verified 2026-04-14`)
- Optional notes (e.g. `// PeopleSoft grid index mutates after save`)

### Two possible shapes

**Shape 1: Direct functions that return Playwright locators**

```ts
// src/systems/ucpath/selectors.ts
import type { FrameLocator } from 'playwright'

export const ucpathSelectors = {
  smartHR: {
    templateInput: (f: FrameLocator) => f
      .getByRole('textbox', { name: 'Select Template' })
      .or(f.locator('#PT_SEARCH_WRK_PT_SEARCH_TEMPLATE')),  // verified 2026-04-14
    effectiveDate: (f: FrameLocator) => f
      .getByRole('textbox', { name: 'Effective Date' })
      .or(f.getByLabel('Effective Date')),
  },
  personalData: {
    firstName: (f: FrameLocator) => f.getByRole('textbox', { name: 'First Name' }),
    // ...
  },
}
```

Consumers: `ucpathSelectors.smartHR.templateInput(frame).fill(templateId)`.

**Shape 2: Data-only descriptors resolved by a runtime helper**

```ts
export const UCPATH_SELECTORS = {
  'smartHR.templateInput': {
    primary: { role: 'textbox', name: 'Select Template' },
    fallbacks: [{ css: '#PT_SEARCH_WRK_PT_SEARCH_TEMPLATE' }],
    verified: '2026-04-14',
  },
  // ...
}

// Usage:
await resolveSelector(frame, UCPATH_SELECTORS['smartHR.templateInput']).fill(templateId)
```

Shape 1 is simpler and TypeScript-native. Shape 2 enables richer instrumentation (auto-logging which selector matched, versioning, potential external config). **Lean: Shape 1.** Reasoning: Shape 2's "selectors as data" has theoretical appeal but buys little in practice — we're not going to externalize selectors, and the added indirection hurts discoverability.

### Shared cross-system helpers

Patterns that recur across systems live in `src/systems/common/`:

- `dismissModal(page)` — dismisses PeopleSoft modal masks
- `waitForPeopleSoftProcessing(frame, timeout)` — already exists; stays
- Generic `safeClick`/`safeFill` wrappers that log when a fallback matches

### Instrumentation

A thin wrapper logs which selector branch matched when fallbacks are used:

```ts
async function click(locator: Locator, label: string): Promise<void> {
  try {
    await locator.click({ timeout: 5000 })
  } catch (err) {
    log.warn(`Selector fallback triggered for: ${label}`)
    throw err  // or retry — TBD
  }
}
```

When a fallback matches repeatedly in production, that's a signal the primary selector is stale and needs updating.

## Key decisions for brainstorm

1. **Shape 1 vs Shape 2** (functions returning locators vs data descriptors).
2. **Flat module or hierarchical** (`src/systems/ucpath/selectors.ts` vs `src/systems/ucpath/selectors/smartHR.ts` + `personalData.ts`).
3. **Abstract selector-lookup API** (`resolveSelector(frame, key)`) vs direct exports.
4. **Breakage detection** — should the system auto-emit a dashboard alert when all fallbacks fail across runs?
5. **Selector versioning** — track "last verified" dates. How do we remind ourselves to re-verify? Annual audit? Lint rule that flags selectors older than N months?
6. **Migration mechanics** — do we move selectors en masse per system, or opportunistically as each system gets touched?

## Scope

### In scope
- Move all inline selectors from `src/systems/<system>/*.ts` into `<system>/selectors.ts`
- Add `.or()` fallback chains where PeopleSoft grid IDs or similar brittle selectors exist
- Standardize cross-system patterns (modal dismiss, section navigation) into `src/systems/common/`
- Document verified dates and breakage patterns
- Update per-module CLAUDE.md files with "Verified Selectors" sections aligned to the new layout

### Out of scope
- Playwright page object model (POM) pattern — that's a heavier abstraction than needed
- External configuration (YAML/JSON) — keep selectors in TypeScript for type checking and refactor tool support
- UI-change detection via visual regression testing — separate concern
- Retries (belongs in kernel, not selector registry)

## Dependencies

- **Requires:** Subsystem B+E landed (because `src/systems/` must exist, and moving selectors touches migrated workflow code)
- **Blocks:** Nothing — D and C can run in parallel with A or after

## Risk and open questions

1. **Do we move selectors for all 6 systems in one sitting, or 1-2 per commit?** Big-bang moves produce huge diffs but avoid intermediate states. Per-system commits are reviewable but slow.
2. **How aggressive should fallback chains be?** 2-deep feels sensible; 5-deep is probably over-engineering. PeopleSoft specifically needs `role+name → label → css-id` (3-deep).
3. **Shared cross-system helpers** — where does "shared" end and "system-specific" begin? The `dismissModal` pattern is 80% identical across PeopleSoft-based sites (UCPath, old Kronos). Should those sites share a PeopleSoft base module?
4. **Selector observability** — if we add runtime logging of fallback matches, where does that signal surface? Dashboard? Separate report? GitHub issue auto-filed?

## Rough plan shape (for post-brainstorm)

Anticipated implementation plan — 8-10 tasks roughly:

1. Create shared helpers in `src/systems/common/` (modal dismiss, processing wait, selector logging wrapper)
2. For each system (6 total, 1 commit each): consolidate selectors into `selectors.ts`, add fallback chains, update imports
3. Update per-module CLAUDE.md with "Verified Selectors" sections
4. Add a lint rule (or test) that prevents new inline selectors in non-`selectors.ts` files
5. Tag `subsystem-a-selector-registry-complete`

## Unresolved tension with the kernel

The kernel's `detailFields` declaration hints that workflows want type-safe "what this workflow produces" metadata. Selectors are a parallel concept: "what this system exposes." Worth exploring whether they share an underlying pattern (declarative metadata per module) or stay independent. Lean: keep independent — conflating them is premature abstraction for n=2.
