import ExcelJS from "exceljs";
import { TRACKER_COLUMNS } from "./columns.js";

export interface TrackerRow {
  firstName: string;
  lastName: string;
  ssnMasked: string;
  dob: string;
  departmentNumber: string;
  recruitmentNumber: string;
  rehire: string;
  effectiveDate: string;
  crmExtracted: string;
  personSearch: string;
  transaction: string;
}

/**
 * Mask an SSN for safe storage: "123-45-6789" -> "XXX-XX-6789".
 * Returns "N/A" if the SSN is falsy (undefined, null, empty string).
 */
export function maskSsn(ssn: string | undefined): string {
  if (!ssn) return "N/A";
  return ssn.replace(/^\d{3}-\d{2}/, "XXX-XX");
}

/**
 * Extract a 4-6 digit department number from parenthesized text.
 * Returns the last match if multiple parenthesized numbers exist.
 * Example: "Computer Science (000412)" -> "000412"
 * Example: "Some (text) Dept (000412)" -> "000412" (last match)
 * Returns null if no match found.
 */
export function parseDepartmentNumber(deptText: string): string | null {
  const matches = [...deptText.matchAll(/\((\d{4,6})\)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Create or append to an onboarding tracker .xlsx file.
 * If the file does not exist, creates a new workbook with an "Onboarding Tracker" sheet.
 * If the file exists, reads it and appends a new row.
 */
export async function updateTracker(filePath: string, data: TrackerRow): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.readFile(filePath);
  } catch {
    // File does not exist yet -- fresh workbook
  }

  let sheet = workbook.getWorksheet("Onboarding Tracker");
  if (!sheet) {
    sheet = workbook.addWorksheet("Onboarding Tracker");
    sheet.columns = TRACKER_COLUMNS;
    // Bold header row
    sheet.getRow(1).font = { bold: true };
  } else {
    // ExcelJS loses column key mapping after readFile.
    // Re-apply keys so addRow(object) maps correctly.
    for (let i = 0; i < TRACKER_COLUMNS.length; i++) {
      const col = sheet.getColumn(i + 1);
      col.key = TRACKER_COLUMNS[i].key;
    }
  }

  sheet.addRow(data);
  await workbook.xlsx.writeFile(filePath);
}
