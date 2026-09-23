import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { resolveRosterDirs } from "../../services/matching/roster-loader.js";
import type {
  ProcessEidPersonInput,
  ProcessEidSheetInput,
} from "./schema.js";

const ONBOARDING_ROSTER_NAME = /onboarding.*\.xlsx$/i;
const LIVED_NAME_HEADER = /^lived\s*name$/i;
const TRANSACTION_HEADER =
  /^(?:ucpath\s*)?transaction\s*(?:number|no\.?|#|id)$/i;
const EID_HEADER =
  /^(?:ucpath\s*)?(?:employee\s*id|empl\s*id|eid|id)$/i;
const ASSIGNED_EID = /^\d{5,}$/;
const EMPTY_EID_LABEL = /^(?:pending|not\s*found|n\/?a|new)$/i;

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
 * Read one exact date-named worksheet and return only rows with a transaction
 * number but no assigned EID. No roster value is modified.
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
      "No local onboarding .xlsx roster was found. Download the onboarding roster first.",
    );
  }
  if (extname(rosterPath).toLowerCase() !== ".xlsx") {
    throw new Error(
      `Process EID requires an .xlsx roster with date-named worksheets: ${rosterPath}`,
    );
  }
  if (!existsSync(rosterPath)) {
    throw new Error(`Process EID roster does not exist: ${rosterPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(rosterPath);
  const wantedSheet = normalizedSheetName(input.sheet);
  const matchingSheets = workbook.worksheets.filter(
    (sheet) => normalizedSheetName(sheet.name) === wantedSheet,
  );
  if (matchingSheets.length !== 1) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(", ");
    throw new Error(
      `Process EID expected exactly one worksheet named "${input.sheet}", found ${matchingSheets.length}. ` +
      `Available worksheets: ${available || "<none>"}`,
    );
  }
  const worksheet = matchingSheets[0];

  let headerRow = 0;
  let livedNameColumn = 0;
  let transactionColumn = 0;
  let eidColumn = 0;
  for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount); rowNumber++) {
    let rowLivedNameColumn = 0;
    let rowTransactionColumn = 0;
    let rowEidColumn = 0;
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell, column) => {
      const text = cellText(cell.value);
      if (LIVED_NAME_HEADER.test(text)) rowLivedNameColumn = column;
      if (TRANSACTION_HEADER.test(text)) rowTransactionColumn = column;
      if (EID_HEADER.test(text)) rowEidColumn = column;
    });
    if (rowLivedNameColumn && rowTransactionColumn && rowEidColumn) {
      headerRow = rowNumber;
      livedNameColumn = rowLivedNameColumn;
      transactionColumn = rowTransactionColumn;
      eidColumn = rowEidColumn;
      break;
    }
  }
  if (!headerRow) {
    throw new Error(
      `Worksheet "${worksheet.name}" must contain Lived Name, Transaction Number, and EID/UCPath ID headers in one row`,
    );
  }

  const candidates: ProcessEidPersonInput[] = [];
  const transactionRows = new Map<string, number>();
  for (let rowNumber = headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const transactionValue = cellText(row.getCell(transactionColumn).value);
    if (!transactionValue) continue;
    if (!/^T/i.test(transactionValue)) continue;
    if (!/^T\d{4,}$/i.test(transactionValue)) {
      throw new Error(
        `Process EID roster row ${rowNumber} has invalid transaction number "${transactionValue}"`,
      );
    }
    if (!isMissingEid(cellText(row.getCell(eidColumn).value), rowNumber)) continue;

    const transactionId = transactionValue.toUpperCase();
    const priorRow = transactionRows.get(transactionId);
    if (priorRow !== undefined) {
      throw new Error(
        `Worksheet "${worksheet.name}" repeats transaction ${transactionId} on rows ${priorRow} and ${rowNumber}`,
      );
    }
    transactionRows.set(transactionId, rowNumber);

    const livedName = cellText(row.getCell(livedNameColumn).value);
    if (!livedName) {
      throw new Error(
        `Process EID roster row ${rowNumber} has transaction ${transactionId} but no Lived Name`,
      );
    }
    candidates.push({
      source: "person",
      livedName,
      transactionId,
      sheet: worksheet.name,
      rosterRow: rowNumber,
    });
  }
  if (candidates.length === 0) {
    throw new Error(
      `Worksheet "${worksheet.name}" has no rows with a transaction number and a missing EID`,
    );
  }
  return candidates;
}
