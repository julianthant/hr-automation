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
 */
const REASON_CODE_MAP: Record<string, string> = {
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
  "Graduated/No longer a Student": "Resign - Attend School",
  "Appointment Expired": "Resign - No Reason Given",
  "Transferring to a different UCSD department (outside of RRSS)": "Transfer - Intra Location",
  "Transferring to another UC Campus (outside of UCSD)": "Interlocation (BU) Transfer",
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
