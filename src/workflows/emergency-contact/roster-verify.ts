import fs from "node:fs";
import path from "node:path";
import { log } from "../../utils/log.js";
import { parseCsv } from "../../utils/csv.js";
import { loadRoster, normalizeEid } from "../../services/matching/index.js";
import { normalizePersonNameForCompare } from "../../domain/identity/person-name.js";
import type { EmergencyContactBatch } from "./schema.js";

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
  return normalizePersonNameForCompare(s, { lettersOnly: true });
}

function namesMatch(a: string, b: string): boolean {
  const aw = new Set(normalizeName(a).split(" ").filter((w) => w.length >= 3));
  const bw = new Set(normalizeName(b).split(" ").filter((w) => w.length >= 3));
  for (const w of aw) if (bw.has(w)) return true;
  return false;
}

// ── Header column resolution (CSV path; XLSX uses services/matching loadRoster) ──

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
// (shared `parseCsv` — promoted to `utils/csv.ts` when the roster loader
// gained CSV support, 2026-07-17)

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

// ── Public entry point ─────────────────────────────────────

export async function verifyBatchAgainstRoster(
  batch: EmergencyContactBatch,
  rosterPath: string,
): Promise<RosterVerifyResult> {
  const ext = path.extname(rosterPath).toLowerCase();

  const byEid = new Map<string, string>();
  let rosterRows = 0;

  if (ext === ".csv") {
    const { resolution, dataRows } = loadCsvRoster(rosterPath);
    if (resolution.nameCol === -1 && (resolution.firstNameCol === -1 || resolution.lastNameCol === -1)) {
      log.step("Roster has no Name column — matching on EID only (no name verification)");
    }
    for (const cells of dataRows) {
      const eid = normalizeEid(cells[resolution.eidCol - 1]);
      if (!eid) continue;
      rosterRows++;
      byEid.set(eid, readNameFromCells(cells, resolution));
    }
  } else {
    // XLSX: shared cached loader (multi-sheet, mtime-keyed cache, rich-text coercion).
    // No name-column warning here — parseRosterFile skips sheets without name headers;
    // it throws if no worksheet has a recognizable header.
    const rows = await loadRoster(rosterPath);
    for (const row of rows) {
      const eid = normalizeEid(row.eid);
      if (!eid) continue;
      rosterRows++;
      byEid.set(eid, row.name);
    }
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
  if (ext === ".csv") {
    const { resolution, dataRows } = loadCsvRoster(rosterPath);
    const out: RosterRowSummary[] = [];
    for (const cells of dataRows) {
      const emplId = normalizeEid(cells[resolution.eidCol - 1]);
      if (!emplId) continue;
      out.push({ emplId, name: readNameFromCells(cells, resolution) });
    }
    return out;
  }
  const rows = await loadRoster(rosterPath);
  return rows
    .map((row) => ({ emplId: normalizeEid(row.eid), name: row.name }))
    .filter((row) => row.emplId.length > 0);
}

export { namesMatch, normalizeName };
