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
import type { RunOptions } from "../../domain/run-options.js";

/** A single roster row, as loaded by `src/services/matching/`. Shape mirrors RosterRow used today. */
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

/**
 * Document-level context passed to `approveTo.deriveInput` alongside each
 * record. The record carries per-person fields; this carries the shared
 * document context (PDF identity, session/run ids) the approve route reads off
 * the OCR review row. Most specs ignore it (oath/EC derive their input from the
 * record alone); `onbase` needs `pdfFileId` so each per-person import can split
 * its page out of the combined PDF.
 */
export interface OcrApproveRecordContext {
  /** OCR session id (stable across the run). */
  sessionId: string;
  /** OCR run id (the `id`/`runId` of the approved OCR row). */
  runId: string;
  /** The delegating parent/operation run id, when delegated. */
  parentRunId?: string;
  /** Original uploaded PDF filename (display). */
  pdfOriginalName?: string;
  /** Registered file id for the uploaded (combined) PDF. */
  pdfFileId?: string;
  /** Absolute path to the uploaded PDF on disk, when known. */
  pdfPath?: string;
}

/**
 * The per-document context handed to `approveDocumentTo.deriveInput`. Built by
 * the approve route after the per-record (`approveTo`) fan-out so the
 * once-per-document target can wait on exactly the rows that were enqueued.
 */
export interface OcrApproveDocument<TPreview> {
  /** The selected/approved preview records (the records the operator approved). */
  records: TPreview[];
  /** OCR session id (stable across the run). */
  sessionId: string;
  /** OCR run id (the `id`/`runId` of the approved OCR row). */
  runId: string;
  /**
   * The itemIds the per-record `approveTo` fan-out actually enqueued — kept in
   * sync with the rows the per-record target produced, so the doc target can
   * wait on exactly those rows.
   */
  perRecordItemIds: string[];
  /** Original uploaded PDF filename (display). */
  pdfOriginalName?: string;
  /** Registered file id for the uploaded PDF (resolve path/hash from the file store). */
  pdfFileId?: string;
  /** SHA-256 hex of the uploaded PDF, when known. */
  pdfHash?: string;
  /** Absolute path to the uploaded PDF on disk, when known. */
  pdfPath?: string;
  /** Whether the operator enabled dry-run for this prep. */
  dryRun?: boolean;
}

export interface OcrFormSpec<TOcr, TPreview, TFanOut = unknown, TDocFanOut = unknown> {
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

  /**
   * Approve fan-out target. Omit when the form's owner workflow consumes the
   * approved OCR row and performs its own fan-out.
   */
  approveTo?: {
    workflow: string;                                              // "oath-signature", "emergency-contact"
    deriveInput: (record: TPreview, ctx: OcrApproveRecordContext) => TFanOut;
    deriveItemId: (record: TPreview, parentRunId: string, index: number) => string;
    /**
     * Optional guard: when present, only selected records for which this
     * returns true are fanned out (and counted toward `perRecordItemIds`).
     * Lets a spec keep a selected-but-incomplete record visible in the
     * preview payload without enqueueing a daemon row for it (oath: a signed
     * row whose EID never resolved). Default (absent) → every selected record
     * fans out, matching emergency-contact's behavior.
     */
    canFanOut?: (record: TPreview) => boolean;
  };

  /**
   * Optional SECOND, **once-per-document** approve fan-out target. Enqueues
   * exactly one downstream row per approved PDF (not per record). Used by oath
   * to start a single `oath-upload` ServiceNow-ticket row that waits for all
   * the per-record `oath-signature` signer rows to finish before filing.
   *
   * Distinct from `approveTo` (per-record) — a spec may declare either, both,
   * or neither. Both targets run on DIFFERENT daemons so neither waits on its
   * own daemon's children (the "OCR hub fan-out" that fixes the oath deadlock).
   */
  approveDocumentTo?: {
    workflow: string;
    deriveInput: (doc: OcrApproveDocument<TPreview>) => TDocFanOut;
    deriveItemId: (doc: OcrApproveDocument<TPreview>) => string;
  };

