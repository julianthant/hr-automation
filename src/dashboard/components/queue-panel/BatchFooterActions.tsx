import { useMemo, useState, type MouseEvent } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { IconActionButton } from "@/components/shared/IconActionButton";

export interface BatchFooterActionsProps {
  workflow: string;
  date?: string;
  batchParentRunId: string;
  memberEntries: TrackerEntry[];
  onDeletedIds?: (ids: string[]) => void;
}

export function BatchFooterActions({
  workflow,
  date,
  batchParentRunId,
  memberEntries,
  onDeletedIds,
}: BatchFooterActionsProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const memberItems = useMemo(
    () =>
      memberEntries.map((entry) => ({
        id: entry.id,
        ...(entry.runId ? { runId: entry.runId } : {}),
      })),
    [memberEntries],
  );
  const memberIds = useMemo(() => memberItems.map((entry) => entry.id), [memberItems]);

  async function deleteEntireBatch(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (deleting || memberIds.length === 0 || !date) return;
    const n = memberIds.length;
    if (
      !window.confirm(
        `Permanently delete all ${n} entr${n === 1 ? "y" : "ies"} in this batch? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    const t = toast.loading(`Deleting ${n} ${n === 1 ? "entry" : "entries"}...`);
    try {
      const res = await fetch("/api/delete-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, date, items: memberItems }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        count?: number;
        errors?: Array<{ id: string; error: string }>;
        error?: string;
      };
      const errors = body.errors ?? [];
      if (!res.ok) {
        toast.error(res.status === 422 ? "Couldn't delete any entries" : "Couldn't delete entries", {
          id: t,
          description:
            errors.length > 0
              ? `${errors[0]!.error}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`
              : body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (errors.length === 0) {
        toast.success(`Deleted ${body.count} ${body.count === 1 ? "entry" : "entries"}`, {
          id: t,
        });
        onDeletedIds?.(memberIds);
      } else {
        toast.warning("Some deletes failed", {
          id: t,
          description: `${body.count} removed · ${errors.length} failed (${errors[0]!.error})`,
        });
        const failed = new Set(errors.map((x) => x.id));
        onDeletedIds?.(memberIds.filter((id) => !failed.has(id)));
      }
    } catch (err) {
      toast.error("Couldn't delete batch", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  }

  async function retryAllInBatch(ev: MouseEvent<HTMLButtonElement>) {
    ev.stopPropagation();
    if (retrying || memberItems.length === 0) return;
    setRetrying(true);
    const t = toast.loading(`Retrying ${memberItems.length} items...`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          items: memberItems,
          date,
          parentRunId: batchParentRunId,
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        count: number;
        errors: Array<{ id: string; error: string }>;
      };
      if (body.errors.length === 0) {
        toast.success("Retry scheduled", {
          id: t,
          description: `${body.count} of ${memberItems.length} items re-added to queue`,
        });
      } else {
        toast.warning("Some retries failed", {
          id: t,
          description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0]?.error})`,
        });
      }
    } catch (err) {
      toast.error("Couldn't retry", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRetrying(false);
    }
  }

  return (
    <>
      {memberItems.length > 0 && (
        <IconActionButton
          tone="muted"
          label={`Retry all ${memberItems.length} ${memberItems.length === 1 ? "item" : "items"} in this batch`}
          title="Re-queue every row in this batch (any status)"
          pending={retrying}
          onClick={retryAllInBatch}
          icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />}
          className={cn(
            "text-muted-foreground bg-transparent",
            "hover:text-foreground hover:bg-muted",
            "focus-visible:ring-primary/40",
          )}
          spinnerClassName="text-primary"
        />
      )}
      {memberItems.length > 0 && date ? (
        <IconActionButton
          tone="destructive"
          label="Delete all entries in this batch"
          title="Delete entire batch"
          pending={deleting}
          onClick={deleteEntireBatch}
          icon={<Trash2 className="h-3.5 w-3.5" aria-hidden />}
          className={cn(
            "text-muted-foreground bg-transparent",
            "hover:text-destructive hover:bg-destructive/10",
            "focus-visible:ring-destructive/40",
          )}
        />
      ) : null}
    </>
  );
}
