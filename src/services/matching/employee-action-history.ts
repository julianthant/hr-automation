/**
 * Employee Action History Report loader + I-9 cross-ref.
 *
 * The separations "Run I-9 Check" flow uses this roster twice: OCR enrichment
 * matches each scanned person BY NAME (`crossRefI9Record`) to seed PPS EID /
 * roster Empl ID / Separation Date, and the separations i9-check daemon step
 * re-matches BY the UCPath-resolved Empl ID (`lookupActionHistoryRowByEmplId`)
 * once the live person search answers. "Found in UCPath?" itself is owned by
 * that live search; this roster only supplies the spreadsheet columns.
 *
 * Fail loud: a missing / unreadable roster file throws — never silently
 * leave the cross-ref columns empty as if the check completed cleanly.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ExcelJS from "exceljs";
import { PATHS } from "../../config.js";
import { normalizePersonNameForCompare } from "../../domain/identity/person-name.js";

export interface ActionHistoryRow {
  name: string;
  /** UCPath Employee ID (column "Employee ID"). */
  ucpathEmplId: string;
  /** Legacy PPS ID (column "Employee PPS ID Current"), leading zeros preserved. */
  ppsEid: string;
  /** Job Start Date as mm/dd/yyyy when parseable. */
  jobStartDate: string;
  /** Job End Date as mm/dd/yyyy when parseable. */
  jobEndDate: string;
  /** Job Action Code (e.g. TER). */
  jobActionCode: string;
  /** Job Action label (e.g. Termination). */
  jobAction: string;
}

export interface ActionHistoryIndex {
  byEmplId: Map<string, ActionHistoryRow[]>;
  byNormalizedName: Map<string, ActionHistoryRow[]>;
  /**
   * `"<last>|<first>"` → rows. The middle name is deliberately NOT in the key:
   * an I-9 Section 1 records a middle INITIAL ("Abramson, Michelle M") while the
   * roster carries the full middle name ("Abramson, Michelle Meili"), so an
   * exact-string index misses every person who has one. Middle names are
   * compared as a compatibility FILTER over these candidates instead.
   */
  byLastFirst: Map<string, ActionHistoryRow[]>;
  /**
   * Stripped "Employee PPS ID Current" → rows. PPS IDs are often 5–7 meaningful
   * digits (zero-padded to 9 in the report). The i9-check daemon rematches by
   * PPS when Empl ID misses but OCR seeded a short PPS from the name match.
   */
  byPpsId: Map<string, ActionHistoryRow[]>;
  sourcePath: string;
}

/** A person name split into comparison parts. All lowercase, whitespace-collapsed. */
interface NameParts {
  last: string;
  first: string;
  /** Full middle name, a single initial, or "" when the source recorded none. */
  middle: string;
}

/**
 * Split "Last, First Middle" (the shape BOTH the roster and the I-9 name line
 * use) into parts. A multi-word surname before the comma is preserved whole
 * ("Torres Perez, Edgar I" → last "torres perez").
 *
 * Without a comma the last/first boundary is genuinely ambiguous, so we assume
 * the "Last First Middle" order our own fallback builder emits. Callers that
 * can form a comma'd name should.
 */
export function splitPersonNameParts(raw: string | null | undefined): NameParts | null {
  const norm = normalizePersonNameForCompare(raw);
  if (!norm) return null;
  const comma = norm.indexOf(",");
  const last = (comma >= 0 ? norm.slice(0, comma) : norm.split(" ")[0] ?? "").trim();
  const rest = (comma >= 0 ? norm.slice(comma + 1) : norm.split(" ").slice(1).join(" ")).trim();
  const tokens = rest.split(" ").filter(Boolean);
  const first = tokens[0] ?? "";
  const middle = tokens.slice(1).join(" ");
  if (!last || !first) return null;
  return { last, first, middle };
}

/** `"<last>|<first>"` — the middle-insensitive candidate key. */
function lastFirstKey(parts: NameParts): string {
  return `${parts.last}|${parts.first}`;
}

/**
 * Can these two middle values describe the same person?
 *
 * Absent on either side → compatible (the I-9 box is often blank). An initial
 * is compatible with a full middle name starting with it ("m" ~ "meili").
 * Two DIFFERENT full middle names are not — that is a different person.
 */
export function middleNamesCompatible(a: string, b: string): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return false;
}

