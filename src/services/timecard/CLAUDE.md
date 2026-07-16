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
- `timecardCheckWindows(now?)` — the conservative windows `runTimecardCheck`
  derives from "now": current period ≈ `[now−60d, now+7d]`, previous ≈
  `[now−120d, now+7d]`. Each is well under ~330 days, so any month/day
  resolves to exactly one year inside it.
- `TimecardDriver` — interface each Kronos driver implements to plug into the
  shared orchestration. `readLastDate(page, range)` receives the window for
  the period being read.
- `runTimecardCheck(page, driver, now?)` — orchestrates navigate → check
  current → switch to previous → re-check, passing `timecardCheckWindows(now)`
  `.current` / `.previous` to the respective `readLastDate` calls. Returns the
  latest "MM/DD/YYYY" date with time entries, or null.
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

The DOM evaluation (parsing timecard rows) stays in each driver's
`readLastDate` implementation — it is system-specific. The shared code owns
only the year-safe formatting and the current/previous orchestration loop.
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

- **2026-07-16: `formatTimecardDate` resolves the year against a REQUIRED range — the optional `referenceDate` default silently reintroduced the Dec→Jan bug.** The 2026-05-16 fix (below) made the reference date an optional third parameter defaulting to `new Date()`; ALL FIVE call sites omitted it, so every timecard date was still stamped with "now"'s year — a December row read in January got January's year, exactly the bug the parameter existed to fix. An optional fail-safe parameter that every caller omits is no fix at all. Now the signature is `formatTimecardDate(month, day, range)` with NO default: the caller states the window the timecard view is showing (separations passes the `setDateRange` window; `runTimecardCheck` derives `timecardCheckWindows(now)`), and the unique candidate year inside it wins — zero or ≥2 candidates, or an impossible month/day (JS `Date` rollover like 2/30), THROW. Pinned by the matrix in `tests/unit/services/timecard/index.test.ts` + `resolveSeparationTimecardDates` cases in `tests/unit/systems/new-kronos/navigate.test.ts`.
- **2026-07-08 (amended 2026-07-16): A dropdown/option "hidden" wait is not proof the period actually switched — added a positive label-readback assert; a BLANK baseline is a verification failure, not a pass.** Both `switchToPreviousPayPeriod` implementations (Old Kronos: `#timeframe-selector-input`; New Kronos: `timecard.payPeriodTriggerButton`) close their dropdown as soon as the click registers and treated that as "switched", but a dropdown/option detaching only proves the click landed — not that the grid actually moved to the previous period. New Kronos's custom-range `setDateRange` (the path `getSeparationTimecardData` reads through for separations) had the same gap: `setRangeDate`'s readback only proves the DIALOG fields accepted the ISO dates, not that the grid re-rendered for that range. Fix: `didPeriodLabelSwitch` compares the period label read immediately before the switch/Apply to the label read immediately after, and all three call sites `throw` (fail loud) on a mismatch instead of returning as if the switch succeeded. **2026-07-16 amendment:** the original predicate accepted a BLANK before-label (all three callers read the baseline with `.catch(() => "")`, so a failed baseline read made ANY non-blank after-label look like a successful switch). Both labels must now be readable AND different; the three throw messages name the unreadable-baseline case explicitly. Old Kronos's `#timeframe-selector-input` readback is flagged `// TODO(live-verify)` in `selectors.ts` — its displayed-value semantics before/after a switch haven't been confirmed against a live page; New Kronos's `payPeriodTriggerButton` readback uses an already-verified (2026-06-18) selector. Pinned by `tests/unit/services/timecard/index.test.ts`.
- **2026-05-16 (superseded 2026-07-16): Dec→Jan year-stamp bug first patched with an optional `referenceDate`.** Both Kronos drivers used `new Date().getFullYear()` inline inside `page.evaluate` / `f.evaluate`, stamping January's year onto a December timecard date when the workflow ran after midnight on Jan 1. The first fix moved the year stamp into `formatTimecardDate(month, day, referenceDate = new Date())` — but the optional default meant callers that omitted it (all of them) kept the bug. Superseded by the required-range resolution above.
