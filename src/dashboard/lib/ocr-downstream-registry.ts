import type { ReactNode } from "react";
import { resolveOcrPersonDisplayName } from "../../domain/identity/ocr-person-name.js";
import type { OcrRecordLookupTracker } from "../components/ocr/lookup-status";
import {
  parseI9PrepareRowData,
  parseOathPrepareRowData,
  parsePrepareRowData,
  parseVerifyPrepareRowData,
  type I9PreviewRecord,
  type OathPreviewRecord,
  type PreviewRecord,
  type VerifyLookupKind,
  type VerifyPreviewRecord,
} from "../components/ocr/types";

export type AnyOcrPreviewRecord =
  | PreviewRecord
  | OathPreviewRecord
  | VerifyPreviewRecord
  | I9PreviewRecord;

export interface ParsedOcrPrepareRow {
  records: ReadonlyArray<AnyOcrPreviewRecord>;
  pdfOriginalName?: string;
  pdfFileId?: string;
}

/**
 * Per-workflow configuration for the OCR review pane and prep queue row.
 * Encodes everything that used to be scattered across `isOath` ternaries
 * and `as` casts in OcrReviewPane / usePrepCursor.
 *
 * Three entries today: `ocr` (the OCR workflow's own prep rows), and the
 * two downstream targets `emergency-contact` + `oath-signature`. Adding a
 * new prep-row-emitting workflow = one entry below; the components stay
 * untouched.
 */
export interface OcrDownstreamConfig {
  /** Which OCR form variant this config produces records for. Drives addBlankRow's variant branch. */
  formKind: "oath" | "emergency-contact" | "verify" | "i9";
  /** Parser for the prep row's serialized records / PDF metadata. */
  parseRow: (data: Record<string, string> | undefined) => ParsedOcrPrepareRow | null;
  /** POST endpoint that fans out N kernel queue items on Approve. */
  approveUrl: string;
  /** POST endpoint that marks the prep row failed/discarded. */
  discardUrl: string;
  /** localStorage key for this row's per-record edits. */
  editsKey: (ids: { sessionId: string; runId: string }) => string;
  /** localStorage key for this row's scroll-cursor restore. */
  cursorKey: (ids: { sessionId: string; runId: string }) => string;
  /** Records carry signature fields → renders signature badges + banners. */
  hasSignature: boolean;
  /** Enables per-record force-research (`/api/ocr/force-research`) when true. */
  supportsForceResearch: boolean;
  /** Display name for a record — drives the form-card header. */
  recordName: (record: AnyOcrPreviewRecord) => string;
  /**
   * Per-record editor view. Set via `setOcrDownstreamRenderer` so the registry
   * stays a plain `.ts` file (no TSX). Concrete renderers register at module
   * load from `OcrReviewPane.tsx`.
   */
  renderEditor: (args: {
    record: AnyOcrPreviewRecord;
    onChange: (next: AnyOcrPreviewRecord) => void;
    /** Re-run lookups for this record (OCR pane only — `/api/ocr/force-research`). */
    onForceResearch?: (record: AnyOcrPreviewRecord) => void;
    isResearching?: boolean;
    /** Verify-only: re-run ONE background lookup for this record (`/api/ocr/verify-relookup`). */
    onRelookup?: (lookup: VerifyLookupKind) => void;
    /** Verify-only: which lookups are currently re-running for this record. */
    relookupPending?: ReadonlySet<VerifyLookupKind>;
    /** Current row-level lookup state from the OCR preview wrapper. */
    lookupTracker?: OcrRecordLookupTracker;
  }) => ReactNode;
}

const ocrDownstreamRegistry: Record<string, OcrDownstreamConfig> = {};

export function registerOcrDownstream(
  workflow: string,
  config: OcrDownstreamConfig,
): void {
  ocrDownstreamRegistry[workflow] = config;
}

/** Throws if the workflow has no entry — fail-loud per project convention. */
export function getOcrDownstream(workflow: string): OcrDownstreamConfig {
  const cfg = ocrDownstreamRegistry[workflow];
  if (!cfg) {
    throw new Error(
      `No OCR downstream config registered for workflow="${workflow}". ` +
        `Add an entry in src/dashboard/lib/ocr-downstream-registry.ts.`,
    );
  }
  return cfg;
}

export function hasOcrDownstream(workflow: string): boolean {
  return workflow in ocrDownstreamRegistry;
}

/**
 * Resolve the right per-form config for an OCR-workflow tracker row.
 * The OCR workflow hosts multiple form types (oath, emergency-contact);
 * the records on a row are shaped per `data.formType`, so we route to
 * oath-signature's or emergency-contact's parser+renderer accordingly.
 * Force-research is OCR-workflow-only — overlay onto the resolved
 * per-form config so `/api/ocr/force-research` is offered per record.
 */
export function resolveOcrConfigForEntry(entry: {
  workflow: string;
  data?: Record<string, string>;
}): OcrDownstreamConfig | null {
  if (entry.workflow !== "ocr") {
    return hasOcrDownstream(entry.workflow) ? getOcrDownstream(entry.workflow) : null;
  }
  const formType = entry.data?.formType;
  if (formType === "verify") {
    if (!hasOcrDownstream("verify")) return null;
    // verify is read-only — no force-research overlay.
    return getOcrDownstream("verify");
  }
  if (formType === "i9") {
    if (!hasOcrDownstream("i9")) return null;
    // i9 is read-only (UCPath person-check report) — no force-research overlay.
    return getOcrDownstream("i9");
  }
  if (
    formType !== "oath" &&
    formType !== "emergency-contact" &&
    formType !== "onbase-emergency-contact"
  ) {
    console.warn(`resolveOcrConfigForEntry: unknown formType "${String(formType)}" — returning null`);
    return null;
  }
  // onbase-emergency-contact records are EC-shaped — render with EC's view.
  const key = formType === "oath" ? "oath-signature" : "emergency-contact";
  if (!hasOcrDownstream(key)) return null;
  const base = getOcrDownstream(key);
  return { ...base, supportsForceResearch: true };
}

