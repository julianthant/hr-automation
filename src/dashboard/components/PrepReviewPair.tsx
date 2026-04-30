import type { ReactNode } from "react";
import { PdfPagePreview } from "./PdfPagePreview";

export interface PrepReviewPairProps {
  workflow: "emergency-contact" | "oath-signature";
  parentRunId: string;
  page: number;
  formCard: ReactNode;
}

/**
 * Single record per page → render as a paired pair: PDF page on the
 * left, form card on the right. Two columns, equal width.
 */
export function PrepReviewPair({
  workflow,
  parentRunId,
  page,
  formCard,
}: PrepReviewPairProps) {
  return (
    <div className="grid grid-cols-2 gap-4 border-b border-border p-4">
      <div className="self-start">
        <PdfPagePreview workflow={workflow} parentRunId={parentRunId} page={page} />
      </div>
      <div>{formCard}</div>
    </div>
  );
}
