/**
 * DEV-ONLY — the spreadsheet INTAKE world model (`docs/rebuild/06-data-intake-and-edit-data.md`).
 *
 * The demo could show a run's whole life and had no way to say where its input
 * came from. This file is that missing pipeline, modelled as the backend will
 * serve it: sniffed header candidates, detected columns with samples, an
 * operator-built `ColumnMapping`, per-cell coercion with LOUD typed rejects,
 * and one immutable `IntakePlanManifest` that is the rerun/explanation
 * authority.
 *
 * The same rule as the rest of the demo: **fixtures author FACTS, the engine
 * derives everything else.** A fixture writes a raw grid of cells; it never
 * writes "6 valid, 5 rejected" — those totals come out of `validateIntake`
 * running real coercion over the real cells, so a fixture cannot claim an
 * outcome the rules would not produce.
 *
 * Two doc rules are load-bearing here and are implemented, not described:
 *
 *  - **§2.5 — fuzzy header matches are SUGGESTIONS, never applied.** The
 *    scorer returns proposals; nothing in this file writes a binding. Only an
 *    operator action (accept / manual pick / a saved-mapping load) does.
 *  - **§2.3 — a saved mapping is re-resolved by normalized header + occurrence,
 *    never by stored position.** A bound column that is gone reverts to unmapped
 *    and says so; a binding that involves a duplicate header needs visible
 *    confirmation before Run unlocks.
 */

import { at, DEMO_WORKFLOWS, plural, type DemoWorkflowId } from "./demo-wire";

// ---------------------------------------------------------------------------
// Small deterministic hashes — stand-ins for the sha256 the backend serves
// ---------------------------------------------------------------------------

/**
 * FNV-1a, hex, 16 chars. The real pipeline uses sha256 over canonical JSON
 * (§2.3); this is a browser-safe stand-in with the property that actually
 * matters for the demo: the SAME header set always produces the same
 * fingerprint, and a different one never collides.
 */
