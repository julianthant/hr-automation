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
  isVoluntary: z.boolean(),
  terminationEffDate: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/, "Must be MM/DD/YYYY"),

  // From UCPath Workforce Job Summary
  deptId: z.string().optional(),
  departmentDescription: z.string().optional(),
  jobCode: z.string().optional(),
  jobDescription: z.string().optional(),

  // From Kronos search
  foundInOldKronos: z.boolean().optional(),
  foundInNewKronos: z.boolean().optional(),

  // From UCPath transaction
  transactionNumber: z.string().optional(),
});

export type SeparationData = z.infer<typeof SeparationDataSchema>;

/**
 * Compute the termination effective date (separation date + 1 day).
 */
export function computeTerminationEffDate(separationDate: string): string {
  const [month, day, year] = separationDate.split("/").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + 1);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

/**
 * Build the comments text for the UCPath termination transaction.
 */
export function buildTerminationComments(
  terminationEffDate: string,
  lastDayWorked: string,
  docId: string,
): string {
  return `Termination EFF ${terminationEffDate}. Last day worked: ${lastDayWorked}. Kuali form #${docId}.`;
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
 * Compare Kronos timecard dates and Kuali dates to determine the correct
 * Last Day Worked and Separation Date.
 *
 * Logic:
 * - If either Kronos has time entries, pick the latest Kronos date
 * - If the Kronos date is later than Kuali's dates, update them
 * - If neither Kronos has time, keep Kuali's original dates
 *
 * Returns { lastDayWorked, separationDate, changed: boolean }
 */
export function resolveKronosDates(
  kualiLastDay: string,
  kualiSepDate: string,
  oldKronosDate: string | null,
  newKronosDate: string | null,
): { lastDayWorked: string; separationDate: string; changed: boolean } {
  // No Kronos data — keep originals
  if (!oldKronosDate && !newKronosDate) {
    return { lastDayWorked: kualiLastDay, separationDate: kualiSepDate, changed: false };
  }

  // Pick the latest Kronos date
  let kronosDate: string;
  if (oldKronosDate && newKronosDate) {
    kronosDate = parseDate(oldKronosDate) >= parseDate(newKronosDate) ? oldKronosDate : newKronosDate;
  } else {
    kronosDate = (oldKronosDate ?? newKronosDate)!;
  }

  const kronosParsed = parseDate(kronosDate);
  const kualiLastParsed = parseDate(kualiLastDay);
  const kualiSepParsed = parseDate(kualiSepDate);

  // Only update if Kronos date is different from both Kuali dates
  const lastDayDiffers = kronosParsed.getTime() !== kualiLastParsed.getTime();
  const sepDateDiffers = kronosParsed.getTime() !== kualiSepParsed.getTime();

  if (!lastDayDiffers && !sepDateDiffers) {
    return { lastDayWorked: kualiLastDay, separationDate: kualiSepDate, changed: false };
  }

  // Use Kronos date for both if it's later, otherwise keep original
  return {
    lastDayWorked: kronosParsed > kualiLastParsed ? kronosDate : kualiLastDay,
    separationDate: kronosParsed > kualiSepParsed ? kronosDate : kualiSepDate,
    changed: true,
  };
}

/**
 * Compute the Kronos date range for timecard search.
 * Start = min(lastDayWorked, separationDate) - 2 weeks
 * End   = max(lastDayWorked, separationDate) + 2 weeks
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
  start.setDate(start.getDate() - 14);

  const end = new Date(later);
  end.setDate(end.getDate() + 14);

  const fmt = (d: Date) => {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  };

  return { startDate: fmt(start), endDate: fmt(end) };
}

/**
 * Build date change comments for the Timekeeper/Approver Comments field.
 * Only generates text if dates were actually changed.
 */
export function buildDateChangeComments(
  originalLastDay: string,
  newLastDay: string,
  originalSepDate: string,
  newSepDate: string,
  initials: string,
): string {
  const lines: string[] = [];
  if (originalLastDay !== newLastDay) {
    lines.push(`Updated Last Day Worked from ${originalLastDay} to ${newLastDay} per Kronos timesheet. -${initials}`);
  }
  if (originalSepDate !== newSepDate) {
    lines.push(`Updated Separation Date from ${originalSepDate} to ${newSepDate} per Kronos timesheet. -${initials}`);
  }
  return lines.join("\n");
}
