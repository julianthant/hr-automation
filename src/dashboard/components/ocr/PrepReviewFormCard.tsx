import type { ReactNode } from "react";
import { AlertTriangle, Camera } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PrepReviewFormCardProps {
  /** Page-location chip text — "Page 7 of 12 in pile" or "Page 7, Row 3 of 8 in pile" */
  pageLocation: string;
  recordName: string;
  matchStateBadge: ReactNode;
  verificationBadge?: ReactNode;
  signatureBadge?: ReactNode;
  documentTypeBadge?: ReactNode;
  removeFromPileBanner?: ReactNode;
  addToPaperBanner?: ReactNode;
  verificationBanner?: ReactNode;
  signatureBanner?: ReactNode;
  selected: boolean;
  selectedDisabled?: boolean;
  onSelectedChange: (next: boolean) => void;
  children: ReactNode;
}

/**
 * Form-card chrome for the paired-scroll review pane. Owns the
 * page-location chip + name + stacked badges header, the banner stack
 * (REMOVE FROM PILE, Add to paper, Verification, Signature), the form
 * fields container, and the bottom-right Selected checkbox. Workflow-
 * specific form fields are passed in as `children` (EC: EcReviewForm,
 * oath: OathReviewForm).
 */
export function PrepReviewFormCard(props: PrepReviewFormCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-4 shadow-sm",
        props.removeFromPileBanner && "border-destructive/40",
      )}
    >
      <div className="mb-3 border-b border-border pb-2">
        <div className="font-mono text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {props.pageLocation}
        </div>
        <div className="mt-0.5 flex items-start justify-between gap-3">
          <div className="text-base font-semibold">{props.recordName}</div>
          <div className="flex flex-col items-end gap-1">
            {props.matchStateBadge}
            {props.verificationBadge}
            {props.signatureBadge}
            {props.documentTypeBadge}
          </div>
        </div>
      </div>

      {props.removeFromPileBanner && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <div>{props.removeFromPileBanner}</div>
        </div>
      )}
      {props.addToPaperBanner && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <div>{props.addToPaperBanner}</div>
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

      <div className="space-y-3">{props.children}</div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={props.selected}
            disabled={props.selectedDisabled}
            onChange={(e) => props.onSelectedChange(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          <span className="font-mono text-muted-foreground">
            {props.selected ? "in batch" : "excluded"}
          </span>
        </label>
      </div>
    </div>
  );
}
