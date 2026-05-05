import type { ReactNode } from "react";
import { PdfPagePreview } from "../PdfPagePreview";

export interface PrepReviewPairProps {
  /** Workflow name passed through to the PdfPagePreview backend route. */
  workflow: string;
  parentRunId: string;
  page: number;
  fileId?: string;
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
  fileId,
  formCard,
}: PrepReviewPairProps) {
  return (
    <div className="grid grid-cols-2 gap-4 border-b border-border p-4">
      <div className="self-start">
        <PdfPagePreview workflow={workflow} parentRunId={parentRunId} page={page} fileId={fileId} />
      </div>
      <div>{formCard}</div>
    </div>
  );
}
