import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { resolveRosterDirs } from "../../services/matching/roster-loader.js";
import { parseCsv } from "../../utils/csv.js";
import type {
  ProcessEidPersonInput,
  ProcessEidSheetInput,
} from "./schema.js";

const ONBOARDING_ROSTER_NAME = /onboarding.*\.xlsx$/i;
const LIVED_NAME_HEADER = /^lived\s*name$/i;
const LEGAL_NAME_HEADER = /^legal\s*name$/i;
const TRANSACTION_HEADER =
  /^(?:ucpath\s*)?transaction\s*(?:number|no\.?|#|id)$/i;
const EID_HEADER =
  /^(?:ucpath\s*)?(?:employee\s*id|empl\s*id|eid|id)$/i;
const ASSIGNED_EID = /^\d{5,}$/;
const EMPTY_EID_LABEL =
  /^(?:pending|requested|not\s*found|n\/?a|new)$/i;
const HEADER_SCAN_ROWS = 20;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        })
        .join("")
        .trim();
    }
    if (
      typeof record.result === "string" ||
      typeof record.result === "number"
    ) {
      return String(record.result).trim();
    }
  }
  const valueType =
    value && typeof value === "object" && "constructor" in value
      ? value.constructor.name
      : typeof value;
  throw new Error(
    `Process EID cannot read unsupported roster cell value type "${valueType}"`,
  );
}

function normalizedSheetName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Newest local `.xlsx` whose filename explicitly identifies it as onboarding. */
export function findLatestProcessEidRosterPath(
  trackerDir?: string,
): string | undefined {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const dir of resolveRosterDirs(trackerDir)) {
    if (!existsSync(dir)) continue;
    for (const filename of readdirSync(dir)) {
      if (filename.startsWith("~$")) continue;
      if (!ONBOARDING_ROSTER_NAME.test(filename)) continue;
      const path = join(dir, filename);
      candidates.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path;
}

function isMissingEid(value: string, rowNumber: number): boolean {
  const trimmed = value.trim();
  if (!trimmed || EMPTY_EID_LABEL.test(trimmed)) return true;
  if (ASSIGNED_EID.test(trimmed)) return false;
  throw new Error(
    `Process EID roster row ${rowNumber} has an unrecognized EID value "${value}"`,
  );
}

/**
 * One roster table, however it was stored: an `.xlsx` worksheet or a `.csv`
 * file. `cells[n]` is file/sheet row `n + 1`, so every message and every
 * `rosterRow` the operator sees counts the way the source does.
 */
export interface ProcessEidRosterTable {
  /** Worksheet name, or the CSV's filename — the label rows are grouped under. */
  label: string;
  cells: string[][];
}

/**
 * Select rows to look up: a transaction number present, an EID column that is
 * still empty (blank / `Requested` / `Pending` / `New`), and a name to prove
 * the transaction against. A row whose EID is already filled is never
 * re-processed.
 *
 * Transaction numbers are indexed across EVERY row, not just the unassigned
 * ones, so a number the roster lists twice is caught even when the other
 * occurrence is already done. A repeat does NOT abort the whole roster — the
 * ambiguity belongs to those rows, so each one carries a `rosterConflict` and
 * fails loud on its own while the unambiguous rows still run.
 */
export function extractProcessEidCandidates(
  table: ProcessEidRosterTable,
): ProcessEidPersonInput[] {
  let headerRow = 0;
  let livedNameColumn = 0;
  let legalNameColumn = 0;
  let transactionColumn = 0;
  let eidColumn = 0;
  const scanTo = Math.min(HEADER_SCAN_ROWS, table.cells.length);
  for (let index = 0; index < scanTo; index++) {
    let rowLivedNameColumn = 0;
    let rowLegalNameColumn = 0;
    let rowTransactionColumn = 0;
    let rowEidColumn = 0;
    (table.cells[index] ?? []).forEach((text, columnIndex) => {
      const column = columnIndex + 1;
      if (LIVED_NAME_HEADER.test(text)) rowLivedNameColumn = column;
      if (LEGAL_NAME_HEADER.test(text)) rowLegalNameColumn = column;
      if (TRANSACTION_HEADER.test(text)) rowTransactionColumn = column;
      if (EID_HEADER.test(text)) rowEidColumn = column;
    });
    if (rowLivedNameColumn && rowTransactionColumn && rowEidColumn) {
      headerRow = index + 1;
      livedNameColumn = rowLivedNameColumn;
      legalNameColumn = rowLegalNameColumn;
      transactionColumn = rowTransactionColumn;
      eidColumn = rowEidColumn;
      break;
    }
  }
  if (!headerRow) {
    throw new Error(
      `Roster "${table.label}" must contain Lived Name, Transaction Number, and EID/UCPath ID headers in one row`,
    );
  }

  const cellAt = (rowNumber: number, column: number): string =>
    column ? (table.cells[rowNumber - 1]?.[column - 1] ?? "").trim() : "";

  // Pass 1 — index every transaction number in the table, assigned or not.
  const transactionRows = new Map<string, number[]>();
  for (let rowNumber = headerRow + 1; rowNumber <= table.cells.length; rowNumber++) {
    const transactionValue = cellAt(rowNumber, transactionColumn);
    if (!transactionValue || !/^T/i.test(transactionValue)) continue;
    if (!/^T\d{4,}$/i.test(transactionValue)) {
      throw new Error(
        `Process EID roster row ${rowNumber} has invalid transaction number "${transactionValue}"`,
      );
    }
    const transactionId = transactionValue.toUpperCase();
    const rows = transactionRows.get(transactionId);
    if (rows) rows.push(rowNumber);
    else transactionRows.set(transactionId, [rowNumber]);
  }

  // Pass 2 — keep only the rows that still need an EID.
  const candidates: ProcessEidPersonInput[] = [];
  for (const [transactionId, rows] of transactionRows) {
    for (const rowNumber of rows) {
      if (!isMissingEid(cellAt(rowNumber, eidColumn), rowNumber)) continue;
      const livedName = cellAt(rowNumber, livedNameColumn);
      const legalName = cellAt(rowNumber, legalNameColumn);
      if (!livedName && !legalName) {
        throw new Error(
          `Process EID roster row ${rowNumber} has transaction ${transactionId} but no Lived Name or Legal Name`,
        );
      }
      // A row with only one name spelling carries only `livedName` — the lived
      // name is what the roster shows the operator, and a duplicate legal name
      // adds nothing to search or to proof.
      const searchName = livedName || legalName;
      const others = rows.filter((row) => row !== rowNumber);
      candidates.push({
        source: "person",
        livedName: searchName,
        ...(legalName && legalName !== searchName ? { legalName } : {}),
        transactionId,
        sheet: table.label,
        rosterRow: rowNumber,
        ...(others.length > 0
          ? {
              rosterConflict:
                `Roster "${table.label}" lists transaction ${transactionId} on rows ` +
                `${[rowNumber, ...others].sort((a, b) => a - b).join(", ")} — ` +
                `one transaction cannot belong to two people. Fix the roster before looking this row up.`,
            }
          : {}),
      });
    }
  }
  candidates.sort((a, b) => a.rosterRow - b.rosterRow);
  if (candidates.length === 0) {
    throw new Error(
      `Roster "${table.label}" has no rows with a transaction number and a missing EID`,
    );
  }
  return candidates;
}

function readCsvTable(rosterPath: string, sheet?: string): ProcessEidRosterTable {
  if (sheet) {
    throw new Error(
      `A .csv roster holds one table, so worksheet "${sheet}" cannot be selected in ${rosterPath}`,
    );
  }
  const cells = parseCsv(readFileSync(rosterPath, "utf8")).map((row) =>
    row.map((cell) => cell.trim()),
  );
  return { label: basename(rosterPath), cells };
}

async function readXlsxTable(
  rosterPath: string,
  sheet?: string,
): Promise<ProcessEidRosterTable> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(rosterPath);
  const worksheet = selectWorksheet(workbook, rosterPath, sheet);
  const cells: string[][] = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      values[column - 1] = cellText(cell.value);
    });
    cells.push(values);
  }
  return { label: worksheet.name, cells };
}

