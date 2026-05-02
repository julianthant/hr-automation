import type { ReactNode } from "react";
import { PdfPagePreview } from "../PdfPagePreview";

export interface PrepReviewMultiPairProps {
  /** Workflow name passed through to the PdfPagePreview backend route. */
  workflow: string;
  parentRunId: string;
  page: number;
  formCards: ReactNode[];
}

/**
 * Multi-record page (oath sign-in sheet) → sticky PDF on the left, stack
 * of row-form cards on the right. The PDF stays in view as the operator
 * scrolls through the row stack so they keep visual context for which
 * page they're on.
 *
 * No active-row highlight on the form stack (per spec: "no active
 * highlight"). The page-location chip on each card already says
 * "Page N, Row M of K in pile" — that's enough for the operator to
 * count down to the right row on the physical paper.
 */
export function PrepReviewMultiPair({
  workflow,
  parentRunId,
  page,
  formCards,
}: PrepReviewMultiPairProps) {
  return (
    <div className="grid grid-cols-2 gap-4 border-b border-border p-4">
      <div className="sticky top-4 self-start">
        <PdfPagePreview workflow={workflow} parentRunId={parentRunId} page={page} />
      </div>
      <div className="flex flex-col gap-3">
        {formCards.map((card, i) => (
          <div key={i}>{card}</div>
        ))}
      </div>
    </div>
  );
}