function hash16(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (input.charCodeAt(i) + i), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Canonical fields + the target-field projection (doc 06 §1, §2.1)
// ---------------------------------------------------------------------------

export type FieldKind = "eid" | "name" | "money" | "date" | "text" | "email";

export interface TargetField {
  /** stable target id — the mapping binds THIS, not the canonical concept */
  id: string;
  label: string;
  canonicalId: string;
  canonicalLabel: string;
  kind: FieldKind;
  required: boolean;
  /** aliases live on the CanonicalField; the scorer consumes them (§9.4) */
  aliases: string[];
  rule: string;
}

export const WORK_STUDY_FIELDS: TargetField[] = [
  {
    id: "eid",
    label: "Employee ID",
    canonicalId: "eid",
    canonicalLabel: "UCPath EID",
    kind: "eid",
    required: true,
    aliases: ["employee id", "emp id", "empid", "eid", "employee id#", "ucpath id"],
    rule: "10 followed by 6 digits",
  },
  {
    id: "fullName",
    label: "Full name",
    canonicalId: "personName",
    canonicalLabel: "Person name",
    kind: "name",
    required: true,
    aliases: ["name", "legal name", "full name", "employee name"],
    rule: "title-cased, first and last",
  },
  {
    id: "awardAmount",
    label: "Work-study award",
    canonicalId: "money",
    canonicalLabel: "Amount (USD)",
    kind: "money",
    required: true,
    aliases: ["award", "award $", "award amount", "amount", "work-study award"],
    rule: "a positive dollar amount",
  },
  {
    id: "effectiveDate",
    label: "Effective date",
    canonicalId: "date",
    canonicalLabel: "Date",
    kind: "date",
    required: true,
    aliases: ["effective", "effective date", "start date", "begin date"],
    rule: "MM/DD/YYYY",
  },
  {
    id: "department",
    label: "Department code",
    canonicalId: "deptCode",
    canonicalLabel: "Department code",
    kind: "text",
    required: false,
    aliases: ["dept", "dept code", "department", "department code"],
    rule: "free text",
  },
  {
    id: "email",
    label: "Campus email",
    canonicalId: "email",
    canonicalLabel: "Email address",
    kind: "email",
    required: false,
    aliases: ["email", "campus email", "ucsd email", "mail"],
    rule: "an @ucsd.edu address",
  },
];

export const INTAKE_FIELDS: Partial<Record<DemoWorkflowId, TargetField[]>> = {
  "work-study": WORK_STUDY_FIELDS,
};

/** the contract every parsed row is validated against — bumping it forces a diff */
export const WORKFLOW_CONTRACT_FINGERPRINT: Record<string, string> = {
  "work-study": `ws-v${DEMO_WORKFLOWS["work-study"].version}-${hash16("work-study-canonical-input").slice(0, 4)}`,
};

// ---------------------------------------------------------------------------
// The source corpus — raw grids, exactly what the parser hands back
// ---------------------------------------------------------------------------

export interface SourceSheet {
  id: string;
  fileName: string;
  sha256: string;
  sizeLabel: string;
  modifiedAt: string;
  workflow: DemoWorkflowId;
  /** the sample grid the parser returns — row 0 of this array is SHEET ROW 1 */
  grid: string[][];
  /** candidate header rows with the parser's own confidence + reasoning */
  headerCandidates: { row: number; confidence: number; why: string }[];
  /** what the parser would pick — a proposal the operator confirms */
  suggestedHeaderRow: number;
  /** true when the corpus already holds a mapping for this layout */
  savedMappingHint?: string;
}

export const SOURCE_SHEETS: SourceSheet[] = [
  {
    id: "ws-week-30",
    fileName: "work-study-week-30.xlsx",
    sha256: hash16("work-study-week-30"),
    sizeLabel: "18 KB",
    modifiedAt: at("07:41:00"),
    workflow: "work-study",
    suggestedHeaderRow: 3,
    grid: [
      ["UCSD Work-Study Award Export", "", "", "", "", ""],
      ["Generated 2026-07-24 08:12 · RRSS", "", "", "", "", ""],
      ["Employee ID#", "Legal Name", "Award $", "Effective", "Dept", "Campus Email"],
      ["10084412", "Delgado, Maria", "2400.00", "07/01/2026", "HDH01", "mdelgado@ucsd.edu"],
      ["10091755", "Iglesias, Rosa", "1800.00", "07/01/2026", "HDH01", "riglesias@ucsd.edu"],
      ["10-4567", "Okafor, Daniel", "2200.00", "07/01/2026", "LIB22", "dokafor@ucsd.edu"],
      ["10102846", "Raman, Priya", "n/a", "07/01/2026", "LIB22", "praman@ucsd.edu"],
      ["10066519", "Nguyen, Tuan", "2400.00", "2026-13-45", "HDH01", "tnguyen@ucsd.edu"],
      ["10077300", "Park, Sujin", "1950.00", "07/01/2026", "HDH01", "spark@ucsd.edu"],
      ["10084412", "Delgado, Maria", "2400.00", "07/15/2026", "HDH01", "mdelgado@ucsd.edu"],
      ["10055501", "Rivera, Tomás", "0.00", "06/01/2026", "LIB22", "trivera@ucsd.edu"],
      ["10068220", "Torres, Rita", "2100.00", "07/01/2026", "ATH09", "rtorres@ucsd.edu"],
      ["10071144", "Boateng, Kwame", "1750.00", "07/01/2026", "ATH09", "kboateng@ucsd.edu"],
      ["10093382", "Silva, Ana", "2250.00", "07/01/2026", "LIB22", "asilva@ucsd.edu"],
      ["10088017", "Chen, Wei", "1600.00", "07/01/2026", "HDH01", "wchen@ucsd.edu"],
    ],
    headerCandidates: [
      { row: 1, confidence: 0.08, why: "1 of 6 cells filled — reads like a report title" },
      { row: 2, confidence: 0.05, why: "1 of 6 cells filled, and it contains a timestamp" },
      { row: 3, confidence: 0.96, why: "6 of 6 cells distinct and non-empty; 5 match known field aliases" },
      { row: 4, confidence: 0.22, why: "6 of 6 filled, but 2 cells parse as numbers — reads like data" },
    ],
  },
  {
    id: "ws-week-29",
    fileName: "work-study-week-29.xlsx",
    sha256: hash16("work-study-week-29"),
    sizeLabel: "14 KB",
    modifiedAt: at("07:12:00"),
    workflow: "work-study",
    suggestedHeaderRow: 2,
    savedMappingHint: "saved Jul 18",
    grid: [
      ["Work-Study — week 29", "", "", "", "", "", ""],
      ["EmpID", "Name", "Name", "Award $", "Dept Code", "Start Date", "Campus Email"],
      ["10084412", "Delgado, Maria", "M. Delgado", "2400.00", "HDH01", "07/01/2026", "mdelgado@ucsd.edu"],
      ["10091755", "Iglesias, Rosa", "R. Iglesias", "1800.00", "HDH01", "07/01/2026", "riglesias@ucsd.edu"],
      ["10077300", "Park, Sujin", "S. Park", "1950.00", "HDH01", "07/01/2026", "spark@ucsd.edu"],
      ["10068220", "Torres, Rita", "R. Torres", "2100.00", "ATH09", "07/01/2026", "rtorres@ucsd.edu"],
      ["10071144", "Boateng, Kwame", "K. Boateng", "1750.00", "ATH09", "07/01/2026", "kboateng@ucsd.edu"],
      ["10093382", "Silva, Ana", "A. Silva", "2250.00", "LIB22", "07/01/2026", "asilva@ucsd.edu"],
      ["10088017", "Chen, Wei", "W. Chen", "1600.00", "HDH01", "07/01/2026", "wchen@ucsd.edu"],
      ["10102846", "Raman, Priya", "P. Raman", "2050.00", "LIB22", "07/01/2026", "praman@ucsd.edu"],
    ],
    headerCandidates: [
      { row: 1, confidence: 0.06, why: "1 of 7 cells filled — reads like a report title" },
      { row: 2, confidence: 0.81, why: "7 of 7 filled, but 2 are the same heading (“Name”) — duplicates need confirming" },
      { row: 3, confidence: 0.19, why: "7 of 7 filled, 2 cells parse as numbers — reads like data" },
    ],
  },
  {
    id: "ws-week-31",
    fileName: "work-study-week-31-holiday.xlsx",
    sha256: hash16("work-study-week-31"),
    sizeLabel: "4 KB",
    modifiedAt: at("06:55:00"),
    workflow: "work-study",
    suggestedHeaderRow: 1,
    grid: [
      ["EmpID", "Legal Name", "Effective", "Dept"],
      ["WS-0412", "Delgado, Maria", "07/01/2026", "HDH01"],
      ["WS-1755", "Iglesias, Rosa", "07/01/2026", "HDH01"],
      ["pending", "Okafor, Daniel", "07/01/2026", "LIB22"],
      ["", "Park, Sujin", "07/01/2026", "HDH01"],
    ],
    headerCandidates: [
      { row: 1, confidence: 0.93, why: "4 of 4 cells distinct and non-empty; 3 match known field aliases" },
      { row: 2, confidence: 0.28, why: "4 of 4 filled, but the first cell is not an id shape" },
    ],
  },
];

export const SHEET_BY_ID = new Map(SOURCE_SHEETS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Detected columns (doc 06 §2.1 — bound by normalized header + occurrence)
// ---------------------------------------------------------------------------

export interface DetectedColumn {
  /** `base64url(canonicalJson({normalizedHeader, occurrence}))` in production */
  sourceColumnId: string;
  header: string;
  normalizedHeader: string;
  occurrence: number;
  /** diagnostic only — a mapping NEVER re-resolves by index (§2.3) */
  currentIndex: number;
  samples: string[];
  /** more than one column shares this normalized header */
  duplicated: boolean;
}

export function detectColumns(sheet: SourceSheet, headerRow: number): DetectedColumn[] {
  const headers = sheet.grid[headerRow - 1] ?? [];
  const dataRows = sheet.grid.slice(headerRow);
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const header of headers) counts.set(normalizeHeader(header), (counts.get(normalizeHeader(header)) ?? 0) + 1);

  return headers.map((header, index) => {
    const normalizedHeader = normalizeHeader(header);
    const occurrence = (seen.get(normalizedHeader) ?? 0) + 1;
    seen.set(normalizedHeader, occurrence);
    return {
      sourceColumnId: `${normalizedHeader}#${occurrence}`,
      header,
      normalizedHeader,
      occurrence,
      currentIndex: index,
      samples: dataRows.slice(0, 3).map((row) => row[index] ?? ""),
      duplicated: (counts.get(normalizedHeader) ?? 0) > 1,
    };
  });
}

export interface ColumnRef {
  normalizedHeader: string;
  occurrence: number;
}

/** order-insensitive over {normalized header, occurrence} — §2.3 */
export function headerFingerprint(columns: ColumnRef[]): string {
  const canonical = columns
    .map((c) => `${c.normalizedHeader}|${c.occurrence}`)
    .sort()
    .join(",");
  return hash16(canonical);
}

// ---------------------------------------------------------------------------
// Suggestions — proposals ONLY (§2.5)
// ---------------------------------------------------------------------------

export interface Suggestion {
  targetFieldId: string;
  sourceColumnId: string;
  score: number;
  why: string;
}

function scoreHeader(column: DetectedColumn, field: TargetField): { score: number; why: string } {
  const h = column.normalizedHeader;
  const stripped = h.replace(/[#$().]/g, "").trim();
  for (const alias of field.aliases) {
    if (stripped === alias) return { score: 0.94, why: `“${column.header}” matches the alias “${alias}”` };
  }
  for (const alias of field.aliases) {
    if (stripped.startsWith(alias) || alias.startsWith(stripped)) {
      return { score: 0.72, why: `“${column.header}” looks like the alias “${alias}”` };
    }
  }
  for (const alias of field.aliases) {
    if (stripped.includes(alias) || alias.includes(stripped)) {
      return { score: 0.58, why: `“${column.header}” contains the alias “${alias}”` };
    }
  }
  return { score: 0, why: "" };
}

/**
 * Best proposal per target field. This returns HINTS — nothing here writes a
 * binding, and the grid starts unbound. A confident-but-wrong guess ("Name" →
 * `fullName` when the real name is in "Legal Name") is exactly the silent
 * substitution the charter bans.
 */
export function suggestBindings(columns: DetectedColumn[], fields: TargetField[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const field of fields) {
    let best: Suggestion | null = null;
    for (const column of columns) {
      const { score, why } = scoreHeader(column, field);
      if (score > 0 && (!best || score > best.score)) {
        best = { targetFieldId: field.id, sourceColumnId: column.sourceColumnId, score, why };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Saved mappings (§2.3) — stored bindings + the loud re-resolution
// ---------------------------------------------------------------------------

export interface SavedMapping {
  id: string;
  savedAt: string;
  headerRowIndex: number;
  /** the exact column set this mapping was saved against — its fingerprint */
  columns: ColumnRef[];
  /** stored by normalized header + occurrence, exactly as it will be re-resolved */
  bindings: { targetFieldId: string; normalizedHeader: string; occurrence: number }[];
  /** why a stored binding may not resolve — operator-editable config (§9.2) */
  note: string;
}

export const SAVED_MAPPINGS: SavedMapping[] = [
  {
    id: "ws-0718",
    savedAt: "2026-07-18T09:04:00",
    headerRowIndex: 2,
    columns: [
      { normalizedHeader: "empid", occurrence: 1 },
      { normalizedHeader: "name", occurrence: 1 },
      { normalizedHeader: "name", occurrence: 2 },
      { normalizedHeader: "award $", occurrence: 1 },
      { normalizedHeader: "dept code", occurrence: 1 },
      { normalizedHeader: "start date", occurrence: 1 },
      { normalizedHeader: "campus email", occurrence: 1 },
    ],
    bindings: [
      // hand-carried over from an older export whose id column was "Employee ID#".
      // The heading is not in this layout, so the field reverts LOUD — the stored
      // position is never used as a fallback (§2.3).
      { targetFieldId: "eid", normalizedHeader: "employee id#", occurrence: 1 },
      // two columns share this heading → confirmation required before Run
      { targetFieldId: "fullName", normalizedHeader: "name", occurrence: 1 },
      { targetFieldId: "awardAmount", normalizedHeader: "award $", occurrence: 1 },
      // a genuinely WRONG saved binding — every row will fail date coercion
      { targetFieldId: "effectiveDate", normalizedHeader: "dept code", occurrence: 1 },
      { targetFieldId: "email", normalizedHeader: "campus email", occurrence: 1 },
    ],
    note: "config/column-mappings/work-study/<fingerprint>.json is operator-greppable configuration. This one was edited by hand from an older export, so one binding names a heading this layout does not have.",
  },
];

/**
 * A saved mapping is found by the fingerprint of the WHOLE detected column set
 * — never by filename, never by a near-miss. A near-miss layout can never
 * partially reuse a stale mapping (§2.3).
 */
export function findSavedMapping(columns: DetectedColumn[]): SavedMapping | null {
  const fingerprint = headerFingerprint(columns);
  return SAVED_MAPPINGS.find((m) => headerFingerprint(m.columns) === fingerprint) ?? null;
}

export type BindingOrigin = "saved" | "suggestion" | "manual";

export interface Binding {
  targetFieldId: string;
  sourceColumnId: string;
  origin: BindingOrigin;
  /** duplicate-header reuse — Run stays blocked until the operator confirms */
  confirmationRequired?: boolean;
}

export interface SavedMappingLoad {
  mapping: SavedMapping;
  bindings: Binding[];
  /** a bound column that is no longer present — reverted, never guessed */
  reverted: { targetFieldId: string; wantedHeader: string }[];
  needsConfirmation: string[];
}

/**
 * Re-resolve a saved mapping against THIS parse. Each binding is looked up by
 * normalized header + occurrence; a column that is gone reverts the field to
 * unmapped and says which heading it wanted. The stored index is never used as
 * a fallback — a column insertion would then map the wrong column silently.
 */
export function loadSavedMapping(mapping: SavedMapping, columns: DetectedColumn[]): SavedMappingLoad {
  const bindings: Binding[] = [];
  const reverted: { targetFieldId: string; wantedHeader: string }[] = [];
  const needsConfirmation: string[] = [];

  for (const saved of mapping.bindings) {
    const column = columns.find((c) => c.normalizedHeader === saved.normalizedHeader && c.occurrence === saved.occurrence);
    if (!column) {
      reverted.push({ targetFieldId: saved.targetFieldId, wantedHeader: saved.normalizedHeader });
      continue;
    }
    const confirmationRequired = column.duplicated;
    if (confirmationRequired) needsConfirmation.push(saved.targetFieldId);
    bindings.push({ targetFieldId: saved.targetFieldId, sourceColumnId: column.sourceColumnId, origin: "saved", confirmationRequired });
  }

  return { mapping, bindings, reverted, needsConfirmation };
}

// ---------------------------------------------------------------------------
// Coercion (§2.4) — a bad cell is a NAMED rejection, never a substituted value
// ---------------------------------------------------------------------------

export type CoercionResult =
  | { ok: true; value: string }
  | { ok: false; code: string; reason: string; kind: "cell-coercion" | "field-schema" };

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

export function coerceCell(field: TargetField, raw: string): CoercionResult {
  const value = raw.trim();
  if (value === "") {
    return { ok: false, code: "empty-cell", reason: `${field.label} is empty — a blank is not a value, and there is no default to fall back to.`, kind: "field-schema" };
  }
  switch (field.kind) {
    case "eid": {
      const compact = value.replace(/\s+/g, "");
      if (!/^10\d{6}$/.test(compact)) {
        return { ok: false, code: "not-an-eid", reason: `value "${value}" is not a UCPath EID (must be 10xxxxxx, ${field.rule}).`, kind: "cell-coercion" };
      }
      return { ok: true, value: compact };
    }
    case "money": {
      const num = Number(value.replace(/[$,]/g, ""));
      if (!Number.isFinite(num)) {
        return { ok: false, code: "not-an-amount", reason: `value "${value}" is not a dollar amount.`, kind: "field-schema" };
      }
      if (num < 0) {
        return { ok: false, code: "negative-amount", reason: `value "${value}" is negative; a work-study award cannot be below zero.`, kind: "field-schema" };
      }
      return { ok: true, value: num.toFixed(2) };
    }
    case "date": {
      const m = DATE_RE.exec(value);
      if (!m) {
        return { ok: false, code: "not-a-date", reason: `value "${value}" is not a date in MM/DD/YYYY.`, kind: "cell-coercion" };
      }
      const month = Number(m[1]);
      const day = Number(m[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return { ok: false, code: "impossible-date", reason: `value "${value}" is not a real calendar date.`, kind: "cell-coercion" };
      }
      return { ok: true, value: `${m[3]}-${m[1]}-${m[2]}` };
    }
    case "name": {
      // "Delgado, Maria" → "Maria Delgado", title-cased
      const parts = value.includes(",") ? value.split(",").map((p) => p.trim()).reverse() : [value];
      const joined = parts.join(" ").replace(/\s+/g, " ").trim();
      if (joined.split(" ").length < 2) {
        return { ok: false, code: "not-a-full-name", reason: `value "${value}" is not a full name — first and last are both required.`, kind: "field-schema" };
      }
      return { ok: true, value: joined.replace(/\b[\p{L}]/gu, (c) => c.toUpperCase()) };
    }
    case "email": {
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value)) {
        return { ok: false, code: "not-an-email", reason: `value "${value}" is not an email address.`, kind: "field-schema" };
      }
      return { ok: true, value: value.toLowerCase() };
    }
    default:
      return { ok: true, value };
  }
}

// ---------------------------------------------------------------------------
// The manifest (§5) — the rerun/explanation authority
// ---------------------------------------------------------------------------

export type RejectKind =
  | "unmapped-required"
  | "cell-coercion"
  | "field-schema"
  | "workflow-schema"
  | "duplicate-identity"
  | "cross-field";

export interface RowReject {
  rejectId: string;
  sourceRow: number;
  kind: RejectKind;
  code: string;
  reason: string;
  targetFieldId?: string;
  column?: { header: string; sourceColumnId: string };
  raw?: string;
  collidingSourceRows?: number[];
  paths?: string[];
}

export interface IntakeCorrection {
  sourceRow: number;
  targetFieldId: string;
  original: string;
  correctedValue: string;
  correctedAt: string;
}

export interface IntakeExclusion {
  sourceRow: number;
  reason: string;
  operatorConfirmedAt: string;
}

export interface ManifestValidRow {
  sourceRow: number;
  itemId: string;
  inputHash: string;
  parsedInput: Record<string, string>;
}

export interface IntakePlanManifest {
  version: 1;
  planId: string;
  workflow: DemoWorkflowId;
  source: { artifactId: string; sha256: string; originalName: string };
  mappingFingerprint: string;
  mappingSnapshotHash: string;
  workflowContractFingerprint: string;
  createdAt: string;
  totals: { sourceRows: number; valid: number; rejected: number; rejectionEvents: number; excluded: number; corrected: number };
  sourceRowDispositions: { sourceRow: number; disposition: "valid" | "rejected" | "excluded"; itemId?: string; currentRejectIds: string[] }[];
  validRows: ManifestValidRow[];
  rejectedRows: RowReject[];
  corrections: IntakeCorrection[];
  exclusions: IntakeExclusion[];
}

export interface MisMapHint {
  targetFieldId: string;
  column: string;
  failed: number;
  total: number;
  message: string;
}

export interface ValidationResult {
  manifest: IntakePlanManifest;
  misMapHints: MisMapHint[];
  /** the one reason Run is refused, or null when it may proceed */
  block: { code: string; message: string } | null;
}

export interface ValidateInput {
  sheet: SourceSheet;
  headerRow: number;
  fields: TargetField[];
  bindings: Binding[];
  corrections: IntakeCorrection[];
  exclusions: IntakeExclusion[];
  createdAt: string;
}

/**
 * Coerce + parse every data row against the bound target fields, then assemble
 * the immutable manifest. Every source row lands in EXACTLY ONE current
 * disposition (`valid | rejected | excluded`) and the totals are derived from
 * those dispositions — never summed from the historical event arrays.
 */
export function validateIntake(input: ValidateInput): ValidationResult {
  const { sheet, headerRow, fields, bindings, corrections, exclusions } = input;
  const columns = detectColumns(sheet, headerRow);
  const columnById = new Map(columns.map((c) => [c.sourceColumnId, c]));
  const bindingByField = new Map(bindings.map((b) => [b.targetFieldId, b]));
  const dataRows = sheet.grid.slice(headerRow);
  const excludedRows = new Set(exclusions.map((e) => e.sourceRow));

  const rejects: RowReject[] = [];
  const parsedByRow = new Map<number, Record<string, string>>();
  const failuresByField = new Map<string, number>();

  let rejectSeq = 0;
  const pushReject = (reject: Omit<RowReject, "rejectId">): void => {
    rejectSeq += 1;
    rejects.push({ ...reject, rejectId: `rj-${rejectSeq}` });
  };

  dataRows.forEach((cells, index) => {
    const sourceRow = headerRow + index + 1;
    if (excludedRows.has(sourceRow)) return;

    const parsed: Record<string, string> = {};
    let rowFailed = false;

    for (const field of fields) {
      const binding = bindingByField.get(field.id);
      if (!binding) {
        if (field.required) {
          rowFailed = true;
          pushReject({
            sourceRow,
            kind: "unmapped-required",
            code: "unmapped-required",
            targetFieldId: field.id,
            reason: `${field.label} is required and no column is bound to it. Nothing can be built for this row.`,
          });
        }
        continue;
      }
      const column = columnById.get(binding.sourceColumnId);
      if (!column) continue;

      const correction = corrections.find((c) => c.sourceRow === sourceRow && c.targetFieldId === field.id);
      const raw = correction?.correctedValue ?? cells[column.currentIndex] ?? "";
      const result = coerceCell(field, raw);
      if (!result.ok) {
        failuresByField.set(field.id, (failuresByField.get(field.id) ?? 0) + 1);
        if (field.required) rowFailed = true;
        pushReject({
          sourceRow,
          kind: result.kind,
          code: result.code,
          targetFieldId: field.id,
          column: { header: column.header, sourceColumnId: column.sourceColumnId },
          raw,
          reason: `${sheet.workflow} intake, row ${sourceRow}, column “${column.header}” (→ ${field.id}): ${result.reason}`,
        });
        continue;
      }
      parsed[field.id] = result.value;
    }

    // cross-field: a zero award cannot carry an effective date in a closed period
    if (!rowFailed && parsed.awardAmount === "0.00" && parsed.effectiveDate && parsed.effectiveDate < "2026-07-01") {
      rowFailed = true;
      pushReject({
        sourceRow,
        kind: "cross-field",
        code: "zero-award-closed-period",
        paths: ["awardAmount", "effectiveDate"],
        reason: `Row ${sourceRow}: a $0.00 award cannot take effect on ${parsed.effectiveDate} — that pay period is closed. Correct the amount or the date; the two disagree.`,
      });
    }

    if (!rowFailed) parsedByRow.set(sourceRow, parsed);
  });

  // duplicate identity — computed AFTER exclusions, so excluding one copy
  // genuinely un-rejects the other.
  const byItem = new Map<string, number[]>();
  for (const [sourceRow, parsed] of parsedByRow) {
    const key = parsed.eid ?? `row-${sourceRow}`;
    byItem.set(key, [...(byItem.get(key) ?? []), sourceRow]);
  }
  const duplicated = new Set<number>();
  for (const [key, rows] of byItem) {
    if (rows.length < 2) continue;
    for (const sourceRow of rows) {
      duplicated.add(sourceRow);
      pushReject({
        sourceRow,
        kind: "duplicate-identity",
        code: "duplicate-identity",
        collidingSourceRows: [...rows],
        reason: `Rows ${rows.join(" and ")} are the same person (EID ${key}). Neither can run until one is corrected or excluded — a duplicate is how somebody gets filed twice.`,
      });
    }
  }
  for (const sourceRow of duplicated) parsedByRow.delete(sourceRow);

  const totalSourceRows = dataRows.length;
  const validRows: ManifestValidRow[] = [...parsedByRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sourceRow, parsedInput]) => ({
      sourceRow,
      itemId: `ws:${parsedInput.eid ?? sourceRow}`,
      inputHash: hash16(JSON.stringify(parsedInput)),
      parsedInput,
    }));

  const rejectedRowNumbers = new Set(rejects.map((r) => r.sourceRow).filter((r) => !excludedRows.has(r)));
  const dispositions = Array.from({ length: totalSourceRows }, (_, i) => {
    const sourceRow = headerRow + i + 1;
    if (excludedRows.has(sourceRow)) return { sourceRow, disposition: "excluded" as const, currentRejectIds: [] };
    const valid = validRows.find((v) => v.sourceRow === sourceRow);
    if (valid) return { sourceRow, disposition: "valid" as const, itemId: valid.itemId, currentRejectIds: [] };
    return {
      sourceRow,
      disposition: "rejected" as const,
      currentRejectIds: rejects.filter((r) => r.sourceRow === sourceRow).map((r) => r.rejectId),
    };
  });

  const misMapHints: MisMapHint[] = [];
  for (const [fieldId, failed] of failuresByField) {
    if (failed < totalSourceRows - excludedRows.size || failed === 0) continue;
    const binding = bindingByField.get(fieldId);
    const column = binding ? columnById.get(binding.sourceColumnId) : undefined;
    const field = fields.find((f) => f.id === fieldId);
    if (!column || !field) continue;
    misMapHints.push({
      targetFieldId: fieldId,
      column: column.header,
      failed,
      total: totalSourceRows - excludedRows.size,
      message: `column “${column.header}” is bound to ${field.id} — all ${plural(failed, "row")} failed ${field.kind} coercion. Wrong column?`,
    });
  }

  const mappingFingerprint = headerFingerprint(columns);
  const manifest: IntakePlanManifest = {
    version: 1,
    planId: `plan-${sheet.id}-${hash16(`${mappingFingerprint}${bindings.map((b) => `${b.targetFieldId}=${b.sourceColumnId}`).join(",")}`).slice(0, 4)}`,
    workflow: sheet.workflow,
    source: { artifactId: `art-${sheet.id}`, sha256: sheet.sha256, originalName: sheet.fileName },
    mappingFingerprint,
    mappingSnapshotHash: hash16(bindings.map((b) => `${b.targetFieldId}=${b.sourceColumnId}`).sort().join(",")),
    workflowContractFingerprint: WORKFLOW_CONTRACT_FINGERPRINT[sheet.workflow] ?? "unknown",
    createdAt: input.createdAt,
    totals: {
      sourceRows: totalSourceRows,
      valid: validRows.length,
      rejected: rejectedRowNumbers.size,
      rejectionEvents: rejects.length,
      excluded: excludedRows.size,
      corrected: corrections.length,
    },
    sourceRowDispositions: dispositions,
    validRows,
    rejectedRows: rejects,
    corrections,
    exclusions,
  };

  const unboundRequired = fields.filter((f) => f.required && !bindingByField.has(f.id));
  const unconfirmed = bindings.filter((b) => b.confirmationRequired);

  let block: ValidationResult["block"] = null;
  if (unboundRequired.length > 0) {
    block = {
      code: "required-field-unmapped",
      message: `${unboundRequired.map((f) => f.label).join(", ")} ${unboundRequired.length === 1 ? "is" : "are"} required and unbound. Nothing can run until every required field points at a column.`,
    };
  } else if (unconfirmed.length > 0) {
    block = {
      code: "duplicate-header-unconfirmed",
      message: `${unconfirmed.length} binding${unconfirmed.length === 1 ? "" : "s"} reuse a duplicated heading. Confirm which column is meant — two identical headings are semantically unknowable.`,
    };
  } else if (validRows.length === 0) {
    block = {
      code: "no-valid-rows",
      message: `Not one of the ${totalSourceRows} source rows produced a valid input. A zero-row intake is not a quiet success — nothing will be enqueued, and the plan below stays inspectable so you can see why.`,
    };
  }

  return { manifest, misMapHints, block };
}

// ---------------------------------------------------------------------------
// Rerun diff (§5) — "never label replayed data as newly observed"
// ---------------------------------------------------------------------------

export interface PriorManifestFacts {
  sheetId: string;
  planId: string;
  createdAt: string;
  mappingSnapshotHash: string;
  workflowContractFingerprint: string;
  validRows: { itemId: string; inputHash: string; label: string }[];
  excludedCount: number;
}

/**
 * A prior intake of the same source, as it was recorded. Authored facts only —
 * the diff below is derived by comparing this with a freshly built manifest.
 */
export const PRIOR_MANIFESTS: PriorManifestFacts[] = [
  {
    sheetId: "ws-week-30",
    planId: "plan-ws-week-30-7c1d",
    createdAt: "2026-07-24T16:20:00",
    mappingSnapshotHash: "",
    workflowContractFingerprint: WORKFLOW_CONTRACT_FINGERPRINT["work-study"] ?? "unknown",
    validRows: [
      { itemId: "ws:10091755", inputHash: "", label: "Rosa Iglesias" },
      { itemId: "ws:10077300", inputHash: "", label: "Sujin Park" },
      { itemId: "ws:10068220", inputHash: "", label: "Rita Torres" },
      { itemId: "ws:10071144", inputHash: "", label: "Kwame Boateng" },
      { itemId: "ws:10099001", inputHash: "", label: "Lena Fischer" },
    ],
    excludedCount: 0,
  },
  {
    sheetId: "ws-week-29",
    planId: "plan-ws-week-29-2a80",
    createdAt: "2026-07-18T09:06:00",
    mappingSnapshotHash: "stale-mapping-snapshot",
    workflowContractFingerprint: `ws-v${DEMO_WORKFLOWS["work-study"].version - 1}-8f31`,
    validRows: [
      { itemId: "ws:10084412", inputHash: "", label: "Maria Delgado" },
      { itemId: "ws:10091755", inputHash: "", label: "Rosa Iglesias" },
      { itemId: "ws:10077300", inputHash: "", label: "Sujin Park" },
      { itemId: "ws:10068220", inputHash: "", label: "Rita Torres" },
      { itemId: "ws:10071144", inputHash: "", label: "Kwame Boateng" },
      { itemId: "ws:10093382", inputHash: "", label: "Ana Silva" },
      { itemId: "ws:10088017", inputHash: "", label: "Wei Chen" },
    ],
    excludedCount: 1,
  },
];

export interface RerunDiff {
  prior: PriorManifestFacts;
  added: { itemId: string; label: string }[];
  removed: { itemId: string; label: string }[];
  unchanged: number;
  mappingChanged: boolean;
  contractChanged: boolean;
  /** the one sentence that decides whether a rerun is a replay or a migration */
  verdict: string;
}

export function buildRerunDiff(manifest: IntakePlanManifest, prior: PriorManifestFacts): RerunDiff {
  const priorIds = new Set(prior.validRows.map((r) => r.itemId));
  const currentIds = new Set(manifest.validRows.map((r) => r.itemId));
  const labelOf = (itemId: string): string =>
    manifest.validRows.find((r) => r.itemId === itemId)?.parsedInput.fullName ??
    prior.validRows.find((r) => r.itemId === itemId)?.label ??
    itemId;

  const added = [...currentIds].filter((id) => !priorIds.has(id)).map((itemId) => ({ itemId, label: labelOf(itemId) }));
  const removed = [...priorIds].filter((id) => !currentIds.has(id)).map((itemId) => ({ itemId, label: labelOf(itemId) }));
  const contractChanged = prior.workflowContractFingerprint !== manifest.workflowContractFingerprint;
  const mappingChanged = prior.mappingSnapshotHash !== "" && prior.mappingSnapshotHash !== manifest.mappingSnapshotHash;

  return {
    prior,
    added,
    removed,
    unchanged: [...currentIds].filter((id) => priorIds.has(id)).length,
    mappingChanged,
    contractChanged,
    verdict: contractChanged
      ? `The workflow contract changed since ${prior.planId} was made (${prior.workflowContractFingerprint} → ${manifest.workflowContractFingerprint}). A rerun is a MIGRATION, not a replay: every stored row is revalidated against the current schema before anything is enqueued.`
      : mappingChanged
        ? `Same contract, different mapping. The rows below were rebuilt from the same file under a new column mapping — the values are re-read from the source, not replayed.`
        : `Same contract, same mapping. A rerun replays the stored inputs exactly; nothing here is re-observed, and the receipt will say so.`,
  };
}
