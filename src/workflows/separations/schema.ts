import { z } from "zod/v4";
import { formatMmDdYyyy, todayMmDdYyyy } from "../../domain/dates.js";

// Re-exported so existing importers (workflow.ts, tests) keep their public API;
// the implementation now lives in the shared domain layer.
export { todayMmDdYyyy };

/** Validated separation data extracted from Kuali + UCPath. */
export const SeparationDataSchema = z.object({
  // From Kuali
  docId: z.string().min(1),
  employeeName: z.string().min(1),
  eid: z.string().regex(/^\d{5,}$/, "EID must be 5+ digits"),
  lastDayWorked: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, "Must be MM/DD/YYYY"),
  separationDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, "Must be MM/DD/YYYY"),
  terminationType: z.string().min(1),
  location: z.string().optional(),

  // Computed
  isVoluntary: z.boolean().optional(),
  terminationEffDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, "Must be MM/DD/YYYY"),
  // The generated UCPath termination comment (incl. any sick/holiday clause).
  // Stamped on the dry-run terminal (preview) AND the final live snapshot so the
  // operator can verify the exact comment before any real termination.
  separationComment: z.string().optional(),

  // From UCPath Workforce Job Summary
  deptId: z.string().optional(),
  departmentDescription: z.string().optional(),
  jobCode: z.string().optional(),
  jobDescription: z.string().optional(),

  // From Kronos search
  foundInNewKronos: z.boolean().optional(),

  // From UCPath transaction
  transactionNumber: z.string().optional(),
});

export type SeparationData = z.infer<typeof SeparationDataSchema>;

/**
 * Compute the termination effective date (separation date + 1 day).
 */
export function computeTerminationEffDate(separationDate: string): string {
  const date = parseDate(separationDate);
  date.setDate(date.getDate() + 1);
  return formatMmDdYyyy(date);
}

/**
 * Compute the Separation Date from the New Kronos timecard.
 *
 * Separation Date = the last day the employee was PAID for — worked OR on paid
 * leave = `max(lastDayWorked, last sick date, last holiday date)`. With no
 * sick/holiday leave the result collapses to `lastDayWorked` ("usually the same
 * as the last day worked"); leave moves it forward to the latest leave date.
 *
 * `lastDayWorked` is the already-reconciled Last Day Worked (New Kronos last
 * physical punch, falling back to Kuali's LDW when Kronos has no punch / was
 * skipped), so the no-Kronos path naturally yields the Kuali Last Day Worked.
 *
 * All dates are MM/DD/YYYY. The result is never earlier than `lastDayWorked`
 * (it seeds the max), so a stray earlier leave date can't pull it backwards.
 */
export function computeSeparationDate(
  lastDayWorked: string,
  sickDates: string[] = [],
  holidayDates: string[] = [],
): string {
  let latest = lastDayWorked;
  let latestTime = parseDate(lastDayWorked).getTime();
  for (const d of [...sickDates, ...holidayDates]) {
    const t = parseDate(d).getTime();
    if (t > latestTime) {
      latest = d;
      latestTime = t;
    }
  }
  return latest;
}

/**
 * Build the comments text for the UCPath termination transaction.
 *
 * Base form: `Termination eff <eff>. Last Day Worked <ldw>.` then, when present,
 * a SINGLE leave clause (sick OR holiday — see below), then ` Kuali form #<docId>.`.
 * `<ldw>` is the physical Last Day Worked, NOT the separation date — sick leave and
 * holiday pay push out the SEPARATION date (and thus the termination eff date),
 * never the Last Day Worked. The sick/holiday dates come from the New Kronos
 * separation timecard (`SeparationTimecardData`); the separation-date extension
 * itself is done by `computeSeparationDate`, this builder only reports the
 * separation-determining leave day.
 *
 * Leave clause (dates are MM/DD/YYYY, chronological):
 *   - Only ONE clause is ever emitted. When BOTH sick leave and holiday pay are
 *     present, only the LATEST one is reported (the leave day that actually
 *     determines the separation date) — never both. Holiday wins only when its
 *     latest date is strictly later than the latest sick date; sick wins ties.
 *   - Sick (any count): ` Sick Leave on <latest>.` — the latest sick date only,
 *     never a range. The separation date already extends to the latest sick day
 *     (see `computeSeparationDate`); the comment reports that single relevant day.
 *   - Holiday: 1 → ` Holiday Pay on <d>.`; ≥2 → ` Holiday Pay from <first> to <last>.`
 */
