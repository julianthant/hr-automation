import { useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface RetryAllButtonProps {
  workflow: string;
  /** Entries in the current queue scope (any status). Resolved prep rows are omitted upstream. */
  ids: string[];
  /** When set (batch queue mode), retries are stamped with this batch parent id. */
  parentRunId?: string;
}

export function RetryAllButton({ workflow, ids, parentRunId }: RetryAllButtonProps) {
  const [retrying, setRetrying] = useState(false);

  async function retryAll() {
    if (retrying) return;
    if (ids.length === 0) {
      toast.message("Nothing to retry", { description: "No entries in the current view." });
      return;
    }
    setRetrying(true);
    const t = toast.loading(`Retrying ${ids.length} items…`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          ids,
          ...(parentRunId ? { parentRunId } : {}),
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        count: number;
        errors: Array<{ id: string; error: string }>;
      };
      if (body.errors.length === 0) {
        toast.success(`Retry scheduled`, {
          id: t,
          description: `${body.count} of ${ids.length} items re-added to queue`,
        });
      } else {
        toast.warning(`Some retries failed`, {
          id: t,
          description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0].error})`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't retry items`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRetrying(false);
    }
  }

  const n = ids.length;

  return (
    <button
      type="button"
      onClick={retryAll}
      disabled={retrying}
      aria-label={
        n === 0 ? "Retry all entries (none in view)" : `Retry all ${n} entries in this view`
      }
      title={
        n === 0
          ? "Re-queue every row in this view (any status)"
          : `Retry ${n} ${n === 1 ? "entry" : "entries"} (any status)`
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
