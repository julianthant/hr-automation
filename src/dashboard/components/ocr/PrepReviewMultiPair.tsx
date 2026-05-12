import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { PdfPagePreview } from "@/components/shared/PdfPagePreview";

export interface PrepReviewMultiPairProps {
  /** Workflow name passed through to the PdfPagePreview backend route. */
  workflow: string;
  parentRunId: string;
  page: number;
  fileId?: string;
  formCards: ReactNode[];
  titleBar?: ReactNode;
  /** Optional: when provided, renders an "Add row to this page" footer button. */
  onAddRow?: (page: number) => void;
  onPreviewStatusChange?: (page: number, status: "loading" | "ok" | "error") => void;
}

/**
 * Multi-record page (oath sign-in sheet) → sticky PDF on the left, stack
 * of row-form cards on the right. The PDF stays in view as the operator
 * scrolls through the row stack so they keep visual context for which
 * page they're on.
 *
 * The footer button (when onAddRow is provided) lets the operator
 * synthesize a blank row for cases where OCR extracted N-1 of N rows on
 * the page — they spot the missing one against the always-visible page
 * image and click to add a manual entry.
 */
export function PrepReviewMultiPair({
  workflow,
  parentRunId,
  page,
  fileId,
  formCards,
  titleBar,
  onAddRow,
  onPreviewStatusChange,
}: PrepReviewMultiPairProps) {
  return (
    <div className="p-4">
      {titleBar ? (
        <div className="mb-3 rounded-lg border border-border bg-card px-4 py-3">
          {titleBar}
        </div>
      ) : null}
      <div className="grid grid-cols-[minmax(420px,1.15fr)_minmax(360px,0.85fr)] gap-4">
        <div className="sticky top-4 self-start">
          <PdfPagePreview
            workflow={workflow}
            parentRunId={parentRunId}
            page={page}
            fileId={fileId}
            onStatusChange={onPreviewStatusChange}
          />
        </div>
        <div className="flex flex-col gap-3">
          {formCards.map((card, i) => (
            <div key={i}>{card}</div>
          ))}
          {onAddRow && (
            <button
              type="button"
              onClick={() => onAddRow(page)}
              className="inline-flex h-7 w-fit items-center gap-1.5 self-start rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground hover:bg-muted"
            >
              <Plus className="h-3 w-3" />
              Add row to this page
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
