import { useState } from "react";
import { RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface RetryButtonProps {
  workflow: string;
  id: string;
  /** Compact variant: 24×24 for inline use on EntryItem rows. Default: same. */
  size?: "sm" | "md";
  /** Optional class extension for parent-driven margin etc. */
  className?: string;
}

/**
 * Small icon-only button that re-enqueues a failed run via POST /api/retry.
 * Tooltip-wrapped (a11y) and disables itself during the in-flight roundtrip
 * to prevent double-fire. Uses sonner toasts for feedback — non-destructive,
 * so no AlertDialog confirmation step.
 */
export function RetryButton({ workflow, id, size = "sm", className }: RetryButtonProps) {
  const [pending, setPending] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Retrying ${id}…`);
    try {
      const res = await fetch("/api/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        toast.success(`Retry enqueued`, {
          id: t,
          description: id,
        });
      } else {
        toast.error(`Retry failed`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`Retry failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  const sizeClass = size === "md" ? "h-7 w-7" : "h-6 w-6";
  const iconClass = size === "md" ? "h-4 w-4" : "h-3.5 w-3.5";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Retry this run"
          disabled={pending}
          onClick={onClick}
          className={cn(
            sizeClass,
            "inline-flex items-center justify-center rounded-md cursor-pointer",
            "text-muted-foreground bg-transparent",
            "transition-colors duration-150",
            "hover:text-foreground hover:bg-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            "disabled:opacity-60 disabled:cursor-wait",
            className,
          )}
        >
          {pending ? (
            <Loader2 className={cn(iconClass, "animate-spin text-primary")} />
          ) : (
            <RotateCcw className={iconClass} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Retry this run
      </TooltipContent>
    </Tooltip>
  );
}
