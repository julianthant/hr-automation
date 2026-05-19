import type { ReactNode } from "react";
import { PdfPagePreview } from "@/components/shared/PdfPagePreview";
import { PrepReviewPageLayout } from "./PrepReviewPageLayout";

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
    <PrepReviewPageLayout
      title={titleBar}
      pdfPreview={
        <PdfPagePreview
          workflow={workflow}
          parentRunId={parentRunId}
          page={page}
          fileId={fileId}
          onStatusChange={onPreviewStatusChange}
        />
      }
      formCards={formCard}
    />
  );
}
