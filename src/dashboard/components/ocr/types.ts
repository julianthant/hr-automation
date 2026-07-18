/**
 * Frontend mirrors of OCR's per-form schemas. No runtime Zod here — these
 * are TypeScript types only, so the dashboard bundle stays slim. Validation
 * lives server-side in src/workflows/{oath-signature,emergency-contact}/ocr-form.ts.
 */

export type MatchState =
  | "extracted"
  | "matched"
  | "lookup-pending"
  | "lookup-running"
  | "resolved"
  | "unresolved";

export type MatchSource = "form" | "roster" | "eid-lookup" | "llm" | "form-eid" | "manual";

export type AddressMatch = "match" | "differ" | "missing";

// ─── Verification (cross-workflow, mirror of backend Zod schema) ─────────
export type Verification =
  | {
      state: "verified";
      hrStatus: string;
      department: string;
      screenshotFilename: string;
      checkedAt: string;
    }
  | {
      state: "inactive";
      hrStatus: string;
      department?: string;
      screenshotFilename: string;
      checkedAt: string;
    }
  | {
      state: "non-hdh";
      hrStatus: string;
      department: string;
      screenshotFilename: string;
      checkedAt: string;
    }
  | { state: "lookup-failed"; error: string; checkedAt: string };

export interface Address {
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}

export interface PreviewEmployee {
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  employeeId: string;
  pid?: string | null;
  jobTitle?: string | null;
  workLocation?: string | null;
  supervisor?: string | null;
  workEmail?: string | null;
  personalEmail?: string | null;
  homeAddress?: Address | null;
  homePhone?: string | null;
  cellPhone?: string | null;
}

export interface PreviewEmergencyContact {
  name: string;
  relationship: string;
  primary: boolean;
  sameAddressAsEmployee: boolean;
  address?: Address | null;
  cellPhone?: string | null;
  homePhone?: string | null;
  workPhone?: string | null;
}

export interface PreviewRecord {
  // The EC OCR pass can classify a page as a non-EC form (oath/unknown) — the
  // backend Zod enum is the same three-way union, so the frontend mirror must
  // match it or an EC-run mis-classification has no type forcing it to be
  // handled (see readonly-record.ts wrong-form hint).
  formKind: "oath" | "emergency-contact" | "unknown";
  sourcePage: number;
  employee: PreviewEmployee;
  emergencyContact: PreviewEmergencyContact;
  notes: string[];
  matchState: MatchState;
  matchSource?: MatchSource;
  matchConfidence?: number;
  rosterCandidates?: Array<{ eid: string; name: string; score: number }>;
  addressMatch?: AddressMatch;
  documentType?: "expected" | "unknown";
  originallyMissing?: string[];
  verification?: Verification;
  selected: boolean;
  warnings: string[];
}

export interface FailedPage {
  page: number;
  error: string;
  attemptedKeys: string[];
  pageImagePath: string;
  attempts: number;
}

export interface PageStatusSummary {
  total: number;
  succeeded: number;
  failed: number;
}

export interface PrepareRowData {
  mode: "prepare";
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  rosterMode: "download" | "existing";
  rosterPath: string;
  pageImagesDir?: string;
  records: PreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
  failedPages?: FailedPage[];
  emptyPages?: number[];
  pageStatusSummary?: PageStatusSummary;
}

/**
 * Workflow-agnostic predicate — downstream parent prep rows stamp
 * `mode: "prepare"`, while the OCR workflow itself is always a prep/review
 * surface and may emit terminal discard rows without carrying data forward.
 */
export function isPrepareRow(e: {
  workflow?: string;
  id?: string;
  data?: Record<string, string>;
}): boolean {
  if (e.workflow === "ocr") return true;
  if (e.id?.startsWith("ocr-prep-")) return true;
  return e.data?.mode === "prepare";
}

