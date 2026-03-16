import ExcelJS from "exceljs";
import { TRACKER_COLUMNS } from "./columns.js";

export interface TrackerRow {
  firstName: string;
  middleName: string;
  lastName: string;
  ssn: string;
  dob: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  departmentNumber: string;
  recruitmentNumber: string;
  positionNumber: string;
  wage: string;
  effectiveDate: string;
  appointment: string;
  crmExtraction: string;
  personSearch: string;
  rehire: string;
  i9Record: string;
  transaction: string;
  pdfDownload: string;
  i9ProfileId: string;
  status: string;
  error: string;
  timestamp: string;
}

/**
 * Extract a 4-6 digit department number from parenthesized text.
 * Returns the last match if multiple parenthesized numbers exist.
 * Example: "Computer Science (000412)" -> "000412"
 * Returns null if no match found.
 */
export function parseDepartmentNumber(deptText: string): string | null {
  const matches = [...deptText.matchAll(/\((\d{4,6})\)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : null;
}

/**
 * Create or append to an onboarding tracker .xlsx file.
 * Uses daily worksheet tabs named YYYY-MM-DD.
 * If today's tab exists, appends. If not, creates it.
 */
export async function updateTracker(filePath: string, data: TrackerRow): Promise<void> {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.readFile(filePath);
  } catch {
    // File does not exist yet — fresh workbook
  }

  const today = new Date().toISOString().slice(0, 10);
  let sheet = workbook.getWorksheet(today);

  if (!sheet) {
    sheet = workbook.addWorksheet(today);
    sheet.columns = TRACKER_COLUMNS;
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
