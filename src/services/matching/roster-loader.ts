import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ExcelJS from "exceljs";
import { rostersDir, sharepointDir } from "../../tracker/paths.js";
import { parseCsv } from "../../utils/csv.js";
import type { RosterRow } from "./match.js";

/** Roster file formats the loader can read (see `loadRoster`'s ext dispatch). */
const ROSTER_EXTENSIONS = new Set([".xlsx", ".csv"]);

export interface RosterFileRef {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  filename: string;
}

/** The operator's real tracker root — the only one whose rosters live in `data/`. */
const DEFAULT_TRACKER_DIR = ".tracker";

/**
 * Roster search dirs, in precedence order, for `trackerDir`.
 *
 * The tracker root's own dirs ALWAYS come first, and `<repo>/data/rosters` is
 * appended ONLY for the default root. That asymmetry is deliberate and load
 * bearing, not a style choice:
 *
 * `data/rosters` is operator data (the real Action History + SharePoint
 * downloads — hundreds of real employees), while a non-default tracker root
 * means the caller asked for ISOLATION (`HRAUTO_TRACKER_DIR`: the e2e lane,
 * tests, a dashboard preview seeded with synthetic fixtures). Letting a
 * cwd-anchored operator dir into an isolated root's search path breaks that
 * isolation in the worst direction: `makeCaptureFinalize` picks the FIRST
 * EXISTING dir, so `data/rosters` (always present in the repo) would win over
 * the fixture roster and silently match a synthetic capture against real
 * people. An isolated root resolves strictly within itself — no roster there is
 * "no roster", which the caller handles, rather than a wrong one.
 *
 * Legacy `<root>/rosters` + `<root>/sharepoint` stay in the list for every root
 * so older downloads still resolve.
 */
export function resolveRosterDirs(trackerDir = DEFAULT_TRACKER_DIR): string[] {
  const dirs = [
    resolve(process.cwd(), rostersDir(trackerDir)),
    resolve(process.cwd(), sharepointDir(trackerDir)),
  ];
  if (resolve(process.cwd(), trackerDir) === resolve(process.cwd(), DEFAULT_TRACKER_DIR)) {
    dirs.unshift(resolve(process.cwd(), "data", "rosters"));
  }
  return dirs;
}

/** Newest roster file (.xlsx/.csv) in `dir` by mtime, or null if dir is empty / missing / has none. */
export function findLatestRoster(dir: string): RosterFileRef | null {
  const all = listRosters(dir);
  return all[0] ?? null;
}

/** All roster files (.xlsx/.csv) in `dir`, sorted by mtime DESC. Empty array if dir missing. */
export function listRosters(dir: string): RosterFileRef[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => ROSTER_EXTENSIONS.has(extname(f).toLowerCase()))
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

// Cache: key = `${absolutePath}:${mtimeMs}` → shared in-flight Promise.
// Rejects are evicted so transient failures (locked file, temp I/O) don't stick.
const rosterCache = new Map<string, Promise<RosterRow[]>>();

/** @internal Test isolation — clears the in-process roster cache. */
export function __resetRosterCacheForTests(): void {
  rosterCache.clear();
}