export function buildTerminationComments(
  terminationEffDate: string,
  lastDayWorked: string,
  docId: string,
  leave?: { sickDates?: string[]; holidayDates?: string[] },
): string {
  const sickDates = leave?.sickDates ?? [];
  const holidayDates = leave?.holidayDates ?? [];

  const latestSick = sickDates.length >= 1 ? sickDates[sickDates.length - 1] : null;
  const latestHoliday = holidayDates.length >= 1 ? holidayDates[holidayDates.length - 1] : null;

  const sickClause = latestSick ? ` Sick Leave on ${latestSick}.` : "";

  let holidayClause = "";
  if (holidayDates.length === 1) {
    holidayClause = ` Holiday Pay on ${holidayDates[0]}.`;
  } else if (holidayDates.length >= 2) {
    holidayClause = ` Holiday Pay from ${holidayDates[0]} to ${holidayDates[holidayDates.length - 1]}.`;
  }

  // Only ONE leave clause is reported. With BOTH sick leave and holiday pay, keep
  // only the LATEST one — it is the leave day that sets the separation date
  // (= max(LDW, last sick, last holiday)); emitting both would double-report the
  // same separation-determining event. Holiday wins only on a strictly later date
  // (sick wins ties — the two can't legitimately fall on the same day).
  let leaveClause: string;
  if (latestSick && latestHoliday) {
    leaveClause =
      parseDate(latestHoliday).getTime() > parseDate(latestSick).getTime()
        ? holidayClause
        : sickClause;
  } else {
    leaveClause = sickClause || holidayClause;
  }

  return (
    `Termination eff ${terminationEffDate}. Last Day Worked ${lastDayWorked}.` +
    leaveClause +
    ` Kuali form #${docId}.`
  );
}

/**
 * Kuali termination type → UCPath Reason Code mapping.
 *
 * UCPath VOL_TERM reason codes (from live selector discovery):
 *   Career to Per Diem, Interlocation (BU) Transfer,
 *   Release fr Trial Emplmnt-Vol, Resign - Accept Another Job,
 *   Resign - Attend School, Resign - Dissatisfied w/ Job,
 *   Resign - Job Abandonment, Resign - Look For Another Job,
 *   Resign - Military Service, Resign - Moved out of Area,
 *   Resign - No Reason Given, Resign - Personal Reasons,
 *   Resign - Quit Without Notice, Resign - Self Employment,
 *   Resign -Failed to Ret fr Leave, Transfer - Intra Location,
 *   Voluntary Separation Program
 *
 * UCPath INVOL_TERM reason codes (verified via playwright-cli 2026-04-09):
 *   Acad- Incompetent Performance, Acad- Presumptive Resignation,
 *   Acad- Terminal Appointment, Appointment Expired, Death,
 *   Dismissal - Attendance, Dismissal - Falsified App,
 *   Dismissal - Misconduct, Dismissal - No Longer Cert/Lic,
 *   Dismissal -Lack of Performance, Do Not Protest (Settlement),
 *   Do Not Rehire (Settlement), Elimination of Position,
 *   Grant/Contract expired, Involuntary Termination -Other,
 *   Layoff - Accept Health Care, Layoff- Rehire/Recall Rights,
 *   Layoff- Severance, Layoff-Reduced Sev, Reh/Recall,
 *   Medical Separation, Never Started Employment, No Longer Student,
 *   Per Diem Release, Release fr Trial Emplmnt-Invol,
 *   Released During Probation, Visa/Work Permit Expired
 */
const REASON_CODE_MAP: Record<string, string> = {
  // ─── Voluntary (UC_VOL_TERM) ───
  "Accepted Another Job": "Resign - Accept Another Job",
  "Attend School": "Resign - Attend School",
  "Dissatisfied w/Job": "Resign - Dissatisfied w/ Job",
  "Look for Another Job": "Resign - Look For Another Job",
  "Military Service": "Resign - Military Service",
  "Move out of Area": "Resign - Moved out of Area",
  "No Reason Given": "Resign - No Reason Given",
  "Personal Reasons": "Resign - Personal Reasons",
  "Quit without Notice": "Resign - Quit Without Notice",
  "Self-Employment": "Resign - Self Employment",
  "Retirement": "Voluntary Separation Program",
  "Transferring to a different UCSD department (outside of RRSS)": "Transfer - Intra Location",
  "Transferring to another UC Campus (outside of UCSD)": "Interlocation (BU) Transfer",
  // ─── Involuntary (UC_INVOL_TERM) ───
  "Graduated/No longer a Student": "No Longer Student",
  "Appointment Expired": "Appointment Expired",
};

/**
 * Map Kuali termination type to UCPath reason code.
 * Falls back to fuzzy match if exact match not found.
 */
export function mapReasonCode(terminationType: string): string {
  // Exact match
  if (REASON_CODE_MAP[terminationType]) {
    return REASON_CODE_MAP[terminationType];
  }

  // Empty/whitespace-only input has nothing to fuzzy-match — every entry's
  // `kualiType.includes("")` is vacuously true, which would otherwise return
  // whichever map entry happens to be first instead of the intended default.
  if (!terminationType.trim()) {
    return "Resign - No Reason Given";
  }

  // Fuzzy match — find key containing the termination type text
  const lowerType = terminationType.toLowerCase();
  for (const [kualiType, ucpathReason] of Object.entries(REASON_CODE_MAP)) {
    if (lowerType.includes(kualiType.toLowerCase()) || kualiType.toLowerCase().includes(lowerType)) {
      return ucpathReason;
    }
  }

  // Default fallback
  return "Resign - No Reason Given";
}

