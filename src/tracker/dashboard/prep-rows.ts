import type { TrackerEntry } from "../jsonl.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";

export function isPrepEntry(e: TrackerEntry): boolean {
  return resolveRowArchetype(e) === "batch-parent";
}

/**
 * OCR uses `status: "done"` for the preview-ready row (`step: awaiting-approval`)
 * so approve/discard semantics stay orthogonal — use this predicate anywhere a
 * done-looking row still needs operator action.
 */
export function isOcrAwaitingApprovalEntry(e: TrackerEntry): boolean {
  return e.workflow === "ocr" && e.status === "done" && e.step === "awaiting-approval";
}

/**
 * True when OCR is delegated from another workflow (`parentRunId` set —
 * oath-upload / similar). The tracker step may still be `awaiting-approval`,
 * but the queue sidebar should treat only these rows as "Needs review" /
 * upstream approval surfacing — standalone OCR prep uses the same step
 * without `parentRunId` and renders as ordinary completed prep in the queue.
 */
export function isDelegatedOcrAwaitingApprovalEntry(e: TrackerEntry): boolean {
  return isOcrAwaitingApprovalEntry(e) && Boolean(e.parentRunId);
}

export function isResolvedPrepEntry(e: TrackerEntry): boolean {
  if (!isPrepEntry(e)) return false;
  if (e.workflow === "ocr") {
    return e.status === "failed" && e.step === "discarded";
  }
  if (e.status === "done" && e.step === "approved") return true;
  if (e.status === "failed" && e.step === "discarded") return true;
  return false;
}

export function isReadyForReview(latest: TrackerEntry): boolean {
  if (latest.workflow === "ocr") {
    return isOcrAwaitingApprovalEntry(latest);
  }
  if (latest.status !== "done") return false;
  if (latest.step === "approved" || latest.step === "discarded") return false;
  return true;
}

export function previewSummary(e: TrackerEntry): string {
  return e.data?.pdfOriginalName || e.id;
}

export function countRecords(e: TrackerEntry): number | undefined {
  const raw = e.data?.records;
  if (!raw) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}
