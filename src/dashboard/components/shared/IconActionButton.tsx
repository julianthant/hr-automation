import type { MouseEvent, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Size = "sm" | "md";
type Tone = "destructive" | "warning" | "primary" | "muted";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
};

const TONE_CLASS: Record<Tone, string> = {
  destructive: "text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:ring-destructive/40",
  warning: "text-warning bg-warning/15 border border-warning/45 hover:bg-warning/25 hover:border-warning/65 focus-visible:ring-warning",
  primary: "text-muted-foreground hover:text-primary hover:bg-muted focus-visible:ring-primary/40",
  muted: "text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-primary/40",
};

export function IconActionButton({
  size = "sm",
  tone,
  pending,
  icon,
  label,
  title,
  onClick,
  disabled,
  className,
  spinnerClassName,
}: {
  size?: Size;
  tone: Tone;
  pending?: boolean;
  icon: ReactNode;
  label: string;
  title?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
  spinnerClassName?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled || pending}
      className={cn(
        SIZE_CLASS[size],
        "inline-flex flex-shrink-0 items-center justify-center rounded-md cursor-pointer transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:opacity-60 disabled:cursor-wait",
        TONE_CLASS[tone],
        className,
      )}
    >
      {pending ? (
        <Loader2 aria-hidden className={cn("h-3.5 w-3.5 animate-spin", spinnerClassName)} />
      ) : (
        icon
      )}
    </button>
  );
}
