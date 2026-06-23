# systems/common — Shared Cross-System Helpers

Shared Playwright helpers used across multiple systems. Keep this layer
**minimal**: only move a helper here when >=2 systems call it. Most helpers
belong in the system that owns them, not in common.

## Pattern

```typescript
// From any `src/systems/<system>/` module (not `common/` — there is no `./selectors.js` here).
import { safeClick } from "../common/index.js";
import { ucpathSelectors } from "../ucpath/selectors.js";

await safeClick(
  ucpathSelectors.jobData.compRateCodeInput(frame),
  { label: "ucpath.jobData.compRateCodeInput" },
);
```

## Selector and driver conventions

System modules own browser interaction. Keep selectors in per-system `selectors.ts`, prefer registry locators with `safeClick`/`safeFill`, and do not move Playwright selectors into workflow folders.

Example log lines you'll see in practice:

```
·  ucpath.jobData.compRateCodeInput: clicked in 87ms
!  selector fallback triggered: ucpath.jobData.compRateCodeInput (click took 3421ms — likely fallback-hit or page stall)
✗  selector fallback triggered: ucpath.jobData.compRateCodeInput (click failed after 10000ms — TimeoutError: locator.click timed out)
```

The second and third are the re-mapping signals: primary anchor is either
slow enough that a fallback branch likely won, or the primary + all
fallbacks are stale. Trigger a live re-mapping via playwright-cli when you
see these accumulating in the dashboard's Selector Health Panel.

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
- [`src/systems/servicenow/SELECTORS.md`](../servicenow/SELECTORS.md) · [`LESSONS.md`](../servicenow/LESSONS.md)
- [`src/systems/sharepoint/SELECTORS.md`](../sharepoint/SELECTORS.md) · [`LESSONS.md`](../sharepoint/LESSONS.md)
- [`src/systems/ucpath/SELECTORS.md`](../ucpath/SELECTORS.md) · [`LESSONS.md`](../ucpath/LESSONS.md)

Before mapping anything new, always run `npm run selector:search "<intent>"`
to scan the existing catalogs. The CLI ranks both selectors and lessons.

## Lessons Learned

### 2026-04-21 — `safeClick`/`safeFill` log contract changed (Task 2.1)

Before: single `log.warn("selector fallback triggered: <label>")` only on
throw. After: three-tier timing-based instrumentation (quick-success →
debug, slow-success → warn, failure → error), all three failure/slow
branches sharing the `selector fallback triggered: <label>` anchor.

Paired change: the Selector Health Panel regex in `src/tracker/dashboard/selector-warnings.ts`
(`SELECTOR_FALLBACK_RE`) was updated to stop the capture at the first `(`
so label aggregation is stable across legacy (no suffix), slow-success
(`(click took Nms — ...)`), and failure (`(click failed after Nms — ...)`)
shapes. The handler also now accepts `level === "error"` alongside
`level === "warn"` — otherwise the most valuable signal (primary + all
fallbacks stale) would not feed the panel.

If you change the message shape in `safe.ts` again, keep these three
invariants:

1. The literal string `selector fallback triggered: <label>` must be the
   prefix (with `<label>` unbroken — no spaces inside, no prefix tokens)
   on every dashboard-visible branch.
2. Anything after `<label>` must start with ` (` so the dashboard regex
   captures cleanly.
3. The log `level` must be `warn` (slow-success) or `error` (failure).
