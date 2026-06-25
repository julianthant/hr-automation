import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlateProps {
  icon: LucideIcon;
  title: string;
  caption?: string;
  /** Count of overrides in this domain; renders a pill when > 0. */
  count: number;
  headerId: string;
  children: React.ReactNode;
}

/**
 * One section of the blueprint canvas. Card sits over the grid-paper canvas with
 * a labelled eyebrow (icon + name + live override count). No 01/02/03 numbering —
 * the three plates are independent domains, not a sequence.
 */
export function Plate({
  icon: Icon,
  title,
  caption,
  count,
  headerId,
  children,
}: PlateProps): JSX.Element {
  return (
    <section
      aria-labelledby={headerId}
      className="rounded-xl border border-border bg-card/70 p-4 shadow-sm backdrop-blur-[1px]"
    >
      <header className="mb-3 flex items-center gap-2">
        <Icon aria-hidden className="h-4 w-4 shrink-0 text-muted-foreground" />
        <h2
          id={headerId}
          className="text-xs font-semibold uppercase tracking-wide text-foreground"
        >
          {title}
        </h2>
        {count > 0 ? (
          <span
            className={cn(
              "inline-flex items-center rounded-full bg-primary/15 px-1.5 py-px",
              "text-[11px] font-semibold leading-none text-primary",
            )}
            aria-label={`${count} override${count !== 1 ? "s" : ""}`}
          >
            {count}
          </span>
        ) : null}
        {caption ? (
          <span className="ml-auto text-[11px] text-muted-foreground">{caption}</span>
        ) : null}
      </header>
      {children}
    </section>
  );
}