export interface I9ActionHistoryCrossRef {
  ppsEid?: string;
  /** The roster's PPS ID verbatim, leading zeros preserved (spreadsheet exports need the padded form). */
  ppsEidPadded?: string;
  rosterEmplId?: string;
  i9SeparationDate?: string;
}

const HEADER = {
  name: /^employee\s*name(\s*current)?$/i,
  emplId: /^employee\s*id$/i,
  pps: /^employee\s*pps\s*id(\s*current)?$/i,
  jobStart: /^job\s*start\s*date$/i,
  jobEnd: /^job\s*end\s*date$/i,
  actionCode: /^job\s*action\s*code$/i,
  action: /^job\s*action$/i,
} as const;

/** Cache: path+mtime → parsed index. */
const cache = new Map<string, Promise<ActionHistoryIndex>>();

/** @internal Test isolation. */
export function __resetActionHistoryCacheForTests(): void {
  cache.clear();
}

/**
 * Default Action History path (`PATHS.i9ActionHistoryPath`). Throws when the
 * file is missing — I-9 enrichment must not continue without the cross-ref.
 */
export function resolveI9ActionHistoryPath(override?: string): string {
  const path = resolve(override ?? PATHS.i9ActionHistoryPath);
  if (!existsSync(path)) {
    throw new Error(
      `I-9 Action History roster missing at ${path} — place the Employee Action History Report under data/rosters/ (or pass an explicit path)`,
    );
  }
  return path;
}