/**
 * A prep row in its terminal-resolved state: the operator has either
 * approved (fanned out child queue items) or discarded it. Mirrors
 * `isResolvedPrepEntry` in `src/tracker/dashboard.ts` — kept in lockstep
 * so frontend and backend agree on which rows count as "still
 * actionable" vs "operator-resolved." Used by:
 *   - QueuePanel — filters from the visible queue + StatPills
 *   - App.tsx `retryAllIds` — from bulk queue scope for RetryAllButton (any status)
 *     so discarded prep rows don't get re-enqueued via /api/retry-bulk
 *     (they have `data.mode === "prepare"`, no schema-valid emplId/docId)
 */
export function isResolvedPrepRow(e: {
  workflow?: string;
  id?: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (e.workflow === "ocr") return isDiscardedPrepRow(e);
  return isApprovedPrepRow(e) || isDiscardedPrepRow(e);
}

/**
 * A prep row whose operator-resolved state is "approved" — children have been
 * fanned out into the downstream workflow's queue. Drives `DelegationRow`
 * rendering in the QueuePanel.
 *
 * New approval contract (2026-05-25): an OCR `status="done"` row IS
 * approved (the kernel-path handler suspends at `awaiting-approval` and
 * the orchestrator emits `running` until approve fires; only approve
 * routes terminate the row with `done`). The approve route also writes
 * `step="approved"` explicitly for dashboard readers that key on the
 * operator action, but the kernel's auto-emitted terminal `done` row may
 * carry no step — both classify as approved.
 */
export function isApprovedPrepRow(e: {
  workflow?: string;
  id?: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (!isPrepareRow(e)) return false;
  if (e.status !== "done") return false;
  if (e.step === "approved") return true;
  // OCR `done` without explicit step is the kernel's auto-emitted terminal
  // row after the approval signal fired. Treat as approved.
  return e.workflow === "ocr";
}

/**
 * Any tracker row whose `data.mode === "prepare"` and that is NOT discarded is
 * the persistent batch anchor for an upload-driven workflow (oath-signature,
 * emergency-contact, oath-upload). It owns the dashboard group regardless of
 * pre/post-approval state. OCR-workflow rows are intentionally excluded: those
 * remain flat review surfaces until approved via `isApprovedPrepRow`.
 */
export function isPrepOperationAnchor(e: {
  workflow?: string;
  id?: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (e.workflow === "ocr") return false;
  // Use only the data.mode stamp — not the id-prefix heuristic — to avoid false
  // positives on child rows whose ids happen to start with "ocr-prep-".
  if (e.data?.mode !== "prepare") return false;
  return !isDiscardedPrepRow(e);
}

/**
 * A prep row the operator discarded. Filtered out of the QueuePanel entirely.
 * Distinct from a genuinely-failed prep row (e.g. OCR error), which stays
 * visible as an OCR review row so the operator can retry.
 */
export function isDiscardedPrepRow(e: {
  workflow?: string;
  id?: string;
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (!isPrepareRow(e)) return false;
  return e.status === "failed" && e.step === "discarded";
}

/**
 * Pull a `PrepareRowData` out of a tracker entry's `data` field. Returns
 * `null` when the entry isn't a prep row (no `mode === "prepare"`) or the
 * records JSON doesn't parse. The dashboard SSE flattens `records` to a
 * JSON string in `data.records` (see `flattenForData` in
 * src/workflows/emergency-contact/prepare.ts), so we re-hydrate it here.
 */
// ── Row-data JSON field parsers (the single any→unknown seam) ────────────────
// The four prep-row parsers below re-hydrate the same serialized fields; these
// helpers keep the JSON.parse boundary typed as `unknown` + narrowed once.

/** Serialized record array. `null` = corrupt JSON (caller drops the row); non-array JSON = `[]`. */
function parseRecordsField<T>(raw: string | undefined): T[] | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return null;
  }
}

function parseFailedPagesField(raw: string | undefined): FailedPage[] | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FailedPage[]) : undefined;
  } catch {
    return undefined; // tolerate
  }
}

