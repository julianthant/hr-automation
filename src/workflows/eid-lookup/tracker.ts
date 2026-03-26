import { appendRow, type ColumnDef } from "../../tracker/spreadsheet.js";
import { log } from "../../utils/log.js";
import type { EidResult } from "./search.js";

const TRACKER_PATH = "./src/workflows/eid-lookup/eid-lookup-tracker.xlsx";

const COLUMNS: ColumnDef[] = [
  { header: "Employee Name", key: "employeeName", width: 25 },
  { header: "Empl ID", key: "emplId", width: 14 },
  { header: "HR Status", key: "hrStatus", width: 12 },
  { header: "Department", key: "department", width: 30 },
  { header: "Dept ID", key: "deptId", width: 10 },
  { header: "Job Code", key: "jobCode", width: 10 },
  { header: "Job Title", key: "jobTitle", width: 25 },
  { header: "Position #", key: "positionNumber", width: 14 },
  { header: "Start Date", key: "startDate", width: 14 },
  { header: "End Date", key: "endDate", width: 14 },
  { header: "FTE", key: "fte", width: 10 },
  { header: "Empl Class", key: "emplClass", width: 15 },
  { header: "Search Name", key: "searchName", width: 25 },
  { header: "Timestamp", key: "timestamp", width: 22 },
];

export async function updateEidTracker(
  searchName: string,
  result: EidResult,
): Promise<void> {
  try {
    await appendRow(TRACKER_PATH, COLUMNS, {
      employeeName: result.name,
      emplId: result.emplId,
      hrStatus: result.hrStatus,
      department: result.department ?? "",
      deptId: result.deptId ?? "",
      jobCode: result.jobCode,
      jobTitle: result.jobCodeDescription,
      positionNumber: result.positionNumber ?? "",
      startDate: result.effectiveDate ?? "",
      endDate: result.expectedEndDate || "Active",
      fte: result.fte ?? "",
      emplClass: result.emplClass ?? "",
      searchName,
      timestamp: new Date().toISOString(),
    });
    log.step(`Tracker updated for EID ${result.emplId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Tracker write failed: ${msg}`);
  }
}

export async function updateEidTrackerNotFound(searchName: string): Promise<void> {
  try {
    await appendRow(TRACKER_PATH, COLUMNS, {
      employeeName: searchName,
      emplId: "Not Found",
      hrStatus: "",
      department: "",
      deptId: "",
      jobCode: "",
      jobTitle: "",
      positionNumber: "",
      startDate: "",
      endDate: "",
      fte: "",
      emplClass: "",
      searchName,
      timestamp: new Date().toISOString(),
    });
    log.step(`Tracker updated: Not Found for "${searchName}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Tracker write failed: ${msg}`);
  }
}
