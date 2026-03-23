import ExcelJS from "exceljs";

/** Column definition for ExcelJS worksheets. */
export interface ColumnDef {
  header: string;
  key: string;
  width: number;
}

/**
 * Append a row to an .xlsx file using daily worksheet tabs (YYYY-MM-DD).
 * Creates the file and/or tab if they don't exist.
 */
export async function appendRow(
  filePath: string,
  columns: ColumnDef[],
  data: Record<string, string>,
): Promise<void> {
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
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
  } else {
    // ExcelJS loses column key mapping after readFile.
    // Re-apply keys so addRow(object) maps correctly.
    for (let i = 0; i < columns.length; i++) {
      const col = sheet.getColumn(i + 1);
      col.key = columns[i].key;
    }
  }

  sheet.addRow(data);
  await workbook.xlsx.writeFile(filePath);
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
