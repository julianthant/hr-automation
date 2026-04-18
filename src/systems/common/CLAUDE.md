# systems/common — Shared Cross-System Helpers

Shared Playwright helpers used across multiple systems. Keep this layer
**minimal**: only move a helper here when >=2 systems call it. Most helpers
belong in the system that owns them, not in common.

## Files

- `modal.ts` — `dismissPeopleSoftModalMask(page)`: hides `#pt_modalMask`,
  the transparent overlay PeopleSoft leaves visible between tab switches.
  Used by UCPath transaction flow and emergency-contact. Legacy aliases
  `dismissModalMask` / `hidePeopleSoftModalMask` re-export this from
  `src/systems/ucpath/navigate.ts` and `personal-data.ts`.
- `safe.ts` — `safeClick(locator, { label })` and `safeFill(locator, value,
  { label })`: instrumented wrappers that log a
  `log.warn("selector fallback triggered: <label>")` when the underlying
  Playwright call throws (typically a `TimeoutError` from an exhausted
  `.or()` fallback chain). Best-effort — never stalls; re-throws the
  original error so callers still see the failure.
- `index.ts` — Barrel exports.

## Pattern

```typescript
import { safeClick } from "../common/index.js";
import { ucpathSelectors } from "./selectors.js";

await safeClick(
  ucpathSelectors.jobData.compRateCodeInput(frame),
  { label: "ucpath.jobData.compRateCodeInput" },
);
```

When the underlying `.click()` throws (primary and all fallbacks exhausted),
you'll see `! selector fallback triggered: ucpath.jobData.compRateCodeInput`
in the log stream. That's the signal the anchor has rotted and needs a live
re-mapping via playwright-cli.

## Why not more?

Helpers that look like good candidates for `common/` but stay in their
system:

- **`waitForPeopleSoftProcessing`** — PeopleSoft-specific (`#processing`,
  `#WAIT_win0`, `.ps_box-processing`). Only UCPath uses it. Lives in
  `src/systems/ucpath/navigate.ts`.
- **Old Kronos `dismissModal(page, iframe)`** — clicks iframe OK/Close
  buttons; different semantics from `dismissPeopleSoftModalMask` (which
  hides a CSS overlay). Lives in `src/systems/old-kronos/navigate.ts`.

## Before mapping a new selector

This module owns shared helpers (modal dismiss, `safeClick`/`safeFill`), not
per-page selectors. New page-anchored selectors belong in the per-system
registries:

- [`src/systems/crm/SELECTORS.md`](../crm/SELECTORS.md) · [`LESSONS.md`](../crm/LESSONS.md)
- [`src/systems/i9/SELECTORS.md`](../i9/SELECTORS.md) · [`LESSONS.md`](../i9/LESSONS.md)
- [`src/systems/kuali/SELECTORS.md`](../kuali/SELECTORS.md) · [`LESSONS.md`](../kuali/LESSONS.md)
- [`src/systems/new-kronos/SELECTORS.md`](../new-kronos/SELECTORS.md) · [`LESSONS.md`](../new-kronos/LESSONS.md)
- [`src/systems/old-kronos/SELECTORS.md`](../old-kronos/SELECTORS.md) · [`LESSONS.md`](../old-kronos/LESSONS.md)
- [`src/systems/ucpath/SELECTORS.md`](../ucpath/SELECTORS.md) · [`LESSONS.md`](../ucpath/LESSONS.md)

Before mapping anything new, always run `npm run selector:search "<intent>"`
to scan the existing catalogs. The CLI ranks both selectors and lessons.

## Lessons Learned

*(empty — add entries as common helpers grow)*
