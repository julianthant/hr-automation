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
- [`src/systems/onbase/SELECTORS.md`](../onbase/SELECTORS.md) · [`LESSONS.md`](../onbase/LESSONS.md)
- [`src/systems/servicenow/SELECTORS.md`](../servicenow/SELECTORS.md) · [`LESSONS.md`](../servicenow/LESSONS.md)
- [`src/systems/sharepoint/SELECTORS.md`](../sharepoint/SELECTORS.md) · [`LESSONS.md`](../sharepoint/LESSONS.md)
- [`src/systems/ucpath/SELECTORS.md`](../ucpath/SELECTORS.md) · [`LESSONS.md`](../ucpath/LESSONS.md)

Before mapping anything new, always run `npm run selector:search "<intent>"`
to scan the existing catalogs. The CLI ranks both selectors and lessons.

## Pre-submit identity gate (`assertDisplayedIdentity`)

`identity.ts` is the shared primitive for confirming the page displays the RIGHT
person/subject before an irreversible Save / Submit / Import. Use it instead of
hand-rolling a per-workflow EID/id check.

- **Pure core** `checkDisplayedIdentity(expected, displayed, opts)` → `{ ok, shown }`.
  `mode: "word-boundary"` (default) matches `\bexpected\b` inside a header/blob and,
  on a miss, reports a competing 8-digit id (override via `competingIdPattern`);
  `mode: "exact"` requires the trimmed field value to equal `expected` and reports
  the whole displayed value. Throws on an empty `expected` (a gate with no expected
  value can never be real).
- **Async gate** `assertDisplayedIdentity({ expected, extract, context, mode?, pollMs? })`
  calls the `extract` closure (Playwright-agnostic), compares, and **throws a legible
  EXPECTED-vs-DISPLAYED error** on a mismatch. Fail-loud contract: an `extract` throw
  is INCONCLUSIVE → throws (never passes); an empty displayed value → throws; optional
  `pollMs` re-reads while the page is still switching subjects (batch reuse).

**Adoption recipe:** pick the page's OWN identity element (never whole-page text that
a lingering search box can pollute), write a small `extract` reading it, call the gate
right before the irreversible step. Wired today:
- **New Kronos** — `peopleHeaderShowsEid` / `probeEidInTimecardText` delegate to the pure
  core (`.empName` header / timecard text). *TODO(live-verify): scope the timecard read
  to a pinpoint WFD employee-header selector once a found-employee timecard is mappable.*
- **OnBase** — after the Employee Lookup keyset autofills, `exact`-match the "UCPath ID"
  keyword before Import (`workflows/onbase/handler.ts`).
- **Emergency Contact** — `word-boundary`-match the "Person ID <emplId>" header
  (`readEmergencyContactPersonIdRow`) before demote/add (`workflows/emergency-contact/`).
- **Oath Signature** — deferred (`TODO(live-verify)` in `enter.ts`): the profile is reached
  by an exact unique-EID search and `crm-verify` already confirms the EID, so a gate needs
  a live-mapped Person-Profile EID display selector before it can be wired safely.

## Lessons Learned

### 2026-07-08 — `assertDisplayedIdentity` extracted as the shared identity gate

The wrong-person guard (`verifyPeopleEmployee` / `verifyTimecardEmployee`) was
per-workflow copy-paste — one `\b<eid>\b` regex here, one `document.body.innerText`
probe there — so each new file-a-document flow risked shipping without any gate.
Extracted into `identity.ts` (pure `checkDisplayedIdentity` + async
`assertDisplayedIdentity`); New Kronos now delegates to it, and OnBase +
Emergency Contact adopted it before Import/demote. **Rule:** every workflow that
Saves/Submits/Imports against a subject reached via search/keyset/nav must gate
on the page's OWN identity element through this primitive before the irreversible
step — fail loud on a mismatch or an inconclusive read, never proceed. See the
"Pre-submit identity gate" section above for the recipe.

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