function parsePageStatusSummaryField(raw: string | undefined): PageStatusSummary | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { total?: unknown }).total === "number") {
      return parsed as PageStatusSummary;
    }
    return undefined;
  } catch {
    return undefined; // tolerate
  }
}

function parseEmptyPagesField(raw: string | undefined): number[] | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === "number")
      : undefined;
  } catch {
    return undefined; // tolerate — pre-feature row
  }
}

export function parsePrepareRowData(
  rawData: Record<string, string> | undefined,
): PrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  const records = parseRecordsField<PreviewRecord>(rawData.records);
  if (records === null) return null;
  const failedPages = parseFailedPagesField(rawData.failedPages);
  const pageStatusSummary = parsePageStatusSummaryField(rawData.pageStatusSummary);
  const emptyPages = parseEmptyPagesField(rawData.emptyPages);
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    pdfFileId: rawData.pdfFileId || undefined,
    rosterMode: rawData.rosterMode === "download" ? "download" : "existing",
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
    failedPages,
    emptyPages,
    pageStatusSummary,
  };
}

/**
 * Static set of UCPath relationship values (the dropdown's option labels —
 * user-visible text). Mirrors `RELATIONSHIP_MAP` values in
 * `src/workflows/emergency-contact/config.ts`. Kept frontend-side so the
 * edit form can populate the relationship dropdown without a roundtrip.
 */
export const RELATIONSHIP_OPTIONS: string[] = [
  "Parent",
  "Sibling",
  "Spouse",
  "Domestic Partner Adult",
  "Domestic Partner Child",
  "Child",
  "Grandchild",
  "Grand Parent",
  "Other Relative",
  "Friend",
  "Neighbor",
  "Roommate",
  "Ward",
  "Medical Provider",
  "Emerg/Detention/Arrest Contact",
  "Contact if Detained/Arrested",
  "Other",
];

// ─── Verify types (mixed oath + emergency-contact completeness report) ──

export interface VerifyCheck {
  /** "name" | "eid" | "employmentDate" | "oathDate" | "officialSigner" | "activeStatus" */
  key: string;
  label: string;
  /** Present on the scanned form. */
  onPaper: boolean;
  paperValue: string | null;
  /** Looked-up value (CRM / UCPath / i9). */
  foundValue: string | null;
  source: "paper" | "crm" | "ucpath" | "i9" | "roster" | null;
  /** present=on paper; found=blank but looked up; missing=blank+not found. */
  status: "present" | "found" | "missing";
  /**
   * Set on a `missing` lookup-backed check when the lookup couldn't ACCESS the
   * record (vs. genuinely not finding it) — the I-9 signer when the operator's
   * account lacks permission. Renders "Unable to access" instead of
   * "— not found"; the retry stays available.
   */
  unavailable?: boolean;
  /**
   * Literal text to show for a `missing` check instead of the default
   * "— not found" — used for paper booleans whose blank state carries meaning
   * (e.g. "Employee Signed?" → "No"). Not lookup-backed, so no retry button.
   */
  missingLabel?: string;
}

/**
 * Which background lookup populates a verify check — the two enrichment
 * fan-outs in `verify`'s `enrichRecords` hook. `person` is person-lookup
 * (name / EID / active status / CRM employment + oath dates); `i9` is
 * i9-lookup (the Section-2 "Authorized Official Signer"). Drives the per-check
 * retry button (`/api/ocr/verify-relookup`) so a failed lookup can be re-run
 * individually. Mirrors `VerifyRelookupKind` in
 * `src/workflows/ocr/verify-relookup.ts`.
 */
export type VerifyLookupKind = "person" | "i9";

/** Map a `VerifyCheck.key` to the lookup that fills it, or null if on-paper-only. */
export function verifyCheckLookupKind(key: string): VerifyLookupKind | null {
  if (key === "officialSigner") return "i9";
  if (
    key === "name" ||
    key === "eid" ||
    key === "employmentDate" ||
    key === "oathDate" ||
    key === "activeStatus"
  ) {
    return "person";
  }
  return null;
}

