import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ExcelJS from "exceljs";
import type { RosterRow } from "./match.js";

export interface RosterFileRef {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  filename: string;
}

/** Newest .xlsx in `dir` by mtime, or null if dir is empty / missing / has no .xlsx. */
export function findLatestRoster(dir: string): RosterFileRef | null {
  const all = listRosters(dir);
  return all[0] ?? null;
}

/** All .xlsx files in `dir`, sorted by mtime DESC. Empty array if dir missing. */
export function listRosters(dir: string): RosterFileRef[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => extname(f).toLowerCase() === ".xlsx")
    .map((f): RosterFileRef | null => {
      const p = join(dir, f);
      try {
        const s = statSync(p);
        return { path: p, mtimeMs: s.mtimeMs, sizeBytes: s.size, filename: f };
      } catch {
        return null;
      }
    })
    .filter((x): x is RosterFileRef => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Read an xlsx roster file into a list of RosterRow.
 *
 * The Onboarding Roster spreadsheet ships one worksheet per cohort week
 * ("July 25", "August 8", ..., "May 1") and each sheet has 0–3 preamble
 * rows (title, merged-cell decoration) above the actual header row. We
 * walk every worksheet, find the header row dynamically (first row that
 * contains a recognized column name), and concatenate matching rows.
 *
 * Recognized columns:
 *   - EID:    "UCPath ID" | "Employee ID" | "Empl ID"  (optional — rows
 *             without an EID are kept with `eid = ""` so name matching
 *             can still find them; the orchestrator falls through to
 *             eid-lookup when the resolved roster row has no EID).
 *   - Name:   "Legal Name" | "Lived Name" | "Name"  (single col), or
 *             "First Name" + "Last Name"  (split).
 *   - Address: "Street"/"Address", "City", "State", "Zip"/"Postal".
 *
 * Throws only when the file has no recognizable header in any worksheet
 * (i.e. the spreadsheet shape is fundamentally different than expected).
 */
export async function loadRoster(path: string): Promise<RosterRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  const out: RosterRow[] = [];
  let sawAnyHeader = false;

  for (const ws of wb.worksheets) {
    const headerRowNum = findHeaderRow(ws);
    if (headerRowNum === null) continue;

    const headers: string[] = [];
    ws.getRow(headerRowNum).eachCell({ includeEmpty: true }, (cell) => {
      headers.push(cellToString(cell.value).trim());
    });

    const idx = (target: RegExp): number =>
      headers.findIndex((h) => target.test(h));
    const eidCol = idx(/^ucpath\s*id$|^empl(oyee)?\s*id$/i) + 1;
    const firstCol = idx(/first\s*name/i) + 1;
    const lastCol = idx(/last\s*name/i) + 1;
    const nameCol = idx(/^legal\s*name$|^lived\s*name$|^name$/i) + 1;
    const streetCol = idx(/^street$|^address$/i) + 1;
    const cityCol = idx(/^city$/i) + 1;
    const stateCol = idx(/^state$/i) + 1;
    const zipCol = idx(/^zip$|^postal$/i) + 1;

    // Sheet without any name-bearing column can't contribute usable rows.
    if (nameCol === 0 && (firstCol === 0 || lastCol === 0)) continue;
    sawAnyHeader = true;

    for (let n = headerRowNum + 1; n <= ws.rowCount; n++) {
      const row = ws.getRow(n);
      let name = nameCol > 0 ? cellToString(row.getCell(nameCol).value).trim() : "";
      if (!name && firstCol > 0 && lastCol > 0) {
        const f = cellToString(row.getCell(firstCol).value).trim();
        const l = cellToString(row.getCell(lastCol).value).trim();
        name = `${f} ${l}`.trim();
      }
      if (!name) continue;

      const eid = eidCol > 0 ? cellToString(row.getCell(eidCol).value).trim() : "";
      const street = streetCol > 0 ? cellToString(row.getCell(streetCol).value).trim() : "";
      const city = cityCol > 0 ? cellToString(row.getCell(cityCol).value).trim() : "";
      const state = stateCol > 0 ? cellToString(row.getCell(stateCol).value).trim() : "";
      const zip = zipCol > 0 ? cellToString(row.getCell(zipCol).value).trim() : "";

      out.push({
        eid,
        name,
        street: street || undefined,
        city: city || undefined,
        state: state || undefined,
        zip: zip || undefined,
      });
    }
  }

  if (!sawAnyHeader) {
    throw new Error(
      `loadRoster: no recognizable header row found in any worksheet of ${path}`,
    );
  }
  return out;
}

/**
 * Find the first row in a worksheet containing a recognizable header
 * keyword. Onboarding rosters frequently have a merged-title row at the
 * top followed by a blank or near-blank row, so we scan the first 20
 * rows rather than assuming row 1.
 */
function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  const recognized = /^(legal\s*name|lived\s*name|ucpath\s*id|empl(oyee)?\s*id|first\s*name|last\s*name|^name)$/i;
  const limit = Math.min(20, ws.rowCount);
  for (let n = 1; n <= limit; n++) {
    const row = ws.getRow(n);
    let hit = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (hit) return;
      if (recognized.test(cellToString(cell.value).trim())) hit = true;
    });
    if (hit) return n;
  }
  return null;
}

/**
 * Coerce an ExcelJS cell value into a plain string. Hyperlink and
 * rich-text cells deserialize as `{text, hyperlink}` / `{richText: [...]}`
 * objects; without unwrapping them, `String(value)` produces the literal
 * text "[object Object]" — which is how the Email column rendered when
 * we first saw the SharePoint roster.
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text;
    if (typeof v.hyperlink === "string") return v.hyperlink;
    if (Array.isArray(v.richText)) {
      return v.richText
        .map((seg) => (seg && typeof (seg as { text?: unknown }).text === "string" ? (seg as { text: string }).text : ""))
        .join("");
    }
    if (typeof v.result === "string" || typeof v.result === "number") {
      return String(v.result);
    }
  }
  return String(value);
}
