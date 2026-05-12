import type { ReactNode } from "react";
import { PdfPagePreview } from "@/components/shared/PdfPagePreview";

export interface PrepReviewPairProps {
  /** Workflow name passed through to the PdfPagePreview backend route. */
  workflow: string;
  parentRunId: string;
  page: number;
  fileId?: string;
  formCard: ReactNode;
  titleBar?: ReactNode;
  onPreviewStatusChange?: (page: number, status: "loading" | "ok" | "error") => void;
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
  titleBar,
  onPreviewStatusChange,
}: PrepReviewPairProps) {
  return (
    <div className="p-4">
      {titleBar ? (
        <div className="mb-3 rounded-lg border border-border bg-card px-4 py-3">
          {titleBar}
        </div>
      ) : null}
      <div className="grid grid-cols-[minmax(420px,1.15fr)_minmax(360px,0.85fr)] gap-4">
        <div className="self-start">
          <PdfPagePreview
            workflow={workflow}
            parentRunId={parentRunId}
            page={page}
            fileId={fileId}
            onStatusChange={onPreviewStatusChange}
          />
        </div>
        <div>{formCard}</div>
      </div>
    </div>
  );
}