export function loadEmployeeActionHistory(path?: string): Promise<ActionHistoryIndex> {
  const abs = resolveI9ActionHistoryPath(path);
  const mtimeMs = statSync(abs).mtimeMs;
  const key = `${abs}:${mtimeMs}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const promise = parseActionHistoryFile(abs).catch((err: unknown) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  return promise;
}

async function parseActionHistoryFile(path: string): Promise<ActionHistoryIndex> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);

  const byEmplId = new Map<string, ActionHistoryRow[]>();
  const byNormalizedName = new Map<string, ActionHistoryRow[]>();
  const byLastFirst = new Map<string, ActionHistoryRow[]>();
  const byPpsId = new Map<string, ActionHistoryRow[]>();
  let sawHeader = false;

  for (const ws of wb.worksheets) {
    const headerRowNum = findHeaderRow(ws);
    if (headerRowNum === null) continue;

    const headers: string[] = [];
    ws.getRow(headerRowNum).eachCell({ includeEmpty: true }, (cell) => {
      headers.push(cellToString(cell.value).trim());
    });

    const idx = (pat: RegExp): number => headers.findIndex((h) => pat.test(h)) + 1;
    const nameCol = idx(HEADER.name);
    const emplCol = idx(HEADER.emplId);
    const ppsCol = idx(HEADER.pps);
    const startCol = idx(HEADER.jobStart);
    const endCol = idx(HEADER.jobEnd);
    const codeCol = idx(HEADER.actionCode);
    const actionCol = idx(HEADER.action);

    if (nameCol === 0 || emplCol === 0) continue;
    sawHeader = true;

    for (let n = headerRowNum + 1; n <= ws.rowCount; n++) {
      const row = ws.getRow(n);
      const name = cellToString(row.getCell(nameCol).value).trim();
      const ucpathEmplId = cellToString(row.getCell(emplCol).value).trim();
      if (!name || !ucpathEmplId) continue;

      const entry: ActionHistoryRow = {
        name,
        ucpathEmplId,
        ppsEid: ppsCol > 0 ? cellToString(row.getCell(ppsCol).value).trim() : "",
        jobStartDate: startCol > 0 ? formatDateCell(row.getCell(startCol).value) : "",
        jobEndDate: endCol > 0 ? formatDateCell(row.getCell(endCol).value) : "",
        jobActionCode: codeCol > 0 ? cellToString(row.getCell(codeCol).value).trim() : "",
        jobAction: actionCol > 0 ? cellToString(row.getCell(actionCol).value).trim() : "",
      };

      push(byEmplId, ucpathEmplId, entry);
      const ppsKey = normalizePpsIdKey(entry.ppsEid);
      if (ppsKey) push(byPpsId, ppsKey, entry);
      const norm = normalizePersonNameForCompare(name);
      if (norm) push(byNormalizedName, norm, entry);
      const parts = splitPersonNameParts(name);
      if (parts) push(byLastFirst, lastFirstKey(parts), entry);
    }
  }

  if (!sawHeader) {
    throw new Error(
      `loadEmployeeActionHistory: no recognizable header row in any worksheet of ${path}`,
    );
  }
  return { byEmplId, byNormalizedName, byLastFirst, byPpsId, sourcePath: path };
}

function push(map: Map<string, ActionHistoryRow[]>, key: string, row: ActionHistoryRow): void {
  const list = map.get(key);
  if (list) list.push(row);
  else map.set(key, [row]);
}

function findHeaderRow(ws: ExcelJS.Worksheet): number | null {
  const recognized = /^(employee\s*name(\s*current)?|employee\s*id|employee\s*pps\s*id)/i;
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
 * Pick the best Action History row for separation date: prefer the latest
 * Termination (TER / "Termination") by Job End Date; else the latest row by
 * Job End Date; else the first row.
 */
export function pickActionHistoryRow(rows: ActionHistoryRow[]): ActionHistoryRow | undefined {
  if (rows.length === 0) return undefined;
  const terminations = rows.filter(
    (r) =>
      /^ter$/i.test(r.jobActionCode) || /^termination$/i.test(r.jobAction),
  );
  const pool = terminations.length > 0 ? terminations : rows;
  return [...pool].sort((a, b) => compareMmDdYyyyDesc(a.jobEndDate, b.jobEndDate))[0];
}

/**
 * Cross-ref one I-9 preview record against the Action History index.
 *
 * An I-9 carries only a NAME (plus DOB/SSN) — never an Empl ID or PPS ID — so
 * this matches TWICE, in decreasing order of certainty:
 *
 *   1. By the Empl ID UCPath resolved for this person (`matchedEmplId`). This
 *      is the reliable pass: UCPath already proved the identity.
 *   2. By name, for the records UCPath could not resolve (a misread SSN digit
 *      is enough) — otherwise those rows lose their PPS EID too, even though
 *      the roster may well know the person.
 *
 * The name pass is deliberately tolerant of the ONE difference the two sources
 * always have — the I-9 records a middle INITIAL, the roster a full middle name
 * — but it never guesses: if candidates sharing a last+first name resolve to
 * more than one Empl ID and the middle can't separate them, it returns nothing
 * rather than stamp a coin-flipped PPS ID onto a real HR record.
 */
export function crossRefI9Record(
  rec: {
    name?: string;
    matchedEmplId?: string;
    lastName?: string | null;
    firstName?: string | null;
    middleInitial?: string | null;
  },
  index: ActionHistoryIndex,
): I9ActionHistoryCrossRef {
  // ── Pass 1: the UCPath-resolved Empl ID ──
  const byId = rec.matchedEmplId
    ? index.byEmplId.get(rec.matchedEmplId.trim())
    : undefined;
  let rows = byId;

  // ── Pass 2: the name ──
  if (!rows || rows.length === 0) {
    // Build a comma'd name so the parts split reads "Last, First Middle"
    // unambiguously (a bare "Last First Middle" join has no such guarantee).
    const display =
      (rec.name ?? "").trim()
      || [
        (rec.lastName ?? "").trim(),
        [(rec.firstName ?? "").trim(), (rec.middleInitial ?? "").trim()]
          .filter(Boolean)
          .join(" "),
      ]
        .filter(Boolean)
        .join(", ");

    // Exact normalized name first — unambiguous when it hits.
    const norm = normalizePersonNameForCompare(display);
    if (norm) rows = index.byNormalizedName.get(norm);

    // Then last+first, filtering by middle-name compatibility. This is what
    // actually matches real data: "Abramson, Michelle M" ~ "Abramson, Michelle Meili".
    if (!rows || rows.length === 0) {
      const parts = splitPersonNameParts(display);
      const candidates = parts ? index.byLastFirst.get(lastFirstKey(parts)) : undefined;
      if (parts && candidates && candidates.length > 0) {
        const compatible = candidates.filter((row) => {
          const rowParts = splitPersonNameParts(row.name);
          return rowParts ? middleNamesCompatible(parts.middle, rowParts.middle) : false;
        });
        // One PERSON may legitimately hold several rows (several job actions);
        // several distinct Empl IDs means several people — refuse to pick.
        const distinctIds = new Set(compatible.map((row) => row.ucpathEmplId));
        if (distinctIds.size === 1) rows = compatible;
      }
    }
  }
  if (!rows || rows.length === 0) return {};

  const picked = pickActionHistoryRow(rows);
  if (!picked) return {};

  return crossRefFromRow(picked);
}

/**
 * Look up Action History rows for one UCPath Empl ID and pick the retention
 * row — the EID-only re-match the separations i9-check daemon step uses after
 * live UCPath resolved the person. Deliberately NO name fallback: the OCR
 * stage already did name matching, and the daemon must not silently
 * contradict a UCPath-proven identity with a name guess.
 */
export function lookupActionHistoryRowByEmplId(
  emplId: string,
  index: ActionHistoryIndex,
): ActionHistoryRow | undefined {
  const trimmed = emplId.trim();
  if (!trimmed) return undefined;
  const rows = index.byEmplId.get(trimmed);
  if (!rows || rows.length === 0) return undefined;
  return pickActionHistoryRow(rows);
}

/**
 * Look up Action History by "Employee PPS ID Current". Accepts a padded or
 * zero-stripped PPS (OCR seeds the stripped 5–7 digit form). Same pick rule as
 * the Empl ID rematch.
 */
export function lookupActionHistoryRowByPpsId(
  ppsId: string,
  index: ActionHistoryIndex,
): ActionHistoryRow | undefined {
  const key = normalizePpsIdKey(ppsId);
  if (!key) return undefined;
  const rows = index.byPpsId.get(key);
  if (!rows || rows.length === 0) return undefined;
  return pickActionHistoryRow(rows);
}

/** Normalize a PPS ID for index/lookup — digits only, leading zeros stripped. */
export function normalizePpsIdKey(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  return stripLeadingZerosKeep(digits);
}

/** Project one roster row onto the I-9 cross-ref columns. */
export function crossRefFromRow(row: ActionHistoryRow): I9ActionHistoryCrossRef {
  const out: I9ActionHistoryCrossRef = {};
  if (row.ppsEid) {
    out.ppsEid = stripLeadingZerosKeep(row.ppsEid);
    out.ppsEidPadded = row.ppsEid.trim();
  }
  if (row.ucpathEmplId) out.rosterEmplId = row.ucpathEmplId;
  if (row.jobEndDate) out.i9SeparationDate = row.jobEndDate;
  return out;
}

/** Apply cross-ref onto a mutable I-9 preview record. Pure aside from mutation. */
export function applyActionHistoryToI9Record<T extends Record<string, unknown>>(
  rec: T & {
    ppsEid?: string;
    ppsEidPadded?: string;
    rosterEmplId?: string;
    i9SeparationDate?: string;
  },
  xref: I9ActionHistoryCrossRef,
): T {
  if (xref.ppsEid) rec.ppsEid = xref.ppsEid;
  if (xref.ppsEidPadded) rec.ppsEidPadded = xref.ppsEidPadded;
  if (xref.rosterEmplId) rec.rosterEmplId = xref.rosterEmplId;
  if (xref.i9SeparationDate) rec.i9SeparationDate = xref.i9SeparationDate;
  return rec;
}

/** PPS IDs often ship zero-padded (000044696) — keep meaningful digits, drop leading zeros for display but never empty the value. */
function stripLeadingZerosKeep(raw: string): string {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  const stripped = trimmed.replace(/^0+/, "");
  return stripped || "0";
}

function compareMmDdYyyyDesc(a: string, b: string): number {
  const ta = parseMmDdYyyy(a);
  const tb = parseMmDdYyyy(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
}

function parseMmDdYyyy(s: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day);
}

function formatDateCell(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = value.getMonth() + 1;
    const day = value.getDate();
    const year = value.getFullYear();
    return `${month}/${day}/${year}`;
  }
  const raw = cellToString(value).trim();
  if (!raw) return "";
  // ExcelJS sometimes stringifies Date as "Sun Oct 17 2021 17:00:00 GMT-0700 …"
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${Number(m[1])}/${Number(m[2])}/${year}`;
  }
  return raw;
}

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
        .map((seg) =>
          seg && typeof (seg as { text?: unknown }).text === "string"
            ? (seg as { text: string }).text
            : "",
        )
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
