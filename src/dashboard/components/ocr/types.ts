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

export type MatchSource = "form" | "roster" | "eid-lookup" | "llm";

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
}

export interface PreviewEmployee {
  name: string;
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
  rosterMode: "download" | "existing";
  rosterPath: string;
  pageImagesDir?: string;
  records: PreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
  failedPages?: FailedPage[];
  pageStatusSummary?: PageStatusSummary;
}

/**
 * Workflow-agnostic predicate — both emergency-contact and oath-signature
 * stamp `mode: "prepare"` on parent prep rows.
 */
export function isPrepareRow(e: { data?: Record<string, string> }): boolean {
  return e.data?.mode === "prepare";
}

/**
 * A prep row in its terminal-resolved state: the operator has either
 * approved (fanned out child queue items) or discarded it. Mirrors
 * `isResolvedPrepEntry` in `src/tracker/dashboard.ts` — kept in lockstep
 * so frontend and backend agree on which rows count as "still
 * actionable" vs "operator-resolved." Used by:
 *   - QueuePanel — filters from the visible queue + StatPills
 *   - App.tsx `failedIds` — filters from RetryAllButton's count + targets
 *     so discarded prep rows don't get re-enqueued via /api/retry-bulk
 *     (they have `data.mode === "prepare"`, no schema-valid emplId/docId)
 */
export function isResolvedPrepRow(e: {
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  return isApprovedPrepRow(e) || isDiscardedPrepRow(e);
}

/**
 * A prep row whose operator-resolved state is "approved" — children have been
 * fanned out into the downstream workflow's queue. Drives `ParentChildRow`
 * rendering in the QueuePanel.
 */
export function isApprovedPrepRow(e: {
  status: string;
  step?: string;
  data?: Record<string, string>;
}): boolean {
  if (!isPrepareRow(e)) return false;
  return e.status === "done" && e.step === "approved";
}

/**
 * A prep row the operator discarded. Filtered out of the QueuePanel entirely.
 * Distinct from a genuinely-failed prep row (e.g. OCR error), which stays
 * visible as an `OcrQueueRow` so the operator can retry.
 */
export function isDiscardedPrepRow(e: {
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
export function parsePrepareRowData(
  rawData: Record<string, string> | undefined,
): PrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  let records: PreviewRecord[] = [];
  try {
    const parsed = JSON.parse(rawData.records ?? "[]");
    if (Array.isArray(parsed)) records = parsed as PreviewRecord[];
  } catch {
    return null;
  }
  let failedPages: FailedPage[] | undefined;
  try {
    if (typeof rawData.failedPages === "string") {
      const parsed = JSON.parse(rawData.failedPages);
      if (Array.isArray(parsed)) failedPages = parsed as FailedPage[];
    }
  } catch { /* tolerate */ }
  let pageStatusSummary: PageStatusSummary | undefined;
  try {
    if (typeof rawData.pageStatusSummary === "string") {
      const parsed = JSON.parse(rawData.pageStatusSummary);
      if (parsed && typeof parsed.total === "number") pageStatusSummary = parsed as PageStatusSummary;
    }
  } catch { /* tolerate */ }
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    rosterMode: rawData.rosterMode === "download" ? "download" : "existing",
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
    failedPages,
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

// ─── Oath-signature types (was oath-preview-types.ts) ──────────────

export type OathMatchState =
  | "extracted"
  | "matched"
  | "lookup-pending"
  | "lookup-running"
  | "resolved"
  | "unresolved";

export type OathMatchSource = "roster" | "eid-lookup" | "llm";

export interface OathPreviewRecord {
  sourcePage: number;
  rowIndex: number;
  printedName: string;
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
  rosterPath: string;
  pageImagesDir?: string;
  records: OathPreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
  failedPages?: FailedPage[];
  pageStatusSummary?: PageStatusSummary;
}

export function parseOathPrepareRowData(
  rawData: Record<string, string> | undefined,
): OathPrepareRowData | null {
  if (!rawData) return null;
  if (rawData.mode !== "prepare") return null;
  let records: OathPreviewRecord[] = [];
  try {
    const parsed = JSON.parse(rawData.records ?? "[]");
    if (Array.isArray(parsed)) records = parsed as OathPreviewRecord[];
  } catch {
    return null;
  }
  let failedPages: FailedPage[] | undefined;
  try {
    if (typeof rawData.failedPages === "string") {
      const parsed = JSON.parse(rawData.failedPages);
      if (Array.isArray(parsed)) failedPages = parsed as FailedPage[];
    }
  } catch { /* tolerate */ }
  let pageStatusSummary: PageStatusSummary | undefined;
  try {
    if (typeof rawData.pageStatusSummary === "string") {
      const parsed = JSON.parse(rawData.pageStatusSummary);
      if (parsed && typeof parsed.total === "number") pageStatusSummary = parsed as PageStatusSummary;
    }
  } catch { /* tolerate */ }
  return {
    mode: "prepare",
    pdfPath: rawData.pdfPath ?? "",
    pdfOriginalName: rawData.pdfOriginalName ?? "",
    rosterPath: rawData.rosterPath ?? "",
    pageImagesDir: rawData.pageImagesDir || undefined,
    records,
    ocrProvider: rawData.ocrProvider,
    ocrAttempts: rawData.ocrAttempts ? Number(rawData.ocrAttempts) : undefined,
    ocrCached: rawData.ocrCached === "true",
    failedPages,
    pageStatusSummary,
  };
}
