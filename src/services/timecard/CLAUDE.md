# services/timecard — Shared Timecard Helpers

Shared, system-agnostic timecard logic used by both Old Kronos (UKG) and
New Kronos (WFD/Dayforce) drivers.

## Exports

- `formatTimecardDate(month, day, range)` — formats a 1-based month and day
  as "MM/DD/YYYY", resolving the YEAR against the required
  `TimecardDateRange` (`{ start, end }`, inclusive, day granularity): the
  candidate years `start.getFullYear()..end.getFullYear()` are enumerated and
  the one whose composed date falls inside the range wins. **Fail loud, no
  default**: throws on an impossible month/day (2/30, non-leap 2/29,
  out-of-bounds numbers), on zero candidates (the day can't belong to the
  window), and on ≥2 candidates (a >1-year window is ambiguous). The old
  optional `referenceDate = new Date()` third parameter is retired — see the
  2026-07-16 lesson.
- `TimecardDateRange` — the inclusive `{ start: Date; end: Date }` window.
- `timecardCheckWindows(now?)` — retained compatibility helper for callers that
  need conservative bounds; `runTimecardCheck` no longer uses it as an
  authoritative grid range.
- `TimecardDriver` — interface each Kronos driver implements to plug into the
  shared orchestration. `readVisibleMonthDays(page)` returns the actual first
  and last rendered dates; `readLastDate(page, range)` receives their resolved
  exact range.
- `runTimecardCheck(page, driver, now?)` — orchestrates navigate → check
  current → switch to previous → re-check. It resolves the current visible
  bounds around `now`, then resolves the previous visible bounds relative to
  that verified current period. Returns the latest "MM/DD/YYYY" date with time
  entries, or null.
- `didPeriodLabelSwitch(before, after, currentLabelPattern?)` — positive
  "did the displayed pay-period label actually change" check. **BOTH** labels
  must be non-blank (whitespace-only counts as blank) and different
  (case/whitespace-insensitive); a blank BEFORE means the baseline was never
  read, so the switch cannot be verified → `false`, never "assume it
  switched". When `currentLabelPattern` is supplied, `after` must also not
  still match it (New Kronos uses this to catch a dropdown that closed while
  the button still literally reads "Current Pay Period"). All three call
  sites (Old Kronos `switchToPreviousPayPeriod`, New Kronos
  `switchToPreviousPayPeriod` + `setDateRange`) throw on `false`, with the
  blank-baseline case named separately in the message — see the 2026-07-08
  lesson below.

## Design

The DOM evaluation (parsing timecard rows and its first/last visible dates)
stays in each driver — it is system-specific. The shared code owns year-safe
range resolution and the current/previous orchestration loop.
The raw-parse→date resolution for the separations read path is the pure
`resolveSeparationTimecardDates` in `src/systems/new-kronos/navigate.ts`
(unit-testable without a page).

The driver shape uses two separate hooks (`afterGoTo` and `afterSwitch`)
instead of a single `afterNavigate` so that screenshot labels can differ
between the initial navigation and the period-switch.

`runTimecardCheck` inserts a `page.waitForTimeout(3_000)` settle wait after
both `goToTimecard` and `switchPeriod`. Driver hooks must NOT add their own
additional wait — that would double the delay to 6s.

## Callers

- `src/systems/old-kronos/navigate.ts` — `getTimecardLastDate` + `checkTimecardDates`
- `src/systems/new-kronos/navigate.ts` — `getTimecardLastDate` + `checkTimecardDates`
  + `getSeparationTimecardData(page, range)` (the PRODUCTION separations read
  path; its range comes from the same `kronosStart`/`kronosEnd` strings passed
  to `setDateRange`, parsed via `mmddyyyyToDate`)
- `src/scripts/debug/kronos.ts` — `checkTimecardDates` on both systems (dev tool)

## Lessons Learned

- **2026-07-16: `formatTimecardDate` resolves the year against a REQUIRED range, and generic checks now derive that range from the ACTUAL rendered rows.** The optional `referenceDate` default silently reintroduced the Dec→Jan bug, and replacing it with broad `timecardCheckWindows(now)` still treated an estimate as the displayed period. Each driver now reports its first/last visible month-day; `resolveCurrentVisibleTimecardRange` requires that range to contain `now`, and `resolvePreviousVisibleTimecardRange` requires it to precede the already verified current range. Separations continues to pass the exact custom range it requested. Impossible dates, zero/ambiguous candidates, and invalid Date endpoints throw. Pinned by `tests/unit/services/timecard/index.test.ts` and `tests/unit/systems/new-kronos/navigate.test.ts`.
- **2026-07-08 (live-verified 2026-07-16): A dropdown/option "hidden" wait is not proof the period actually switched.** `didPeriodLabelSwitch` requires readable, different before/after labels; a blank baseline is a verification failure. Old Kronos's `#timeframe-selector-input` was live-verified changing from "Current Pay Period" to "Previous Pay Period" while the rows changed from 7/05–7/18 to 6/21–7/04. New Kronos uses its verified pay-period trigger. Pinned by `tests/unit/services/timecard/index.test.ts`.
- **2026-05-16 (superseded 2026-07-16): Dec→Jan year-stamp bug first patched with an optional `referenceDate`.** Both Kronos drivers used `new Date().getFullYear()` inline inside `page.evaluate` / `f.evaluate`, stamping January's year onto a December timecard date when the workflow ran after midnight on Jan 1. The first fix moved the year stamp into `formatTimecardDate(month, day, referenceDate = new Date())` — but the optional default meant callers that omitted it (all of them) kept the bug. Superseded by the required-range resolution above.
