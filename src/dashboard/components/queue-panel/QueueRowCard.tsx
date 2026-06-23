import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { RowFooter, type RowFooterProps } from "./RowFooter";

/**
 * The global queue-row card. Owns the shared bento chrome (border, rounded,
 * hover, selection ring, optional left accent) AND the footer ({@link RowFooter},
 * rendered inside). Every row type — `single`, `batch`, `preview` — renders
 * through this so the card shell + footer are defined once and can't drift.
 *
 * The body (header + content zones) is passed as `children`; the footer is
 * configured via `footer`. The divider between body and footer lives in
 * RowFooter, so children should NOT add a trailing divider.
 */
export type RowAccent = "warning" | "success" | "destructive";

const ACCENT_BORDER: Record<RowAccent, string> = {
  warning: "border-l-warning",
  success: "border-l-success",
  destructive: "border-l-destructive",
};

export interface QueueRowCardProps {
  /** Optional 3px left accent (batch cards). Omit for flat rows. */
  accent?: RowAccent;
  selected?: boolean;
  /**
   * Selection-ring strength. Top-level rows use the bright `"primary"` ring so
   * a selected card pops against its neighbours. Nested member rows (inside an
   * operation/batch coordinator card) use the dimmer `"muted"` tone — a full
   * `border-primary/25` outline that traces the whole card (footer included)
   * and reads clearly subordinate to the parent's bright ring.
   */
  selectionTone?: "primary" | "muted";
  /** Hover affordance + cursor (default true). */
  interactive?: boolean;
  /** Spread onto the outer card (onClick / role / tabIndex / aria / data-*). */
  rootProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string>;
  /** Body content (header + zones), rendered above the footer. */
  children: ReactNode;
  /** Footer config — the shared footer is rendered inside the card. */
  footer: RowFooterProps;
}

export function QueueRowCard({
  accent,
  selected,
  selectionTone = "primary",
  interactive = true,
  rootProps,
  children,
  footer,
}: QueueRowCardProps) {
  const muted = selectionTone === "muted";
  return (
    <div className="px-3 pt-2 first:pt-3">
      <div
        {...rootProps}
        className={cn(
          "group relative bg-card border border-border rounded-lg outline-none overflow-hidden transition-all duration-200",
          accent && "border-l-[3px]",
          accent && ACCENT_BORDER[accent],
          interactive && "hover:border-primary/40 hover:shadow-lg hover:shadow-black/20",
          interactive && "focus-visible:ring-2 focus-visible:ring-primary cursor-pointer",
          !interactive && "cursor-default",
          // Selection ring is universal; the border/shadow shift is for flat
          // rows only (accent cards keep their colored left border intact).
          // Top-level rows get the bright primary ring; nested member rows get
          // a dimmer INSET ring so it sits a step below the parent's ring and
          // traces the full card outline without being clipped by the
          // coordinator's overflow box.
          selected && !muted && "ring-2 ring-primary",
          selected && !muted && !accent && "border-primary/50 shadow-lg shadow-black/20",
          // Nested member rows: a dim full border (not an outset ring) so the
          // highlight traces the whole card — footer included — and reads
          // clearly subordinate to the parent's bright ring.
          selected && muted && "border-primary/25",
          rootProps?.className,
        )}
      >
        {children}
        <RowFooter {...footer} />
      </div>
    </div>
  );
}
