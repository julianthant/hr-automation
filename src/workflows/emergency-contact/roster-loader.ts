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
 * Read an xlsx roster file into a list of RosterRow. Supports columns:
 *   - Required: "Employee ID" (or "Empl ID")
 *   - Name: either "Name" OR "First Name" + "Last Name"
 *   - Optional: "Street" (or "Address"), "City", "State", "Zip" (or "Postal")
 *
 * Throws on a missing Employee ID column. Skips rows with empty EID silently.
 */
export async function loadRoster(path: string): Promise<RosterRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    headers.push(String(cell.value ?? "").trim());
  });

  const idx = (target: RegExp): number =>
    headers.findIndex((h) => target.test(h));
  const eidCol = idx(/employee\s*id|empl\s*id/i) + 1;
  const firstCol = idx(/first\s*name/i) + 1;
  const lastCol = idx(/last\s*name/i) + 1;
  const nameCol = idx(/^name$/i) + 1;
  const streetCol = idx(/street|address/i) + 1;
  const cityCol = idx(/city/i) + 1;
  const stateCol = idx(/state/i) + 1;
  const zipCol = idx(/zip|postal/i) + 1;

  if (eidCol === 0) {
    throw new Error(`loadRoster: no Employee ID column found in ${path}`);
  }

  const out: RosterRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const eid = String(row.getCell(eidCol).value ?? "").trim();
    if (!eid) return;

    let name = nameCol > 0 ? String(row.getCell(nameCol).value ?? "").trim() : "";
    if (!name && firstCol > 0 && lastCol > 0) {
      const f = String(row.getCell(firstCol).value ?? "").trim();
      const l = String(row.getCell(lastCol).value ?? "").trim();
      name = `${f} ${l}`.trim();
    }
    if (!name) return; // no usable name — skip

    const street = streetCol > 0 ? String(row.getCell(streetCol).value ?? "").trim() : undefined;
    const city = cityCol > 0 ? String(row.getCell(cityCol).value ?? "").trim() : undefined;
    const state = stateCol > 0 ? String(row.getCell(stateCol).value ?? "").trim() : undefined;
    const zip = zipCol > 0 ? String(row.getCell(zipCol).value ?? "").trim() : undefined;

    out.push({
      eid,
      name,
      street: street || undefined,
      city: city || undefined,
      state: state || undefined,
      zip: zip || undefined,
    });
  });
  return out;
}
