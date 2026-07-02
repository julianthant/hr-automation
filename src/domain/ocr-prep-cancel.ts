/**
 * Shared OCR-prep cancel routing — used by the dashboard row-cancel builder
 * and the server-side action engine so both agree on when × means "discard prep".
 */

export const DISCARDABLE_OCR_STATUSES = new Set(["running", "preparing", "awaiting-review"]);

export interface OcrPrepCancelContext {
  ocrSessionId: string;
  ocrRunId: string;
  formType?: string;
}

export function readOcrPrepCancelContext(
  data: Record<string, string | undefined> | null | undefined,
): OcrPrepCancelContext | null {
  if (
    data?.mode === "prepare" &&
    typeof data.ocrSessionId === "string" &&
    typeof data.ocrRunId === "string"
  ) {
    if (typeof data.ocrStatus === "string" && !DISCARDABLE_OCR_STATUSES.has(data.ocrStatus)) {
      return null;
    }
    return {
      ocrSessionId: data.ocrSessionId,
      ocrRunId: data.ocrRunId,
      formType: typeof data.formType === "string" ? data.formType : undefined,
    };
  }
  return null;
}