/**
 * Read a roster file (.xlsx or .csv, dispatched by extension) into a list of
 * RosterRow.
 *
 * Results are cached by `path + mtime` so repeated calls within a process
 * (e.g. OCR re-runs) skip the parse entirely when the file hasn't changed.
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
export function loadRoster(path: string): Promise<RosterRow[]> {
  const abs = resolve(path);
  const mtimeMs = statSync(abs).mtimeMs;
  const key = `${abs}:${mtimeMs}`;
  const cached = rosterCache.get(key);
  if (cached !== undefined) return cached;
  // `async` so a synchronous parse/read throw becomes a rejection — callers
  // always get a promise, never a sync escape that dodges the cache eviction.
  const parse = extname(abs).toLowerCase() === ".csv"
    ? async () => parseCsvRosterFile(abs)
    : () => parseRosterFile(abs);
  const promise = parse().catch((err: unknown) => {
    rosterCache.delete(key);
    throw err;
  });
  rosterCache.set(key, promise);
  return promise;
}

const COLUMN_PATTERNS = {
  eid:    /^ucpath\s*id$|^empl(oyee)?\s*id$/i,
  first:  /first\s*name/i,
  last:   /last\s*name/i,
  // "Employee Name Current" is the header the Employee Action History Report
  // ships — recognize it as a name column so that report is a usable roster
  // (parity with `employee-action-history.ts`'s HEADER.name), not silently
  // skipped for having no name-bearing column.
  name:   /^legal\s*name$|^lived\s*name$|^employee\s*name(\s*current)?$|^name$/i,
  street: /^street$|^address$/i,
  city:   /^city$/i,
  state:  /^state$/i,
  zip:    /^zip$|^postal$/i,
} as const;

async function parseRosterFile(path: string): Promise<RosterRow[]> {
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

    const idx = (pat: RegExp): number => headers.findIndex((h) => pat.test(h)) + 1;
    const eidCol    = idx(COLUMN_PATTERNS.eid);
    const firstCol  = idx(COLUMN_PATTERNS.first);
    const lastCol   = idx(COLUMN_PATTERNS.last);
    const nameCol   = idx(COLUMN_PATTERNS.name);
    const streetCol = idx(COLUMN_PATTERNS.street);
    const cityCol   = idx(COLUMN_PATTERNS.city);
    const stateCol  = idx(COLUMN_PATTERNS.state);
    const zipCol    = idx(COLUMN_PATTERNS.zip);

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
 * Parse a `.csv` roster into RosterRow, mirroring the xlsx path: find the
 * header row dynamically (first row with a recognized column name — exports
 * often carry decorative preamble rows), resolve columns via the same
 * COLUMN_PATTERNS, keep rows with a name (EID/address optional). Throws when
 * no recognizable header exists — a fundamentally different CSV shape must
 * surface, not silently yield zero rows (fail-loud, parity with xlsx).
 */
function parseCsvRosterFile(path: string): RosterRow[] {
  const rows = parseCsv(readFileSync(path, "utf-8"));

  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    if (rows[i].some((cell) => HEADER_KEYWORD.test(cell.trim()))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(`loadRoster: no recognizable header row found in ${path}`);
  }

  const headers = rows[headerIdx].map((h) => h.trim());
  const idx = (pat: RegExp): number => headers.findIndex((h) => pat.test(h));
  const eidCol    = idx(COLUMN_PATTERNS.eid);
  const firstCol  = idx(COLUMN_PATTERNS.first);
  const lastCol   = idx(COLUMN_PATTERNS.last);
  const nameCol   = idx(COLUMN_PATTERNS.name);
  const streetCol = idx(COLUMN_PATTERNS.street);
  const cityCol   = idx(COLUMN_PATTERNS.city);
  const stateCol  = idx(COLUMN_PATTERNS.state);
  const zipCol    = idx(COLUMN_PATTERNS.zip);

  if (nameCol === -1 && (firstCol === -1 || lastCol === -1)) {
    throw new Error(
      `loadRoster: header row in ${path} has no name-bearing column (Name / Employee Name / First+Last Name)`,
    );
  }

  const cellAt = (cells: string[], col: number): string =>
    col >= 0 ? (cells[col] ?? "").trim() : "";

  const out: RosterRow[] = [];
  for (const cells of rows.slice(headerIdx + 1)) {
    let name = cellAt(cells, nameCol);
    if (!name && firstCol >= 0 && lastCol >= 0) {
      name = `${cellAt(cells, firstCol)} ${cellAt(cells, lastCol)}`.trim();
    }
    if (!name) continue;

    const street = cellAt(cells, streetCol);
    const city = cellAt(cells, cityCol);
    const state = cellAt(cells, stateCol);
    const zip = cellAt(cells, zipCol);
    out.push({
      eid: cellAt(cells, eidCol),
      name,
      street: street || undefined,
      city: city || undefined,
      state: state || undefined,
      zip: zip || undefined,
    });
  }
  return out;
}

/** Header keywords that mark a roster's real header row (shared by xlsx + csv). */
const HEADER_KEYWORD = /^(legal\s*name|lived\s*name|employee\s*name(\s*current)?|ucpath\s*id|empl(oyee)?\s*id|first\s*name|last\s*name|name)$/i;

/**
 * Find the first row in a worksheet containing a recognizable header
 * keyword. Onboarding rosters frequently have a merged-title row at the
 * top followed by a blank or near-blank row, so we scan the first 20
 * rows rather than assuming row 1.
 */
function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  const recognized = HEADER_KEYWORD;
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
    // An unrecognized cell-object shape must never collapse to
    // "[object Object]" — serialize it legibly so the bad column is
    // diagnosable at the source.
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "[unserializable cell]";
    }
  }
  // exceljs never emits symbol/function cells; nothing readable remains.
  return "";
}
