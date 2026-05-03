import { Plus, FileX } from "lucide-react";

export interface EmptyPagePlaceholderProps {
  page: number;
  totalPages: number;
  onAddRow: () => void;
  onMarkBlank: () => void;
  marked: boolean;
}

/**
 * Renders on the right side of a PrepReviewPair when OCR succeeded on a
 * page but extracted zero records. The page image is on the left (via
 * PrepReviewPair), so the operator can compare and decide whether to add
 * a row manually or mark the page as blank/non-form.
 *
 * "Mark as blank" is a session-local flag — no tracker mutation. Reload
 * restores the placeholder.
 */
export function EmptyPagePlaceholder({
  page,
  totalPages,
  onAddRow,
  onMarkBlank,
  marked,
}: EmptyPagePlaceholderProps) {
  if (marked) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
        <FileX className="h-6 w-6 opacity-60" aria-hidden />
        <span>Page {page} of {totalPages} marked as blank.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-warning/30 bg-warning/5 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">OCR found no records on this page.</span>
        <span className="text-xs text-muted-foreground">
          Compare against the page on the left. If it&apos;s a real form, add a row manually
          and type the printed name + EID. If it&apos;s blank or not part of this batch, mark it.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAddRow}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground"
        >
          <Plus className="h-3 w-3" />
          Add row manually
        </button>
        <button
          type="button"
          onClick={onMarkBlank}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
        >
          Mark as blank
        </button>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          Page {page} of {totalPages}
        </span>
      </div>
    </div>
  );
}
