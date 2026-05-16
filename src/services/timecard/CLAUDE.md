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

- **2026-05-16: Dec→Jan year-stamp bug fixed.** Both Kronos drivers used
  `new Date().getFullYear()` inline inside `page.evaluate` or `f.evaluate`.
  This stamps January's year onto a December timecard date when the workflow
  runs after midnight on Jan 1. Fix: evaluate returns `{month, day}` numbers;
  `formatTimecardDate` accepts `referenceDate` and defaults to `new Date()`.
  Callers that know the canonical reference date (e.g. from a prior workflow
  step) should pass it explicitly.
