import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "@/lib/notify";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { cn } from "@/lib/utils";
import { usePostAction } from "@/components/hooks/usePostAction";

interface RetryAllButtonProps {
  workflow: string;
  /** Entries in the current queue scope (any status). Resolved prep rows are omitted upstream. */
  ids: string[];
  items?: Array<{ id: string; runId?: string }>;
  /** Tracker date selected in the dashboard. */
  date?: string;
  /** When set (batch queue mode), retries are stamped with this batch parent id. */
  parentRunId?: string;
}

export function RetryAllButton({ workflow, ids, items, date, parentRunId }: RetryAllButtonProps) {
  const retryItems = items ?? ids.map((id) => ({ id }));
  const n = retryItems.length;
  const retryToasts = useMemo(() => ({
    loading: `Retrying ${n} items...`,
    success: (body: { count: number }) => ({
      message: "Retry scheduled",
      description: `${body.count} of ${n} items re-added to queue`,
    }),
    partial: (body: { count: number; errors: Array<{ error: string }> }) => ({
      message: "Some retries failed",
      description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0]?.error})`,
    }),
    error: (msg: string) => ({
      message: "Couldn't retry items",
      description: msg,
    }),
    isPartial: (body: { errors?: unknown[] }) => Boolean(body.errors?.length),
  }), [n]);
  const { pending: retrying, run: postRetryAll } = usePostAction<{
    ok: boolean;
    count: number;
    errors: Array<{ id: string; error: string }>;
  }>("/api/retry-bulk", retryToasts);

  async function retryAll() {
    if (retrying) return;
    if (retryItems.length === 0) {
      toast.message("Nothing to retry", { description: "No entries in the current view." });
      return;
    }
    await postRetryAll({
      workflow,
      items: retryItems,
      ...(date ? { date } : {}),
      ...(parentRunId ? { parentRunId } : {}),
    });
  }

  return (
    <IconActionButton
      size="md"
      tone="destructive"
      onClick={retryAll}
      pending={retrying}
      label={
        n === 0 ? "Retry all entries (none in view)" : `Retry all ${n} entries in this view`
      }
      title={
        n === 0
          ? "Re-queue every row in this view (any status)"
          : `Retry ${n} ${n === 1 ? "entry" : "entries"} (any status)`
      }
      icon={<RotateCcw aria-hidden className="w-3.5 h-3.5" />}
      className={cn(
        "rounded-lg",
        "bg-destructive/10 text-destructive border border-destructive/40",
        "hover:bg-destructive/20 hover:border-destructive/60",
        "focus-visible:ring-destructive",
      )}
    />
  );
}
