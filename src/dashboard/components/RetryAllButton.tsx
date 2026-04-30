import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface RetryAllButtonProps {
  workflow: string;
  failedIds: string[];
}

export function RetryAllButton({ workflow, failedIds }: RetryAllButtonProps) {
  const [retrying, setRetrying] = useState(false);

  async function retryAll() {
    if (retrying || failedIds.length === 0) return;
    setRetrying(true);
    const t = toast.loading(`Retrying ${failedIds.length} failed items…`);
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
        toast.success(`Retry scheduled`, {
          id: t,
          description: `${body.count} of ${failedIds.length} items re-added to queue`,
        });
      } else {
        toast.warning(`Some retries failed`, {
          id: t,
          description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0].error})`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't retry failed items`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRetrying(false);
    }
  }

  const failedCount = failedIds.length;
  const noFailures = failedCount === 0;

  return (
    <button
      type="button"
      onClick={retryAll}
      disabled={retrying || noFailures}
      aria-label={
        noFailures
          ? "No failed entries to retry"
          : `Retry all ${failedCount} failed entries`
      }
      title={
        noFailures
          ? "No failed entries to retry"
          : `Retry ${failedCount} failed ${failedCount === 1 ? "entry" : "entries"}`
      }
      className={cn(
        "flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
        "bg-destructive/10 text-destructive border border-destructive/40",
        "hover:bg-destructive/20 hover:border-destructive/60",
        "focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:opacity-50 disabled:cursor-wait cursor-pointer",
      )}
    >
      {retrying ? (
        <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <RotateCcw aria-hidden className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
