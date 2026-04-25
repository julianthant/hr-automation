import { useState } from "react";
import { AlertCircle, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface BulkRetryBarProps {
  workflow: string;
  failedIds: string[];
}

/**
 * Sticky bar inside QueuePanel surfacing "Retry N failed" when 1+ failed
 * entries are in the current filter view. Composes /api/retry-bulk —
 * one POST → toast with per-id error breakdown if any failed to enqueue.
 */
export function BulkRetryBar({ workflow, failedIds }: BulkRetryBarProps) {
  const [pending, setPending] = useState(false);
  if (failedIds.length === 0) return null;

  const onClick = async () => {
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Retrying ${failedIds.length} failed…`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, ids: failedIds }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        count: number;
        errors: Array<{ id: string; error: string }>;
      };
      if (body.errors.length === 0) {
        toast.success(`Retry enqueued`, {
          id: t,
          description: `${body.count} of ${failedIds.length} re-queued`,
        });
      } else {
        toast.warning(`Partial retry`, {
          id: t,
          description: `${body.count} ok · ${body.errors.length} failed (${body.errors[0].error})`,
        });
      }
    } catch (err) {
      toast.error(`Retry-all failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={cn(
        "sticky top-0 z-10 flex items-center justify-between gap-3",
        "px-3 py-2 border-b border-border/60",
        "bg-destructive/10 backdrop-blur-sm",
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        <span className="font-medium text-foreground tabular-nums">
          {failedIds.length} failed
        </span>
        <span className="text-muted-foreground">in current view</span>
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        aria-label={`Retry all ${failedIds.length} failed entries`}
        className={cn(
          "inline-flex items-center gap-1.5 h-7 px-3 rounded-md cursor-pointer",
          "bg-primary text-primary-foreground text-xs font-medium",
          "transition-colors duration-150",
          "hover:bg-primary/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          "disabled:opacity-60 disabled:cursor-wait",
        )}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
        Retry all
      </button>
    </div>
  );
}
