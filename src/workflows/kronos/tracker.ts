import { appendRow } from "../../tracker/index.js";
import type { ColumnDef } from "../../tracker/index.js";
import { TRACKER_PATH } from "./config.js";

const COLUMNS: ColumnDef[] = [
  { header: "Employee ID", key: "employeeId", width: 15 },
  { header: "Employee Name", key: "employeeName", width: 25 },
  { header: "PDF Name", key: "pdfName", width: 25 },
  { header: "Status", key: "status", width: 12 },
  { header: "Notes", key: "notes", width: 40 },
  { header: "Timestamp", key: "timestamp", width: 22 },
];

export interface KronosTrackerRow {
  employeeId: string;
  employeeName: string;
  pdfName: string;
  status: string;
  notes: string;
  timestamp: string;
}

export function buildTrackerRow(
  employeeId: string,
  employeeName: string,
  status: string,
  notes: string = "",
  pdfName: string = "",
): KronosTrackerRow {
  return {
    employeeId,
    employeeName,
    pdfName,
    status,
    notes,
    timestamp: new Date().toISOString(),
  };
}

export async function updateKronosTracker(
  filePath: string,
  data: KronosTrackerRow,
): Promise<void> {
  await appendRow(filePath, COLUMNS, data as unknown as Record<string, string>);
}

export { TRACKER_PATH };
export { COLUMNS as KRONOS_TRACKER_COLUMNS };