function selectWorksheet(
  workbook: ExcelJS.Workbook,
  rosterPath: string,
  sheet?: string,
): ExcelJS.Worksheet {
  const available = workbook.worksheets.map((ws) => ws.name).join(", ");
  if (!sheet) {
    if (workbook.worksheets.length !== 1) {
      throw new Error(
        `${rosterPath} has ${workbook.worksheets.length} worksheets, so one must be named. ` +
        `Available worksheets: ${available || "<none>"}`,
      );
    }
    return workbook.worksheets[0];
  }
  const wanted = normalizedSheetName(sheet);
  const matching = workbook.worksheets.filter(
    (ws) => normalizedSheetName(ws.name) === wanted,
  );
  if (matching.length !== 1) {
    throw new Error(
      `Process EID expected exactly one worksheet named "${sheet}", found ${matching.length}. ` +
      `Available worksheets: ${available || "<none>"}`,
    );
  }
  return matching[0];
}

/**
 * Read one roster table — a named `.xlsx` worksheet or a `.csv` file — and
 * return only the rows that still need an EID. No roster value is modified.
 */
export async function loadProcessEidCandidates(
  input: ProcessEidSheetInput,
  trackerDir?: string,
): Promise<ProcessEidPersonInput[]> {
  const rosterPath = input.rosterPath
    ? resolve(input.rosterPath)
    : findLatestProcessEidRosterPath(trackerDir);
  if (!rosterPath) {
    throw new Error(
      "No local onboarding .xlsx roster was found. Download the onboarding roster first, " +
      "or start this run with the full path to a roster .xlsx/.csv.",
    );
  }
  if (!existsSync(rosterPath)) {
    throw new Error(`Process EID roster does not exist: ${rosterPath}`);
  }
  const extension = extname(rosterPath).toLowerCase();
  if (extension !== ".xlsx" && extension !== ".csv") {
    throw new Error(
      `Process EID reads .xlsx or .csv rosters, not "${extension || "<no extension>"}": ${rosterPath}`,
    );
  }

  const table = extension === ".csv"
    ? readCsvTable(rosterPath, input.sheet)
    : await readXlsxTable(rosterPath, input.sheet);
  return extractProcessEidCandidates(table);
}
