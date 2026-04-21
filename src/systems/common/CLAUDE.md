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
  { label })`: instrumented wrappers around Playwright's click/fill. Three
  tiers of instrumentation, gated on call latency:
    - **quick success** (≤ 3s) — `log.debug("<label>: clicked in Nms")`
      (only surfaces on stdout when `DEBUG=true`; always written to JSONL
      when a log context is active).
    - **slow success** (> 3s) — `log.warn("selector fallback triggered:
      <label> (click took Nms — likely fallback-hit or page stall)")`.
      Inferred fallback-hit: Playwright's `.or()` doesn't surface which
      branch matched, so we use elapsed time as a proxy. The wording is
      hedged because a plain slow page load can also push latency past 3s
      without any fallback involvement.
    - **failure** — `log.error("selector fallback triggered: <label>
      (click failed after Nms — <error message>)")` then re-throws the
      original error. Shares the `selector fallback triggered:` marker
      with the warn case so the dashboard's Selector Health Panel
      aggregates both on `<label>`.
  The 3_000ms threshold is overridable via a `_slowThresholdMs` option
  (underscore-prefixed = test-only escape hatch).
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
- [`src/systems/ucpath/SELECTORS.md`](../ucpath/SELECTORS.md) · [`LESSONS.md`](../ucpath/LESSONS.md)

Before mapping anything new, always run `npm run selector:search "<intent>"`
to scan the existing catalogs. The CLI ranks both selectors and lessons.

## Lessons Learned

### 2026-04-21 — `safeClick`/`safeFill` log contract changed (Task 2.1)

Before: single `log.warn("selector fallback triggered: <label>")` only on
throw. After: three-tier timing-based instrumentation (quick-success →
debug, slow-success → warn, failure → error), all three failure/slow
branches sharing the `selector fallback triggered: <label>` anchor.

Paired change: the Selector Health Panel regex in `src/tracker/dashboard.ts`
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