export interface VerifyPreviewRecord {
  formKind: "oath" | "emergency-contact" | "unknown";
  sourcePage: number;
  printedName?: string | null;
  /** EID as read directly from the paper before person-lookup may overwrite employeeId. */
  paperEmployeeId?: string;
  /** Resolved EID. */
  employeeId: string;
  /** Resolved name (falls back to printedName). */
  name: string;
  paperEmploymentDate?: string | null;
  paperDateSigned?: string | null;
  employeeSigned?: boolean | null;
  officerSigned?: boolean | null;
  paperOfficialName?: string | null;
  activeStatus?: string;
  /** State of the verify person-lookup child that enriched this record. */
  personLookupStatus?: "pending" | "running" | "completed" | "failed";
  /** Trace id of the verify person-lookup child that enriched this record. */
  personLookupTraceId?: string;
  /** State of the verify i9-lookup child that enriched the official signer. */
  i9LookupStatus?: "pending" | "running" | "completed" | "failed";
  /** Trace id of the verify i9-lookup child that enriched the official signer. */
  i9LookupTraceId?: string;
  /** CRM First Day of Service. */
  employmentDate?: string;
  /** CRM Date Signed. */
  oathDate?: string;
  /** I-9 Section 2 signer. */
  officialSigner?: string;
  /** i9-lookup status — `unable-to-access` drives the check's "Unable to access". */
  officialSignerStatus?: string;
  matchState: MatchState;
  selected: boolean;
  warnings: string[];
  originallyMissing?: string[];
  documentType?: "expected" | "unknown";
  checks: VerifyCheck[];
  /**
   * LLM-disambiguation confidence (0–1) the match was resolved at. Only
   * populated when this record is a read-only projection of a standalone
   * oath/EC record (`readonly-record.ts`'s `toReadonlyVerifyRecord`) — a
   * native `verify` run resolves identity via lookup, not LLM
   * disambiguation, so it has none. Carried through so a post-hoc audit of
   * an approved record can see what confidence it was approved at.
   */
  matchConfidence?: number;
}

export interface VerifyPrepareRowData {
  mode: "prepare";
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  rosterMode: "download" | "existing";
  rosterPath: string;
  pageImagesDir?: string;
  records: VerifyPreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
  failedPages?: FailedPage[];
  emptyPages?: number[];
  pageStatusSummary?: PageStatusSummary;
}

export function parseVerifyPrepareRowData(
  rawData: Record<string, string> | undefined,
): VerifyPrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  const records = parseRecordsField<VerifyPreviewRecord>(rawData.records);
  if (records === null) return null;
  const failedPages = parseFailedPagesField(rawData.failedPages);
  const pageStatusSummary = parsePageStatusSummaryField(rawData.pageStatusSummary);
  const emptyPages = parseEmptyPagesField(rawData.emptyPages);
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    pdfFileId: rawData.pdfFileId || undefined,
    rosterMode: rawData.rosterMode === "download" ? "download" : "existing",
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
    failedPages,
    emptyPages,
    pageStatusSummary,
  };
}

// ─── I-9 types (UCPath person-check completeness report) ──────────

/**
 * One I-9 record (one Section-1 page of a scanned I-9 packet), enriched by the
 * `i9` form spec's person-match fan-out. Mirrors the server-side
 * `I9PreviewRecordSchema` (`src/services/ocr/forms/i9.ts`). Renders through
 * `VerifyRecordView` — it carries the same `checks` / `matchState` /
 * `warnings` fields the completeness report reads.
 */
