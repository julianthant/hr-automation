import { appendRow } from "../../tracker/index.js";
import type { ColumnDef } from "../../tracker/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { TRACKER_PATH } from "./config.js";

const COLUMNS: ColumnDef[] = [
  { header: "Employee ID", key: "employeeId", width: 15 },
  { header: "Employee Name", key: "employeeName", width: 25 },
  { header: "Status", key: "status", width: 12 },
  { header: "Saved", key: "saved", width: 8 },
  { header: "Verified", key: "verified", width: 30 },
  { header: "Notes", key: "notes", width: 40 },
  { header: "Timestamp", key: "timestamp", width: 22 },
];

export interface KronosTrackerRow {
  employeeId: string;
  employeeName: string;
  status: string;
  saved: string;
  verified: string;
  notes: string;
  timestamp: string;
}

export function buildTrackerRow(
  employeeId: string,
  employeeName: string,
  status: string,
  notes: string = "",
  downloaded: boolean = false,
  verified: string = "",
): KronosTrackerRow {
  return {
    employeeId,
    employeeName,
    status,
    saved: downloaded ? "x" : "",
    verified,
    notes: downloaded ? "" : notes,
    timestamp: new Date().toISOString(),
  };
}

export async function updateKronosTracker(
  filePath: string,
  data: KronosTrackerRow,
): Promise<void> {
  await appendRow(filePath, COLUMNS, data as unknown as Record<string, string>);
  trackEvent({
    workflow: "kronos-reports",
    timestamp: data.timestamp || new Date().toISOString(),
    id: data.employeeId,
    status: data.status === "Done" ? "done" : "failed",
    data: { name: data.employeeName ?? "", saved: data.saved ?? "" },
    error: data.notes || undefined,
  });
}

export { TRACKER_PATH };
export { COLUMNS as KRONOS_TRACKER_COLUMNS };
