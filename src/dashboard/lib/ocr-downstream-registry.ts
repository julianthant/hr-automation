import type { ReactNode } from "react";
import {
  parseOathPrepareRowData,
  parsePrepareRowData,
  type OathPreviewRecord,
  type PreviewRecord,
} from "../components/ocr/types";

export type AnyOcrPreviewRecord = PreviewRecord | OathPreviewRecord;

export interface ParsedOcrPrepareRow {
  records: ReadonlyArray<AnyOcrPreviewRecord>;
  pdfOriginalName?: string;
}

/**
 * Per-workflow configuration for the OCR review pane and prep queue row.
 * Encodes everything that used to be scattered across `isOath` ternaries
 * and `as` casts in OcrReviewPane / OcrQueueRow / usePrepCursor.
 *
 * Three entries today: `ocr` (the OCR workflow's own prep rows), and the
 * two downstream targets `emergency-contact` + `oath-signature`. Adding a
 * new prep-row-emitting workflow = one entry below; the components stay
 * untouched.
 */
export interface OcrDownstreamConfig {
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
  /** Pane shows the "Re-research all" toolbar (only for the OCR workflow). */
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

const noopRenderer: OcrDownstreamConfig["renderEditor"] = () => null;

/**
 * The OCR workflow's own prep row. Uses the EC record shape (current
 * downstream is hardcoded to emergency-contact) but with session-scoped
 * edits storage so the operator's edits survive a row reupload.
 */
registerOcrDownstream("ocr", {
  parseRow: parsePrepareRowData,
  approveUrl: "/api/emergency-contact/approve-batch",
  discardUrl: "/api/emergency-contact/discard-prepare",
  editsKey: ({ sessionId }) => `ocr-edits:${sessionId}`,
  cursorKey: ({ runId }) => `ec-prep-cursor:${runId}`,
  hasSignature: false,
  supportsForceResearch: true,
  recordName: (r) => (r as PreviewRecord).employee?.name || "(no name)",
  renderEditor: noopRenderer,
});

registerOcrDownstream("emergency-contact", {
  parseRow: parsePrepareRowData,
  approveUrl: "/api/emergency-contact/approve-batch",
  discardUrl: "/api/emergency-contact/discard-prepare",
  editsKey: ({ runId }) => `ec-prep-edits:${runId}`,
  cursorKey: ({ runId }) => `ec-prep-cursor:${runId}`,
  hasSignature: false,
  supportsForceResearch: false,
  recordName: (r) => (r as PreviewRecord).employee?.name || "(no name)",
  renderEditor: noopRenderer,
});

registerOcrDownstream("oath-signature", {
  parseRow: parseOathPrepareRowData,
  approveUrl: "/api/oath-signature/approve-batch",
  discardUrl: "/api/oath-signature/discard-prepare",
  editsKey: ({ runId }) => `oath-prep-edits:${runId}`,
  cursorKey: ({ runId }) => `oath-prep-cursor:${runId}`,
  hasSignature: true,
  supportsForceResearch: false,
  recordName: (r) => (r as OathPreviewRecord).printedName || "(no name)",
  renderEditor: noopRenderer,
});
