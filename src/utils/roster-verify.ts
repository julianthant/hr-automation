import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { log } from "./log.js";
import type { EmergencyContactBatch } from "../workflows/emergency-contact/schema.js";

export interface RosterMismatch {
  emplId: string;
  sourcePage: number;
  batchName: string;
  rosterName: string;
}

export interface RosterMissing {
  emplId: string;
  sourcePage: number;
  batchName: string;
}

export interface RosterVerifyResult {
  matched: number;
  mismatched: RosterMismatch[];
  missing: RosterMissing[];
  rosterRows: number;
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a: string, b: string): boolean {
  const aw = new Set(normalizeName(a).split(" ").filter((w) => w.length >= 3));
  const bw = new Set(normalizeName(b).split(" ").filter((w) => w.length >= 3));
  for (const w of aw) if (bw.has(w)) return true;
  return false;
}

function normalizeEid(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return s.replace(/[^\d]/g, "");
}

// ── Header column resolution (shared between xlsx + csv) ──

interface HeaderResolution {
  eidCol: number;
  nameCol: number;  // -1 when combined name not found; negative-encoded for split names
  firstNameCol: number;
  lastNameCol: number;
}

function resolveHeaderColumns(headerCells: string[]): HeaderResolution {
  let eidCol = -1;
  let nameCol = -1;
  let firstNameCol = -1;
  let lastNameCol = -1;

  headerCells.forEach((raw, i) => {
    const text = (raw ?? "").toLowerCase().trim();
    const col = i + 1; // 1-based

    if (eidCol === -1) {
      if (
        /\bucpath\s*id\b/.test(text) ||
        /\bempl(oyee)?\s*id\b/.test(text) ||
        text === "eid" ||
        /\bempl\s*id\b/.test(text)
      ) {
        eidCol = col;
      }
    }

    if (nameCol === -1) {
      if (text === "legal name" || text === "name" || text === "lived name" || text === "employee name") {
        nameCol = col;
      }
    }

    if (firstNameCol === -1 && /\bfirst\s*name\b/.test(text)) firstNameCol = col;
    if (lastNameCol === -1 && /\blast\s*name\b/.test(text)) lastNameCol = col;
  });

  return { eidCol, nameCol, firstNameCol, lastNameCol };
}

function readNameFromCells(cells: string[], res: HeaderResolution): string {
  if (res.nameCol > 0) return (cells[res.nameCol - 1] ?? "").trim();
  if (res.firstNameCol > 0 && res.lastNameCol > 0) {
    const first = (cells[res.firstNameCol - 1] ?? "").trim();
    const last = (cells[res.lastNameCol - 1] ?? "").trim();
    return [first, last].filter(Boolean).join(" ");
  }
  return "";
}

// ── CSV parsing ─────────────────────────────────────────────

/**
 * Minimal CSV parser supporting quoted fields (including embedded commas and
 * escaped quotes `""` inside quoted fields). No external dependency.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += c; i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function loadCsvRoster(csvPath: string): {
  resolution: HeaderResolution;
  dataRows: string[][];
} {
  const text = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCsv(text);

  // The SharePoint export has ~3 decorative rows before the real header. Find
  // the first row whose cells collectively contain a UCPath/Empl ID column.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const res = resolveHeaderColumns(rows[i]);
    if (res.eidCol !== -1) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    throw new Error(`Could not find a header row with UCPath/Empl ID in ${csvPath}`);
  }

  const resolution = resolveHeaderColumns(rows[headerIdx]);
  const dataRows = rows.slice(headerIdx + 1).filter((r) => r.some((c) => c.trim() !== ""));
  return { resolution, dataRows };
}

// ── XLSX parsing (original behavior) ────────────────────────

async function loadXlsxRoster(xlsxPath: string): Promise<{
  resolution: HeaderResolution;
  dataRows: string[][];
}> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error(`Roster has no worksheets: ${xlsxPath}`);

  let headerIdx = -1;
  let resolution: HeaderResolution | undefined;
  for (let r = 1; r <= Math.min(10, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = String(cell.value ?? "");
    });
    const res = resolveHeaderColumns(cells);
    if (res.eidCol !== -1) {
      headerIdx = r;
      resolution = res;
      break;
    }
  }
  if (headerIdx === -1 || !resolution) {
    throw new Error(`Could not find a header row with UCPath/Empl ID in ${xlsxPath}`);
  }

  const dataRows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum <= headerIdx) return;
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      cells[col - 1] = String(cell.value ?? "");
    });
    if (cells.some((c) => c.trim() !== "")) dataRows.push(cells);
  });

  return { resolution, dataRows };
}

// ── Public entry point ─────────────────────────────────────

export async function verifyBatchAgainstRoster(
  batch: EmergencyContactBatch,
  rosterPath: string,
): Promise<RosterVerifyResult> {
  const ext = path.extname(rosterPath).toLowerCase();
  const { resolution, dataRows } =
    ext === ".csv"
      ? loadCsvRoster(rosterPath)
      : await loadXlsxRoster(rosterPath);

  if (resolution.nameCol === -1 && (resolution.firstNameCol === -1 || resolution.lastNameCol === -1)) {
    log.step("Roster has no Name column — matching on EID only (no name verification)");
  }

  const byEid = new Map<string, string>();
  let rosterRows = 0;
  for (const cells of dataRows) {
    const eid = normalizeEid(cells[resolution.eidCol - 1]);
    if (!eid) continue;
    rosterRows++;
    byEid.set(eid, readNameFromCells(cells, resolution));
  }

  let matched = 0;
  const mismatched: RosterMismatch[] = [];
  const missing: RosterMissing[] = [];

  for (const record of batch.records) {
    const eid = normalizeEid(record.employee.employeeId);
    const rosterName = byEid.get(eid);
    if (rosterName === undefined) {
      missing.push({
        emplId: eid,
        sourcePage: record.sourcePage,
        batchName: record.employee.name,
      });
      continue;
    }
    if (!rosterName || namesMatch(rosterName, record.employee.name)) {
      matched++;
    } else {
      mismatched.push({
        emplId: eid,
        sourcePage: record.sourcePage,
        batchName: record.employee.name,
        rosterName,
      });
    }
  }

  return { matched, mismatched, missing, rosterRows };
}

/**
 * Build a reverse index from roster: for each roster row, the EmplID,
 * legal name, PID, and supervisor. Useful for *suggesting* corrections when
 * the batch has a mismatched EID — we can try to find the intended row by name.
 */
export interface RosterRowSummary {
  emplId: string;
  name: string;
}

export async function loadRosterIndex(rosterPath: string): Promise<RosterRowSummary[]> {
  const ext = path.extname(rosterPath).toLowerCase();
  const { resolution, dataRows } =
    ext === ".csv"
      ? loadCsvRoster(rosterPath)
      : await loadXlsxRoster(rosterPath);

  const out: RosterRowSummary[] = [];
  for (const cells of dataRows) {
    const emplId = normalizeEid(cells[resolution.eidCol - 1]);
    if (!emplId) continue;
    out.push({ emplId, name: readNameFromCells(cells, resolution) });
  }
  return out;
}

export { namesMatch, normalizeName };
