import type { TrackerEntry } from "../jsonl.js";

export function isPrepEntry(e: TrackerEntry): boolean {
  if (e.data?.mode === "prepare") return true;
  if (e.workflow === "ocr") return true;
  if (isOcrPrepParentId(e.id)) return true;
  return false;
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
    return latest.status === "done" && latest.step === "awaiting-approval";
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

function isOcrPrepParentId(id: string): boolean {
  return id.startsWith("ocr-prep-");
}
