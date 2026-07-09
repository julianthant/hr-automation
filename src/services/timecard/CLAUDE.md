# services/timecard — Shared Timecard Helpers

Shared, system-agnostic timecard logic used by both Old Kronos (UKG) and
New Kronos (WFD/Dayforce) drivers.

## Exports

- `formatTimecardDate(month, day, referenceDate?)` — formats a 1-based month
  and day as "MM/DD/YYYY". Accepts an optional `referenceDate` to fix the
  Dec→Jan year-stamp bug (without it, `new Date().getFullYear()` stamps the
  wrong year on December rows when the workflow runs in January).
- `TimecardDriver` — interface each Kronos driver implements to plug into the
  shared orchestration.
- `runTimecardCheck(page, driver)` — orchestrates navigate → check current →
  switch to previous → re-check. Returns the latest "MM/DD/YYYY" date with
  time entries, or null.
- `didPeriodLabelSwitch(before, after, currentLabelPattern?)` — positive
  "did the displayed pay-period label actually change" check. `after` must be
  non-blank and different from `before` (case/whitespace-insensitive); when
  `currentLabelPattern` is supplied, `after` must also not still match it
  (New Kronos uses this to catch a dropdown that closed while the button still
  literally reads "Current Pay Period"). Both drivers' period-switch code
  calls this right after their dropdown-close wait and throws on `false` —
  see the 2026-07-08 lesson below.

## Design

The DOM evaluation (parsing timecard rows) stays in each driver's
`readLastDate` implementation — it is system-specific. The shared code owns
only the year-safe formatting and the current/previous orchestration loop.

The driver shape uses two separate hooks (`afterGoTo` and `afterSwitch`)
instead of a single `afterNavigate` so that screenshot labels can differ
between the initial navigation and the period-switch.

`runTimecardCheck` inserts a `page.waitForTimeout(3_000)` settle wait after
both `goToTimecard` and `switchPeriod`. Driver hooks must NOT add their own
additional wait — that would double the delay to 6s.

## Callers

- `src/systems/old-kronos/navigate.ts` — `getTimecardLastDate` + `checkTimecardDates`
- `src/systems/new-kronos/navigate.ts` — `getTimecardLastDate` + `checkTimecardDates`

## Lessons Learned

- **2026-07-08: A dropdown/option "hidden" wait is not proof the period actually switched — added a positive label-readback assert.** Both `switchToPreviousPayPeriod` implementations (Old Kronos: `#timeframe-selector-input`; New Kronos: `timecard.payPeriodTriggerButton`) close their dropdown as soon as the click registers and treated that as "switched", but a dropdown/option detaching only proves the click landed — not that the grid actually moved to the previous period. New Kronos's custom-range `setDateRange` (the path `getSeparationTimecardData` reads through for separations) had the same gap: `setRangeDate`'s readback only proves the DIALOG fields accepted the ISO dates, not that the grid re-rendered for that range. Fix: `didPeriodLabelSwitch` compares the period label read immediately before the switch/Apply to the label read immediately after, and all three call sites now `throw` (fail loud) on a mismatch instead of returning as if the switch succeeded. Old Kronos's `#timeframe-selector-input` readback is flagged `// TODO(live-verify)` in `selectors.ts` — its displayed-value semantics before/after a switch haven't been confirmed against a live page; New Kronos's `payPeriodTriggerButton` readback uses an already-verified (2026-06-18) selector. Pinned by `tests/unit/services/timecard/index.test.ts`.
- **2026-05-16: Dec→Jan year-stamp bug fixed.** Both Kronos drivers used
  `new Date().getFullYear()` inline inside `page.evaluate` or `f.evaluate`.
  This stamps January's year onto a December timecard date when the workflow
  runs after midnight on Jan 1. Fix: evaluate returns `{month, day}` numbers;
  `formatTimecardDate` accepts `referenceDate` and defaults to `new Date()`.
  Callers that know the canonical reference date (e.g. from a prior workflow
  step) should pass it explicitly.