export interface I9PreviewRecord {
  /** `"i9"` = legacy pre-2026-07-17 rows (Section 1 pages). */
  formKind: "i9 section 1" | "i9 section 2" | "i9 ssn" | "i9" | "unknown";
  sourcePage: number;
  lastName?: string | null;
  firstName?: string | null;
  middleInitial?: string | null;
  /** Section 1 date of birth, as printed. */
  dateOfBirth?: string | null;
  /** Section 1 SSN, as printed. */
  ssn?: string | null;
  /** Display name ("Last, First M") assembled from the Section 1 name fields. */
  name: string;
  /** UCPath person-search outcome — true found, false definitively not found. */
  ucpathFound?: boolean;
  matchedEmplId?: string;
  matchedName?: string;
  /** State of the person-match child that enriched this record. */
  personMatchStatus?: "pending" | "running" | "completed" | "failed";
  /** Trace id of the person-match child that enriched this record. */
  personMatchTraceId?: string;
  matchState: MatchState;
  selected: boolean;
  warnings: string[];
  originallyMissing?: string[];
  documentType?: "expected" | "unknown";
  checks: VerifyCheck[];
  matchConfidence?: number;
}

export interface I9PrepareRowData {
  mode: "prepare";
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  rosterMode: "download" | "existing";
  rosterPath: string;
  pageImagesDir?: string;
  records: I9PreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
  failedPages?: FailedPage[];
  emptyPages?: number[];
  pageStatusSummary?: PageStatusSummary;
}

export function parseI9PrepareRowData(
  rawData: Record<string, string> | undefined,
): I9PrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  const records = parseRecordsField<I9PreviewRecord>(rawData.records);
  if (records === null) return null;
  const failedPages = parseFailedPagesField(rawData.failedPages);
  const pageStatusSummary = parsePageStatusSummaryField(rawData.pageStatusSummary);
  const emptyPages = parseEmptyPagesField(rawData.emptyPages);
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    pdfFileId: rawData.pdfFileId || undefined,
    rosterMode: rawData.rosterMode === "download" ? "download" : "existing",
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
    failedPages,
    emptyPages,
    pageStatusSummary,
  };
}

// ─── Oath-signature types (was oath-preview-types.ts) ──────────────

export type OathMatchState =
  | "extracted"
  | "matched"
  | "lookup-pending"
  | "lookup-running"
  | "resolved"
  | "unresolved";

export type OathMatchSource = "roster" | "eid-lookup" | "llm" | "form-eid" | "manual";

export interface OathPreviewRecord {
  formKind: "oath" | "emergency-contact" | "unknown";
  sourcePage: number;
  rowIndex: number;
  printedName: string;
  firstName?: string | null;
  lastName?: string | null;
  employeeSigned: boolean;
  officerSigned?: boolean | null;
  dateSigned: string | null;
  notes: string[];
  employeeId: string;
  matchState: OathMatchState;
  matchSource?: OathMatchSource;
  matchConfidence?: number;
  rosterCandidates?: Array<{ eid: string; name: string; score: number }>;
  documentType?: "expected" | "unknown";
  originallyMissing?: string[];
  verification?: Verification;
  selected: boolean;
  warnings: string[];
}

export interface OathPrepareRowData {
  mode: "prepare";
  pdfPath: string;
  pdfOriginalName: string;
  pdfFileId?: string;
  rosterPath: string;
  pageImagesDir?: string;
  records: OathPreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
  failedPages?: FailedPage[];
  emptyPages?: number[];
  pageStatusSummary?: PageStatusSummary;
}

export function parseOathPrepareRowData(
  rawData: Record<string, string> | undefined,
): OathPrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  const records = parseRecordsField<OathPreviewRecord>(rawData.records);
  if (records === null) return null;
  const failedPages = parseFailedPagesField(rawData.failedPages);
  const pageStatusSummary = parsePageStatusSummaryField(rawData.pageStatusSummary);
  const emptyPages = parseEmptyPagesField(rawData.emptyPages);
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    pdfFileId: rawData.pdfFileId || undefined,
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
    failedPages,
    emptyPages,
    pageStatusSummary,
  };
}
