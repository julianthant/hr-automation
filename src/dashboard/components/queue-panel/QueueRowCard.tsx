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
  interactive = true,
  rootProps,
  children,
  footer,
}: QueueRowCardProps) {
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
          selected && "ring-2 ring-primary",
          selected && !accent && "border-primary/50 shadow-lg shadow-black/20",
          rootProps?.className,
        )}
      >
        {children}
        <RowFooter {...footer} />
      </div>
    </div>
  );
}
