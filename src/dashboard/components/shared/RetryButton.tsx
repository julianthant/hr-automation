import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useOptionalBatchQueueParentRunId } from "@/components/hooks/useBatchQueueContext";
import { IconActionButton } from "@/components/shared/IconActionButton";

interface RetryButtonProps {
  workflow: string;
  id: string;
  /** When set, targets this run for SQLite-backed daemon retries. */
  runId?: string;
  /** Tracker date selected in the dashboard. */
  date?: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Small icon-only button that re-enqueues via POST /api/retry using the persisted input.
 * Tooltip-wrapped (a11y) and disables itself during the in-flight roundtrip
 * to prevent double-fire. Uses sonner toasts for feedback — non-destructive,
 * so no AlertDialog confirmation step.
 */
export function RetryButton({
  workflow,
  id,
  runId,
  date,
  size = "sm",
  className,
}: RetryButtonProps) {
  const [pending, setPending] = useState(false);
  const batchParentRunId = useOptionalBatchQueueParentRunId();

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Retrying ${id}…`);
    try {
      const res = await fetch("/api/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          id,
          ...(runId ? { runId } : {}),
          ...(date ? { date } : {}),
          ...(batchParentRunId ? { parentRunId: batchParentRunId } : {}),
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        toast.success(`Retry scheduled`, {
          id: t,
          description: id,
        });
      } else {
        toast.error(`Couldn't retry`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't retry`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  const iconClass = "h-3.5 w-3.5";

  // The "md" variant lives in the LogPanel header next to the date-navigator
  // chevron; mirroring the QuickRunPanel retry-all button (red destructive
  // pill with border) keeps a consistent "retry = destructive action" cue
  // across the navbar + log header. The "sm" inline variant on EntryItem
  // rows stays muted-tone so the queue list isn't a sea of red dots.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconActionButton
          size={size}
          tone={size === "md" ? "destructive" : "muted"}
          label="Retry this run"
          pending={pending}
          onClick={onClick}
          icon={<RotateCcw className={iconClass} />}
          spinnerClassName={size === "md" ? undefined : "text-primary"}
          className={cn(
            size === "md"
              ? cn(
                "rounded-lg bg-destructive/10 text-destructive border border-destructive/40",
                "hover:bg-destructive/20 hover:border-destructive/60",
                "focus-visible:ring-destructive",
              )
              : cn(
                "rounded-md text-muted-foreground bg-transparent",
                "hover:text-foreground hover:bg-muted",
                "focus-visible:ring-primary/40",
              ),
            className,
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Retry this run
      </TooltipContent>
    </Tooltip>
  );
}
