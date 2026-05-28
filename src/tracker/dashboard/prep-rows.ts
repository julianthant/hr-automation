import type { TrackerEntry } from "../jsonl.js";
import { resolveRowArchetype } from "../../domain/row-archetype.js";

export function isPrepEntry(e: TrackerEntry): boolean {
  return resolveRowArchetype(e) === "batch";
}

/**
 * OCR row in the "preview-ready, waiting for operator" state. Under the
 * new approval contract (2026-05-25) this is `status="running"` with
 * `step="awaiting-approval"` — the OCR row only reaches terminal `done`
 * once the operator approves. (Historical: was `status="done"` +
 * `step="awaiting-approval"` until the orchestrator stopped emitting the
 * row as terminal at awaiting-approval; see
 * `src/services/ocr/approval-signal.ts` for the new contract.)
 */
export function isOcrAwaitingApprovalEntry(e: TrackerEntry): boolean {
  return e.workflow === "ocr" && e.status === "running" && e.step === "awaiting-approval";
}

/**
 * True when OCR is delegated from another workflow (`parentRunId` set —
 * oath-upload / similar). Used to scope "Needs review" surfacing to
 * delegated prep — standalone OCR prep awaiting-approval renders as an
 * ordinary in-flight prep row in the queue.
 */
export function isDelegatedOcrAwaitingApprovalEntry(e: TrackerEntry): boolean {
  return isOcrAwaitingApprovalEntry(e) && Boolean(e.parentRunId);
}

export function isResolvedPrepEntry(e: TrackerEntry): boolean {
  if (e.workflow === "ocr") {
    // New approval contract: an OCR `done` row IS approved (the kernel
    // only emits done after operator approves). `status==="failed"
    // step="discarded"` covers the discard branch.
    if (e.status === "done") return true;
    return e.status === "failed" && e.step === "discarded";
  }
  if (!isPrepEntry(e)) return false;
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
