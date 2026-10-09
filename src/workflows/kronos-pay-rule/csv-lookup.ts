import { readFileSync } from "fs";
import { resolve } from "path";
import Papa from "papaparse";
import { log } from "../../utils/log.js";
import type { EmployeeElectionData } from "./election-logic.js";

const DEFAULT_CSV_PATH = resolve(
  import.meta.dirname,
  "../../../.tracker/rosters/RRSS June 2026 OT Elections Tracker(Represented EEs RRSS - OT -CT).csv",
);

function resolveCsvPath(): string {
  const override = process.env.HRAUTO_ELECTIONS_CSV?.trim();
  return override ? resolve(override) : DEFAULT_CSV_PATH;
}

interface ParsedRow {
  [key: string]: string;
}

/** Find a column key by prefix (handles multiline headers from papaparse). */
function findColumnKey(row: ParsedRow, prefix: string): string {
  const key = Object.keys(row).find((k) => k.startsWith(prefix));
  if (!key) throw new Error(`[Kronos Pay Rule] CSV column starting with "${prefix}" not found`);
  return key;
}

let cachedRows: ParsedRow[] | null = null;

/**
 * Exact-key columns `lookupEmployee` reads with a per-cell `?? ""` fallback.
 * Validated once at load: if the roster's headers change (e.g. next year's
 * export renames "Pay Rule In UKG if applicable" or fixes the "Currect
 * Election" typo), every row would silently read "" — which skips the ENTIRE
 * campaign as "Not in UKG" while looking like success. Fail loud at load
 * instead (root CLAUDE.md "Fail loud"). The two prefix-matched columns
 * ("Election eff.", "Timekeeping System updated") already fail loud in
 * `findColumnKey`.
 */
const REQUIRED_EXACT_COLUMNS = [
  "Employee ID",
  "Employee Name",
  "Union Code",
  "Pay Rule In UKG if applicable",
  "Currect Election",
] as const;

/**
 * Load and parse the OT Elections Tracker CSV.
 * Results are cached after first load.
 */
export function loadElectionsTracker(): ParsedRow[] {
  if (cachedRows) return cachedRows;
  log.step("[Kronos Pay Rule] Loading OT Elections Tracker CSV...");
  const csvContent = readFileSync(resolveCsvPath(), "utf-8");
  const result = Papa.parse<ParsedRow>(csvContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });
  if (result.errors.length > 0) {
    log.warn(
      `[Kronos Pay Rule] CSV parse warnings: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  const first = result.data[0];
  if (first) {
    const missing = REQUIRED_EXACT_COLUMNS.filter((col) => !(col in first));
    if (missing.length > 0) {
      throw new Error(
        `[Kronos Pay Rule] Elections CSV is missing required column(s) ${missing
          .map((c) => `"${c}"`)
          .join(", ")} — headers changed? (${resolveCsvPath()})`,
      );
    }
  }
  cachedRows = result.data;
  log.step(`[Kronos Pay Rule] Loaded ${cachedRows.length} rows from tracker CSV`);
  return cachedRows;
}

/**
 * Look up an employee by ID in the OT Elections Tracker.
 * Returns null if the employee is not found.
 */
export function lookupEmployee(emplId: string): EmployeeElectionData | null {
  const rows = loadElectionsTracker();
  const row = rows.find((r) => (r["Employee ID"] ?? "").trim() === emplId.trim());
  if (!row) return null;

  const electionKey = findColumnKey(row, "Election eff.");
  const updatedKey = findColumnKey(row, "Timekeeping System updated");

  return {
    employeeName: (row["Employee Name"] ?? "").trim(),
    employeeId: (row["Employee ID"] ?? "").trim(),
    unionCode: (row["Union Code"] ?? "").trim(),
    payRuleInUKG: (row["Pay Rule In UKG if applicable"] ?? "").trim(),
    currentElection: (row["Currect Election"] ?? "").trim(),
    newElection: (row[electionKey] ?? "").trim(),
    timekeepingSystem: (row["Timeekeping System"] ?? "").trim(),
    alreadyUpdated: (row[updatedKey] ?? "").trim(),
  };
}

/** Invalidate the cached rows (useful for testing). */
export function clearCache(): void {
  cachedRows = null;
}
