import { useState, useMemo, type MouseEvent } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { resolveDaemonBatchQueueTitle } from "./batch-queue-view";
import { GroupRowBase } from "./group-row-base";

export interface DaemonBatchRowProps {
  workflow: string;
  /** Tracker date — required for bulk delete API. */
  date?: string;
  /** Shared `parentRunId` / dashboard batch id for all members. */
  batchParentRunId: string;
  /** Workflow label for display (kernel registry). */
  workflowLabel: string;
  memberEntries: TrackerEntry[];
  isBatchQueueFocused: boolean;
  onEnterBatchQueue: (batchParentRunId: string) => void;
  /**
   * When false, the row is display-only (no drill-in). Use inside surfaces
   * where nested batch navigation is forbidden.
   */
  batchDrillInEnabled?: boolean;
  /** Called after bulk-delete removes rows so the parent can clear selection. */
  onDeletedIds?: (ids: string[]) => void;
}

/**
 * Summary card for a **daemon / dashboard batch**: multiple queue items that
 * share the same `parentRunId` from one multi-enqueue or batch-context run.
 */
export function DaemonBatchRow({
  workflow,
  date,
  batchParentRunId,
  workflowLabel,
  memberEntries,
  isBatchQueueFocused,
  onEnterBatchQueue,
  batchDrillInEnabled = true,
  onDeletedIds,
}: DaemonBatchRowProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const memberDeleteItems = useMemo(
    () =>
      memberEntries.map((entry) => ({
        id: entry.id,
        ...(entry.runId ? { runId: entry.runId } : {}),
      })),
    [memberEntries],
  );
  const memberIds = useMemo(() => memberDeleteItems.map((entry) => entry.id), [memberDeleteItems]);
  const firstTimestamp = useMemo(
    () =>
      [...memberEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0]?.timestamp,
    [memberEntries],
  );
  const title = useMemo(
    () => resolveDaemonBatchQueueTitle(workflowLabel, memberEntries, batchParentRunId),
    [workflowLabel, memberEntries, batchParentRunId],
  );

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
    const t = toast.loading(`Deleting ${n} ${n === 1 ? "entry" : "entries"}…`);
    try {
      const res = await fetch("/api/delete-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, date, items: memberDeleteItems }),
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
        toast.warning(`Some deletes failed`, {
          id: t,
          description: `${body.count} removed · ${errors.length} failed (${errors[0]!.error})`,
        });
        const failed = new Set(errors.map((x) => x.id));
        onDeletedIds?.(memberIds.filter((id) => !failed.has(id)));
      }
    } catch (err) {
      toast.error(`Couldn't delete batch`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeleting(false);
    }
  }

  async function retryAllInBatch(ev: MouseEvent<HTMLButtonElement>) {
    ev.stopPropagation();
    if (retrying || memberIds.length === 0) return;
    setRetrying(true);
    const t = toast.loading(`Retrying ${memberIds.length} items…`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          ids: memberIds,
          parentRunId: batchParentRunId,
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
          description: `${body.count} of ${memberIds.length} items re-added to queue`,
        });
      } else {
        toast.warning(`Some retries failed`, {
          id: t,
          description: `${body.count} succeeded · ${body.errors.length} failed (${body.errors[0]?.error})`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't retry`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRetrying(false);
    }
  }

  const footerActions = (
    <>
      {memberIds.length > 0 && (
        <button
          type="button"
          aria-label={`Retry all ${memberIds.length} ${memberIds.length === 1 ? "item" : "items"} in this batch`}
          title="Re-queue every row in this batch (any status)"
          disabled={retrying}
          onClick={retryAllInBatch}
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors outline-none",
            "text-muted-foreground bg-transparent",
            "hover:text-foreground hover:bg-muted",
            "focus-visible:ring-2 focus-visible:ring-primary/40",
            "disabled:opacity-60 disabled:cursor-wait",
          )}
        >
          {retrying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      )}
      {memberIds.length > 0 && date ? (
        <button
          type="button"
          aria-label="Delete all entries in this batch"
          title="Delete entire batch"
          disabled={deleting}
          onClick={deleteEntireBatch}
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors outline-none",
            "text-muted-foreground bg-transparent",
            "hover:text-destructive hover:bg-destructive/10",
            "focus-visible:ring-2 focus-visible:ring-destructive/40",
            "disabled:opacity-60 disabled:cursor-wait",
          )}
        >
          {deleting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      ) : null}
    </>
  );

  return (
    <GroupRowBase
      variant="batch"
      title={title}
      parentRunId={batchParentRunId}
      members={memberEntries}
      countTone="neutral"
      footerLabelPrefix="batch"
      firstTimestamp={firstTimestamp}
      isFocused={isBatchQueueFocused}
      drillInEnabled={batchDrillInEnabled}
      onEnter={onEnterBatchQueue}
      footerActions={footerActions}
    />
  );
}