/**
 * Wire a per-record editor view into a previously-registered config.
 * Called once at module load from `OcrReviewPane.tsx` so this file stays
 * import-free of TSX and avoids a circular dep on `components/ocr/`.
 */
export function setOcrDownstreamRenderer(
  workflow: string,
  renderer: OcrDownstreamConfig["renderEditor"],
): void {
  const cfg = ocrDownstreamRegistry[workflow];
  if (!cfg) {
    throw new Error(
      `setOcrDownstreamRenderer: workflow="${workflow}" not registered`,
    );
  }
  cfg.renderEditor = renderer;
}

// ─── Built-in registrations ──────────────────────────────────────────────

const noopRenderer: OcrDownstreamConfig["renderEditor"] = (_args) => null;

/**
 * Display name for an EC-shaped record (employee first/last/full name).
 * Shared by the `ocr` and `emergency-contact` registrations below.
 */
const employeeRecordName: OcrDownstreamConfig["recordName"] = (r) =>
  (r.formKind === "emergency-contact"
    ? resolveOcrPersonDisplayName({
        firstName: (r as PreviewRecord).employee?.firstName,
        lastName: (r as PreviewRecord).employee?.lastName,
        fullName: (r as PreviewRecord).employee?.name,
      })
    : "") || "(no name)";

/**
 * The OCR workflow's own prep row. Uses the EC record shape (current
 * downstream is hardcoded to emergency-contact) but with session-scoped
 * edits storage so the operator's edits survive a row reupload.
 */
// All approve/discard requests now hit the unified `/api/ocr/*` endpoints.
// The legacy per-workflow routes (`/api/emergency-contact/*`,
// `/api/oath-signature/*`) were removed 2026-05-01 in the OCR consolidation;
// the OCR backend dispatches to the right downstream daemon based on the
// row's `data.formType`.
const OCR_APPROVE_URL = "/api/ocr/approve-batch";
const OCR_DISCARD_URL = "/api/ocr/discard-prepare";

registerOcrDownstream("ocr", {
  formKind: "emergency-contact",
  parseRow: parsePrepareRowData,
  approveUrl: OCR_APPROVE_URL,
  discardUrl: OCR_DISCARD_URL,
  editsKey: ({ sessionId }) => `ocr-edits:${sessionId}`,
  cursorKey: ({ runId }) => `ec-prep-cursor:${runId}`,
  hasSignature: false,
  supportsForceResearch: true,
  recordName: employeeRecordName,
  renderEditor: noopRenderer,
});

registerOcrDownstream("emergency-contact", {
  formKind: "emergency-contact",
  parseRow: parsePrepareRowData,
  approveUrl: OCR_APPROVE_URL,
  discardUrl: OCR_DISCARD_URL,
  editsKey: ({ runId }) => `ec-prep-edits:${runId}`,
  cursorKey: ({ runId }) => `ec-prep-cursor:${runId}`,
  hasSignature: false,
  supportsForceResearch: false,
  recordName: employeeRecordName,
  renderEditor: noopRenderer,
});

registerOcrDownstream("oath-signature", {
  formKind: "oath",
  parseRow: parseOathPrepareRowData,
  approveUrl: OCR_APPROVE_URL,
  discardUrl: OCR_DISCARD_URL,
  editsKey: ({ runId }) => `oath-prep-edits:${runId}`,
  cursorKey: ({ runId }) => `oath-prep-cursor:${runId}`,
  hasSignature: true,
  supportsForceResearch: false,
  // Narrow by SHAPE (printedName presence), not formKind: the EC PreviewRecord's
  // formKind is now the same 3-way union, so `=== "oath"` no longer discriminates
  // the union member. An oath OCR run always produces oath-shaped records here.
  recordName: (r) =>
    ("printedName" in r
      ? resolveOcrPersonDisplayName({
          firstName: (r as OathPreviewRecord).firstName,
          lastName: (r as OathPreviewRecord).lastName,
          fullName: (r as OathPreviewRecord).printedName,
        })
      : "") || "(no name)",
  renderEditor: noopRenderer,
});

registerOcrDownstream("verify", {
  formKind: "verify",
  parseRow: parseVerifyPrepareRowData,
  approveUrl: OCR_APPROVE_URL,
  discardUrl: OCR_DISCARD_URL,
  editsKey: ({ runId }) => `verify-prep-edits:${runId}`,
  cursorKey: ({ runId }) => `verify-prep-cursor:${runId}`,
  hasSignature: false,
  supportsForceResearch: false,
  recordName: (r) => ("checks" in r ? (r).name || "(no name)" : "(no name)"),
  renderEditor: noopRenderer,
});

registerOcrDownstream("i9", {
  formKind: "i9",
  parseRow: parseI9PrepareRowData,
  approveUrl: OCR_APPROVE_URL,
  discardUrl: OCR_DISCARD_URL,
  editsKey: ({ runId }) => `i9-prep-edits:${runId}`,
  cursorKey: ({ runId }) => `i9-prep-cursor:${runId}`,
  hasSignature: false,
  supportsForceResearch: false,
  recordName: (r) => ("checks" in r ? (r).name || "(no name)" : "(no name)"),
  renderEditor: noopRenderer,
});
