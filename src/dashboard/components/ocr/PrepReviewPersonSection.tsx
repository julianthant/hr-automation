import type { ReactNode } from "react";
import { PdfPagePreview } from "@/components/shared/PdfPagePreview";
import type { I9SectionPage } from "./i9-person-groups";

export interface PrepReviewPersonSectionProps {
  /** Workflow name passed through to the PdfPagePreview backend route. */
  workflow: string;
  parentRunId: string;
  /** The person's pages, render order (Section 2 first when paired). */
  pages: I9SectionPage[];
  fileId?: string;
  formCard: ReactNode;
  onPreviewStatusChange?: (page: number, status: "loading" | "ok" | "error") => void;
}

/**
 * One PERSON of an I-9 packet → one section: every page that backs this
 * person (Section 2 + Section 1, often non-adjacent in the scan) stacked in
 * the left column, each labeled, beside the single record card. The i9
 * analogue of `PrepReviewPair` — same grid, multi-page left column.
 */
export function PrepReviewPersonSection({
  workflow,
  parentRunId,
  pages,
  fileId,
  formCard,
  onPreviewStatusChange,
}: PrepReviewPersonSectionProps) {
  return (
    <div className="p-4">
      <div className="grid grid-cols-[minmax(420px,1.15fr)_minmax(360px,0.85fr)] gap-4">
        <div className="flex flex-col gap-3 self-start">
          {pages.map(({ page, label }) => (
            <figure key={page} className="flex flex-col gap-1">
              <figcaption className="text-xs font-medium text-muted-foreground">
                {label} — page {page}
              </figcaption>
              <PdfPagePreview
                workflow={workflow}
                parentRunId={parentRunId}
                page={page}
                fileId={fileId}
                onStatusChange={onPreviewStatusChange}
              />
            </figure>
          ))}
        </div>
        <div className="sticky top-4 self-start">{formCard}</div>
      </div>
    </div>
  );
}
