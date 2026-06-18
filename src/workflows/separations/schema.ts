import { z } from "zod/v4";

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
 * Build the comments text for the UCPath termination transaction.
 *
 * Base form: `Termination eff <eff>. Last Day Worked <ldw>.` then, when present,
 * a Sick-leave clause and/or a Holiday-Pay clause (sick first, holiday second),
 * then ` Kuali form #<docId>.`. The sick/holiday dates come from the New Kronos
 * separation timecard (`SeparationTimecardData`) and ONLY drive this comment —
 * they never change any date.
 *
 * Clause shapes (dates are MM/DD/YYYY, chronological):
 *   - 0 dates  → no clause
 *   - 1 date   → ` Sick Leave on <d>.`  /  ` Holiday Pay on <d>.`
 *   - ≥2 dates → ` Sick leave from <first> to <last>.`  /  ` Holiday Pay from <first> to <last>.`
 */
export function buildTerminationComments(
  terminationEffDate: string,
  lastDayWorked: string,
  docId: string,
  leave?: { sickDates?: string[]; holidayDates?: string[] },
): string {
  const sickDates = leave?.sickDates ?? [];
  const holidayDates = leave?.holidayDates ?? [];

  let sickClause = "";
  if (sickDates.length === 1) {
    sickClause = ` Sick Leave on ${sickDates[0]}.`;
  } else if (sickDates.length >= 2) {
    sickClause = ` Sick leave from ${sickDates[0]} to ${sickDates[sickDates.length - 1]}.`;
  }

  let holidayClause = "";
  if (holidayDates.length === 1) {
    holidayClause = ` Holiday Pay on ${holidayDates[0]}.`;
  } else if (holidayDates.length >= 2) {
    holidayClause = ` Holiday Pay from ${holidayDates[0]} to ${holidayDates[holidayDates.length - 1]}.`;
  }

  return (
    `Termination eff ${terminationEffDate}. Last Day Worked ${lastDayWorked}.` +
    sickClause +
    holidayClause +
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
  "Appointment Expired": "Resign - No Reason Given",
  "Transferring to a different UCSD department (outside of RRSS)": "Transfer - Intra Location",
  "Transferring to another UC Campus (outside of UCSD)": "Interlocation (BU) Transfer",
  // ─── Involuntary (UC_INVOL_TERM) ───
  "Graduated/No longer a Student": "No Longer Student",
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
 * Format a Date as zero-padded MM/DD/YYYY (matching the Kuali / UCPath wire format).
 */
function formatMmDdYyyy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
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
 * Build the date-change comment for the Timekeeper/Approver Comments field.
 *
 * Only the Last Day Worked can change now (the New Kronos last physical punch
 * overrides Kuali's LDW). The Separation Date is Kuali-authoritative and is
 * never overridden, so there is no separation-date branch. Returns an empty
 * string when the LDW did not change.
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
