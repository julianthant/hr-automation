/**
 * Shared OCR preview-row re-emit envelope (BM-5).
 *
 * Every operator-driven OCR re-fan path (force-research, retry-page,
 * reocr-whole-pdf, verify-relookup) re-emits the OCR prep row carrying the
 * (possibly patched) records. They all hand-rolled the SAME re-stamp set —
 * `mode:"prepare"`, `archetype:"preview"`, `__id`, `__name`, `parentSubject`,
 * the carried-forward `parentRunId`, and the JSON-serialized `records` — so the
 * dashboard resolves the row by archetype/__id/__name/parentSubject rather than
 * whatever the latest row happened to carry. Three CLAUDE.md lessons exist
 * because that stamp drifts when copied (a missing `mode:"prepare"` strips the
 * Preview tab; a missing `archetype` mis-surfaces the row).
 *
 * `buildOcrReviewSnapshotData` produces the canonical envelope from a base data
 * record (whatever the caller already assembled) + the records; `emitOcrReviewSnapshot`
 * emits one tracker row with it. The running/done PAIR stays at the call site —
 * each path decides when to emit `running` (in progress) vs `done` (terminal).
 */
import { emitTrackerRow, type StampedData, type TrackerRowEmission } from "../../tracker/jsonl.js";
import { flattenForData } from "./tracker-data.js";

/** The parent context carried onto a re-emitted OCR review row. */
export interface OcrReviewSnapshotParent {
  /** The delegated parentRunId (operation/coordinator run), if any. */
  parentRunId?: string;
  /** The resolved parent subject / display title, if any. */
  parentSubject?: string;
}

export interface BuildOcrReviewSnapshotDataArgs {
  /**
   * The data fields the caller already assembled for this row (e.g. a spread of
   * the latest row's `data`, or an explicitly rebuilt set with
   * formType/pdfOriginalName/failedPages/pageStatusSummary). The canonical
   * re-stamp set below ALWAYS wins over these.
   */
  base: Record<string, unknown>;
  /** OCR session id — stamped as `__id` and `data.sessionId`. */
  sessionId: string;
  /** The records to serialize onto the row. */
  records: unknown[];
  /** Parent context (parentRunId + parentSubject). */
  parent?: OcrReviewSnapshotParent;
  /**
   * Explicit `__name` override. Defaults to `parent.parentSubject ?? "OCR"`.
   * retry-page passes the PRIOR row's `__name` directly (it inherits the display
   * label from the row being retried rather than re-deriving it from the parent
   * subject).
   */
  displayName?: string;
}

/**
 * Build the canonical OCR preview-row data: the caller's `base` overlaid with
 * the re-stamp set every OCR review re-emit needs. Returns a flattened
 * `StampedData` (`archetype` present satisfies `emitTrackerRow`'s contract).
 */
export function buildOcrReviewSnapshotData(args: BuildOcrReviewSnapshotDataArgs): StampedData {
  const { base, sessionId, records, parent, displayName } = args;
  const parentSubject = parent?.parentSubject;
  const flat = flattenForData({
    ...base,
    records,
    mode: "prepare",
    archetype: "preview",
    __id: sessionId,
    __name: displayName ?? parentSubject ?? "OCR",
    ...(parentSubject ? { parentSubject } : {}),
  });
  return flat as StampedData;
}

export interface EmitOcrReviewSnapshotArgs extends BuildOcrReviewSnapshotDataArgs {
  runId: string;
  status: TrackerRowEmission["status"];
  step: string;
  trackerDir?: string;
  /** Emit override (test seam). Default: `emitTrackerRow`. */
  emit?: (entry: TrackerRowEmission) => void;
  /** Terminal error string for a `failed` row. */
  error?: string;
}

/**
 * Emit one OCR preview row carrying the (possibly patched) records under the
 * canonical re-stamp envelope. Call twice (running → done) to settle a row.
 */
export function emitOcrReviewSnapshot(args: EmitOcrReviewSnapshotArgs): void {
  const { runId, status, step, trackerDir, error } = args;
  const data = buildOcrReviewSnapshotData(args);
  const emit = args.emit ?? ((e: TrackerRowEmission) => emitTrackerRow(e, trackerDir));
  emit({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: args.sessionId,
    runId,
    ...(args.parent?.parentRunId ? { parentRunId: args.parent.parentRunId } : {}),
    status,
    step,
    data,
    ...(error ? { error } : {}),
  });
}