/**
 * Get initials from full name (e.g., "Julian Zaw" → "JZ").
 */
export function getInitials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

/**
 * Parse MM/DD/YYYY to Date.
 */
function parseDate(dateStr: string): Date {
  const [m, d, y] = dateStr.split("/").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Compute the Kronos date range for timecard search.
 * Start = min(lastDayWorked, separationDate) - 1 month
 * End   = max(lastDayWorked, separationDate) + 1 month
 * Returns dates in M/D/YYYY format (for setDateRange digit typing).
 */
export function computeKronosDateRange(
  lastDayWorked: string,
  separationDate: string,
): { startDate: string; endDate: string } {
  const ldw = parseDate(lastDayWorked);
  const sep = parseDate(separationDate);

  const earlier = ldw <= sep ? ldw : sep;
  const later = ldw >= sep ? ldw : sep;

  const start = new Date(earlier);
  start.setMonth(start.getMonth() - 1);

  const end = new Date(later);
  end.setMonth(end.getMonth() + 1);

  return { startDate: formatMmDdYyyy(start), endDate: formatMmDdYyyy(end) };
}

/**
 * Build the Last-Day-Worked date-change comment for the Timekeeper/Approver
 * Comments field. The New Kronos last physical punch overrides Kuali's LDW;
 * this records that change. Returns an empty string when the LDW did not
 * change. The Separation Date change has its own builder
 * (`buildSeparationDateChangeComment`) — the two are joined in kuali-finalize.
 */
export function buildDateChangeComments(
  originalLastDay: string,
  newLastDay: string,
  initials: string,
): string {
  if (originalLastDay === newLastDay) return "";
  return `Updated Last Day Worked from ${originalLastDay} to ${newLastDay} per Kronos timesheet. -${initials}`;
}

/**
 * Build the Separation-Date date-change comment for the Timekeeper/Approver
 * Comments field. The Separation Date is now derived from the New Kronos
 * timecard (last day worked, extended by sick/holiday leave) rather than taken
 * verbatim from Kuali, so it can differ from the requester's entry; this
 * records that change. Returns an empty string when it did not change.
 */
export function buildSeparationDateChangeComment(
  originalSeparationDate: string,
  newSeparationDate: string,
  initials: string,
): string {
  if (originalSeparationDate === newSeparationDate) return "";
  return `Updated Separation Date from ${originalSeparationDate} to ${newSeparationDate} per Kronos timesheet. -${initials}`;
}

/**
 * Build the two-line "duplicate termination" comment for the Kuali
 * Timekeeper/Approver Comments field, filed when the `transaction-check` step
 * finds an ALREADY-APPROVED UCPath termination (TER) transaction for this
 * employee. The UCPath termination is reused (no new transaction is created),
 * so the Kuali form is finalized with the existing transaction number plus this
 * audit note. Format (operator-provided, Image 7):
 *
 *   Duplicate termination. Re Kuali Form #<docId>. -<initials> <today>
 *   EE termination approved on UCPath. -<initials> <today>
 *
 * `today` is MM/DD/YYYY (pass `todayMmDdYyyy()`); `initials` are the operator's
 * (pass `getInitials(timekeeperName)`); `docId` is the Kuali form number.
 */
export function buildDuplicateTerminationComment(
  docId: string,
  initials: string,
  today: string,
): string {
  return (
    `Duplicate termination. Re Kuali Form #${docId}. -${initials} ${today}\n` +
    `EE termination approved on UCPath. -${initials} ${today}`
  );
}

/**
 * Join non-empty comment parts with a newline, trimming each part first.
 * Use this wherever two or more comment fragments are merged:
 *   - the duplicate-termination comment + any existing edit-resume override
 *   - date-change audit lines (LDW + separation date)
 *   - the combined date-change block + user-supplied override
 */
export function joinComments(...parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n");
}

/**
 * Throw if the supplied MM/DD/YYYY date is strictly in the future. Caller
 * controls the field-name context via the `fieldLabel` argument so the error
 * message points at the right Kuali field (Last Day Worked vs Separation
 * Date). Compares against local midnight today — "today" is always valid.
 */
export function validateLastDayWorked(
  dateStr: string,
  fieldLabel: string = "Last Day Worked",
): void {
  const [m, d, y] = dateStr.split("/").map(Number);
  if (!m || !d || !y) {
    throw new Error(`${fieldLabel} has unparseable date: "${dateStr}" (expected MM/DD/YYYY)`);
  }
  const supplied = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (supplied.getTime() > today.getTime()) {
    throw new Error(
      `${fieldLabel} cannot be in the future: got "${dateStr}" (today is ${formatMmDdYyyy(today)}). Employee is not yet eligible for separation.`,
    );
  }
}
