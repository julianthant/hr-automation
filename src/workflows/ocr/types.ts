/**
 * Per-form-type contract for OCR. Consumer workflows (oath-signature,
 * emergency-contact) declare an `OcrFormSpec` and OCR's orchestrator runs it
 * generically — no per-form branches in the orchestrator.
 *
 * Domain knowledge (signed/unsigned semantics for oath; address-compare for
 * EC) lives with the consumer workflow. OCR has a thin registry that imports
 * each spec — see `src/workflows/ocr/form-registry.ts`.
 */
import type { ZodType } from "zod/v4";

/** A single roster row, as loaded by `src/match/`. Shape mirrors RosterRow used today. */
export interface RosterRow {
  eid: string;
  name: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  // (other fields are tolerated; orchestrator passes the row through to
  // spec.matchRecord which decides what to read.)
}

export type LookupKind = "name" | "verify" | "verify-only" | null;

export interface OcrFormSpec<TOcr, TPreview, TFanOut> {
  /** Stable id matching the form-type picker value. e.g. "oath", "emergency-contact". */
  formType: string;

  /** Human label for the run modal picker. */
  label: string;

  /** Short description shown under the picker option. */
  description: string;

  /** OCR prompt sent to the LLM. */
  prompt: string;

  /** Per-record schema (LLM-permissive — eid optional, etc.). */
  ocrRecordSchema: ZodType<TOcr>;

  /** Array form for the whole-PDF fallback path. = z.array(ocrRecordSchema). */
  ocrArraySchema: ZodType<TOcr[]>;

  /** Cache key segment fed into OCR's content cache. */
  schemaName: string;

  /** Take an OCR record + roster, return the preview record + initial matchState. May call an LLM disambiguator (async). */
  matchRecord(input: { record: TOcr; roster: RosterRow[] }): Promise<TPreview>;

  /**
   * Patch a preview record with the result of post-match LLM disambiguation.
   * Called by the orchestrator's `disambiguating` phase only when matchRecord
   * left the record in `lookup-pending` state with disambiguation candidates.
   * Specs that don't disambiguate may return the record unchanged.
   */
  applyDisambiguation(input: {
    record: TPreview;
    result: { eid: string | null; confidence: number };
  }): TPreview;

  /** Whether this preview record needs an eid-lookup pass. */
  needsLookup(record: TPreview): LookupKind;

  /** Carry-forward fuzzy-match key (Levenshtein on this string with threshold ≤ 2). */
  carryForwardKey(record: TPreview): string;

  /** Apply v1's resolved fields onto a v2 record. Returns the patched record. */
  applyCarryForward(input: { v2: TPreview; v1: TPreview }): TPreview;

  /** Whether v1's `forceResearch` flag was set on the matched record (skips carry-forward). */
  isForceResearchFlag(record: TPreview): boolean;

  /** Approve fan-out target. */
  approveTo: {
    workflow: string;                                              // "oath-signature", "emergency-contact"
    deriveInput: (record: TPreview) => TFanOut;
    deriveItemId: (record: TPreview, parentRunId: string, index: number) => string;
  };

  /** React component reference for per-record preview rendering. Looked up frontend-side. */
  recordRendererId: "OathRecordView" | "EcRecordView" | (string & {});

  /** Whether to require a roster on disk before starting OCR. */
  rosterMode: "required" | "optional";
}

/** Convenience union — used by callers that don't care about generics. */
export type AnyOcrFormSpec = OcrFormSpec<unknown, unknown, unknown>;
