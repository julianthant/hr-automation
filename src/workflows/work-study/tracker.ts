import { appendRow } from "../../tracker/index.js";
import type { ColumnDef } from "../../tracker/index.js";
import { trackEvent } from "../../tracker/jsonl.js";

const TRACKER_PATH = "./src/workflows/work-study/work-study-tracker.xlsx";

const COLUMNS: ColumnDef[] = [
  { header: "Empl ID", key: "emplId", width: 14 },
  { header: "Employee Name", key: "employeeName", width: 25 },
  { header: "Effective Date", key: "effectiveDate", width: 14 },
  { header: "Position Pool", key: "positionPool", width: 12 },
  { header: "Status", key: "status", width: 12 },
  { header: "Error", key: "error", width: 30 },
  { header: "Timestamp", key: "timestamp", width: 22 },
];

export interface WorkStudyTrackerRow {
  emplId: string;
  employeeName: string;
  effectiveDate: string;
  positionPool: string;
  status: string;
  error: string;
  timestamp: string;
}

/**
 * Append a row to the work-study tracker spreadsheet.
 * Uses the shared appendRow with daily worksheet tabs (YYYY-MM-DD).
 */
export async function updateWorkStudyTracker(data: WorkStudyTrackerRow): Promise<void> {
  await appendRow(TRACKER_PATH, COLUMNS, data as unknown as Record<string, string>);
  trackEvent({
    workflow: "work-study",
    timestamp: data.timestamp || new Date().toISOString(),
    id: data.emplId,
    status: data.status === "Done" ? "done" : "failed",
    data: { name: data.employeeName ?? "" },
    error: data.error || undefined,
  });
}
