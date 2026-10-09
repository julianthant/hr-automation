# Separation Date from timecard (not Kuali-authoritative) — design

**Date:** 2026-06-22
**Status:** approved (operator-confirmed via brainstorming Q&A)
**Area:** `src/workflows/separations`

## Problem

The dashboard log line

```
Separation Date = 06/11/2026 (Kuali authoritative — never overridden)
```

is wrong. The current model (reworked 2026-06-18) treats Kuali's `separationDate`
as authoritative and never overrides it. Per the operator, the real business rule
is:

> The separation date is usually the same as the last day worked, unless the
> employee has sick hours or holiday pay.

So Kuali's separation date should not be trusted verbatim — it must be derived
from the New Kronos timecard.

## Rule (operator-confirmed)

**Separation Date = the last day the employee was paid for** — worked OR on paid
leave:

```
separationDate = max( lastDayWorked, last sick date, last holiday date )
```

where `lastDayWorked` is the already-reconciled Last Day Worked (New Kronos last
physical punch, falling back to Kuali's LDW when Kronos has no punch / was
skipped).

- **No sick/holiday leave** → the max collapses to `lastDayWorked`, i.e.
  separation date = last day worked.
- **Sick and/or holiday leave present** → separation date moves forward to the
  latest leave date (the last day paid).
- **No Kronos data at all** (no punch, kronos-search skipped — edit-and-resume
  prefill / "Transactions only") → `lastDayWorked` already falls back to Kuali's
  **Last Day Worked**, and with no leave dates the separation date equals that.
  (Confirmed: fall back to Kuali's *Last Day Worked*, not Kuali's separation
  date.)

**Termination Effective Date = Separation Date + 1 day** — recomputed from the
*reconciled* separation date (previously computed from Kuali's separation date).

**Write-back:** when the computed separation date differs from what Kuali had,
write it back into the Kuali Separation Date field (mirrors the existing LDW
write-back), with an audit comment in the Timekeeper/Approver Comments field.

## Changes

### `schema.ts`
- Add `computeSeparationDate(lastDayWorked, sickDates, holidayDates)` → latest
  MM/DD/YYYY among LDW + all sick + all holiday dates (seeded on LDW).
- Add `buildSeparationDateChangeComment(originalSepDate, newSepDate, initials)` →
  `Updated Separation Date from <a> to <b> per Kronos timesheet. -<II>`; empty
  string when unchanged. (`buildDateChangeComments` stays LDW-only.)

### `workflow.ts`
- After date reconciliation, compute
  `separationDate = computeSeparationDate(lastDayWorked, timecard.sickDates, timecard.holidayDates)`,
  `separationDateChanged = separationDate !== kualiData.separationDate`, and
  recompute `termEffDate = computeTerminationEffDate(separationDate)`.
- The early extraction-log term-eff value becomes `kualiTermEffDate` (Kuali's
  claimed sep date + 1) so the two `const`s don't collide; the post-reconciliation
  `termEffDate` is the one that flows to comments / finalization / dashboard.
- Replace the "Kuali authoritative — never overridden" log with one that states
  how the date was derived (LDW vs leave-extended).
- In the live write-back block, call `updateSeparationDate(kualiPage, separationDate)`
  when `separationDateChanged`, alongside the existing LDW write-back.
- Pass `separationDateChanged` to `runKualiFinalize`.

### `kuali-finalize.ts`
- Add `separationDateChanged` to `KualiFinalizationArgs`; build the combined
  date-change comment from the LDW change + the separation-date change.

### Tests
- `schema.test.ts`: cover `computeSeparationDate` (no-leave → LDW; sick-range;
  single holiday; both; fallback when LDW is the only date) and
  `buildSeparationDateChangeComment`.
- `dry-run.test.ts`: update the assertions that pin `separationDate = Kuali's`.
  With the default fixture (LDW 01/15, Kuali sep 01/16, no Kronos punch/leave),
  the new separation date = **01/15/2026** (fallback to Kuali LDW) and
  term-eff = **01/16/2026**; the punch-override case (LDW 01/20, no leave) →
  separation date = **01/20/2026**.

### Docs
- Update `src/workflows/separations/CLAUDE.md` "Date model" + a LESSONS entry.

## Out of scope
- UCPath "Last Date Worked" field/override checkbox (still deferred — no selector).