  /** Whether to require a roster on disk before starting OCR. */
  rosterMode: "required" | "optional";

  /**
   * Form-specific fields for the loading-phase placeholder records the
   * orchestrator seeds (one per rendered page) before extraction completes.
   * Record SHAPE is set by the RUN (see the F6 lesson), so the placeholder
   * must match the form's own record shape: the shared default is the
   * oath-shaped skeleton (`printedName`/`employeeId` top-level), which on an
   * EC run both crashes the editable `EcRecordView` (unguarded
   * `record.emergencyContact.X` reads) and flips the run's record shape
   * mid-flight — the shape flip behind the E2E-004 "identity loss" misread.
   * Return only the form-specific fields; the orchestrator owns the shared
   * meta (formKind, sourcePage, documentType, matchState, warnings, …).
   * Omit to keep the oath-shaped default.
   */
  placeholderFields?(): Record<string, unknown>;

  /**
   * Optional 2-char trace-id code branding the OCR root run (and, via root
   * trace-id propagation, every descendant of the operation). OCR's physical
   * root is the OCR prep run, but the operator's mental model brands the whole
   * operation by its destination (oath upload → `"ou"`). When omitted the OCR
   * root keeps its own `"oc"` code (standalone OCR + emergency-contact). Set on
   * the oath form spec only. DISPLAY-only — does not change the execution graph.
   */
  traceCode?: string;

  /**
   * Optional post-match enrichment hook. Called ONCE by the orchestrator after
   * the match / disambiguation / lookup phases and before the awaiting-approval
   * snapshot. Lets a form do bespoke cross-system enrichment that the generic
   * roster/eid-lookup pipeline does not cover — e.g. the `verify` form delegates
   * each person to `person-lookup` (CRM employment + oath dates, active status)
   * and oath records with a blank authorized-official signature to `i9-lookup`,
   * then patches the found values onto each record so the preview shows a
   * completeness report. Returns the enriched records (same length + order).
   *
   * Forms that need no extra enrichment omit this — the orchestrator skips the
   * phase entirely. Implementations delegate via the kernel's `delegateToAllImpl`
   * + `watchChildRuns` (mirror `force-research.ts`), using `runId` as the child
   * `parentRunId` and `rootTracePrefix` for trace propagation. The hook is
   * awaited, so the OCR row stays `running` until enrichment completes — verify
   * blocks here on purpose (the report needs the looked-up data before review).
   */
  enrichRecords?(input: {
    records: TPreview[];
    /** The OCR run id — use as the `parentRunId` for any delegated children. */
    runId: string;
    /** OCR session id (stable business key, e.g. for child `taskGroupId`). */
    sessionId: string;
    /** Tracker dir override (undefined → default `.tracker`). */
    trackerDir: string | undefined;
    /** Local date partition for child-run watching. */
    date: string;
    /** Parent subject to re-stamp on child pending rows, when known. */
    parentSubject: string | undefined;
    /** Root trace PREFIX (`<code>-<HHMMSS>`) for child trace propagation. */
    rootTracePrefix: string;
    /**
     * Operator-chosen run options (Automation-workers setting). Map to daemon
     * flags via `runOptionsToDaemonFlags` and pass as `daemonFlags` to the
     * hook's `delegateToAllImpl` fan-outs so enrichment honors the worker
     * setting. Absent → Auto (default reuse-or-spawn-one).
     */
    runOptions: RunOptions | undefined;
    /** Emit a progress snapshot mid-enrichment (re-renders the Preview tab). */
    emitProgress: (records: TPreview[]) => void;
  }): Promise<TPreview[]>;
}

/** Convenience union — used by callers that don't care about generics. */
export type AnyOcrFormSpec = OcrFormSpec<unknown, unknown, unknown, unknown>;
