import type { ReactNode } from "react";
import { AlertTriangle, Camera, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type PrepRecordWorkflowPhase = "running" | "pending" | "done";

export interface PrepReviewFormCardProps {
  /** Page-location chip text — "Page 7 of 12 in pile" or "Page 7, Row 3 of 8 in pile" */
  pageLocation: string;
  recordName: string;
  /** Batch-preview-style row header: `#n` + name + workflow phase (replaces duplicating status inside MATCH). */
  rowOrdinal?: number;
  workflowStatusPhase?: PrepRecordWorkflowPhase;
  matchStateBadge: ReactNode;
  verificationBadge?: ReactNode;
  signatureBadge?: ReactNode;
  documentTypeBadge?: ReactNode;
  /**
   * Document-kind chip (Oath / Emergency Contact / Unknown) rendered at the
   * head of the row title in place of the old `#ordinal` badge — the page count
   * already lives in the `pageLocation` subline. Falls back to `#{rowOrdinal}`
   * when not provided.
   */
  documentKindChip?: ReactNode;
  /** Icon control rendered beside the batch checkbox (e.g. force-research retry). */
  footerAction?: ReactNode;
  /** Labeled screenshot row rendered between the header and the form body. */
  screenshotStrip?: ReactNode;
  /** Remove this record from the prep batch (between retry and batch checkbox). */
  onDeleteRecord?: () => void;
  deleteDisabled?: boolean;
  removeFromPileBanner?: ReactNode;
  verificationBanner?: ReactNode;
  signatureBanner?: ReactNode;
  selected: boolean;
  selectedDisabled?: boolean;
  onSelectedChange: (next: boolean) => void;
  children: ReactNode;
  /** When true, the page/name/status header is rendered by the parent pair chrome. */
  hideHeader?: boolean;
}

/**
 * Form-card chrome for the paired-scroll review pane. Owns the
 * page-location chip + name + trailing badges (verification / signature /
 * document), banners, form fields (`children`), and a footer with the
 * identity-match confidence chip on the left plus optional `footerAction` and
 * optional delete. When row ordinal + workflow phase headers are shown, the approval
 * checkbox sits in that header beside the phase badge; otherwise it stays in
 * the footer.
 */
function showBatchCheckboxInHeader(
  props: Pick<PrepReviewFormCardProps, "rowOrdinal" | "workflowStatusPhase">,
): boolean {
  return props.rowOrdinal != null && props.workflowStatusPhase != null;
}

export function PrepReviewFormCard(props: PrepReviewFormCardProps) {
  const headerBatchSelect = showBatchCheckboxInHeader(props);
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4 shadow-sm",
        props.removeFromPileBanner && "border-destructive/40",
      )}
    >
      {!props.hideHeader && <PrepReviewRecordNav {...props} className="mb-3 border-b border-border pb-2" />}

      {props.removeFromPileBanner && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <div>{props.removeFromPileBanner}</div>
        </div>
      )}
      {props.verificationBanner && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          <Camera className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <div>{props.verificationBanner}</div>
        </div>
      )}
      {props.signatureBanner && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <div>{props.signatureBanner}</div>
        </div>
      )}

      {props.screenshotStrip ? (
        <div className="mb-3 border-b border-border pb-3">{props.screenshotStrip}</div>
      ) : null}

      <div className="space-y-3">{props.children}</div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {props.matchStateBadge}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {props.footerAction}
          {props.onDeleteRecord ? (
            <button
              type="button"
              onClick={props.onDeleteRecord}
              disabled={props.deleteDisabled}
              title="Remove this record from the batch"
              aria-label="Remove this record from the batch"
              className={cn(
                "inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive outline-none transition-colors",
                "hover:border-destructive/60 hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
          {!headerBatchSelect ? (
            <label
              className={cn(
                "inline-flex items-center",
                props.selectedDisabled ? "cursor-not-allowed" : "cursor-pointer",
              )}
            >
              <input
                type="checkbox"
                checked={props.selected}
                disabled={props.selectedDisabled}
                onChange={(e) => props.onSelectedChange(e.target.checked)}
                aria-label={
                  props.selectedDisabled
                    ? "Batch selection unavailable for this record"
                    : props.selected
                      ? "Included in approval batch"
                      : "Excluded from approval batch"
                }
                className="h-4 w-4 accent-primary"
              />
            </label>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function PrepReviewRecordNav(
  props: Pick<
    PrepReviewFormCardProps,
    | "pageLocation"
    | "recordName"
    | "rowOrdinal"
    | "workflowStatusPhase"
    | "verificationBadge"
    | "signatureBadge"
    | "documentTypeBadge"
    | "documentKindChip"
    | "selected"
    | "selectedDisabled"
    | "onSelectedChange"
  > & { className?: string },
) {
  return (
    <div className={props.className}>
      {props.rowOrdinal != null && props.workflowStatusPhase ? (
        <>
          <div className="mb-2 flex min-w-0 items-center gap-2">
            {props.documentKindChip ?? (
              <span className="rounded bg-secondary px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
                #{props.rowOrdinal}
              </span>
            )}
            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
              {props.recordName}
            </h3>
            <PrepRecordWorkflowStatusBadge phase={props.workflowStatusPhase} />
            <label
              className={cn(
                "inline-flex shrink-0 items-center",
                props.selectedDisabled ? "cursor-not-allowed" : "cursor-pointer",
              )}
            >
              <input
                type="checkbox"
                checked={props.selected}
                disabled={props.selectedDisabled}
                onChange={(e) => props.onSelectedChange(e.target.checked)}
                aria-label={
                  props.selectedDisabled
                    ? "Batch selection unavailable for this record"
                    : props.selected
                      ? "Included in approval batch"
                      : "Excluded from approval batch"
                }
                className="h-4 w-4 accent-primary"
              />
            </label>
          </div>
          <div className="font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {props.pageLocation}
          </div>
        </>
      ) : (
        <>
          <div className="font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {props.pageLocation}
          </div>
          <div className="mt-0.5 text-base font-semibold">{props.recordName}</div>
        </>
      )}
      {(props.verificationBadge ?? props.signatureBadge ?? props.documentTypeBadge) ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {props.verificationBadge}
          {props.signatureBadge}
          {props.documentTypeBadge}
        </div>
      ) : null}
    </div>
  );
}

export function PrepRecordWorkflowStatusBadge({ phase }: { phase: PrepRecordWorkflowPhase }) {
  const label = phase.toUpperCase();
  const className =
    phase === "running"
      ? "border-primary/40 bg-primary/10 text-primary"
      : phase === "pending"
        ? "border-warning/40 bg-warning/10 text-warning"
        : "border-success/40 bg-success/10 text-success";
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider",
        className,
      )}
    >
      {label}
    </span>
  );
}
