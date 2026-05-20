import { useMemo, useState, type MouseEvent } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { IconActionButton } from "@/components/shared/IconActionButton";
import type {
  WorkflowActionDescriptor,
  WorkflowRunProjection,
} from "../../../domain/workflow-runtime/types.js";

export interface BatchFooterActionsProps {
  workflow: string;
  date?: string;
  batchParentRunId: string;
  memberEntries: TrackerEntry[];
  projection?: WorkflowRunProjection;
  actions?: WorkflowActionDescriptor[];
  onDeletedIds?: (ids: string[]) => void;
}

export function selectEntriesForWorkflowAction(
  memberEntries: TrackerEntry[],
  actions: WorkflowActionDescriptor[] | undefined,
  kind: WorkflowActionDescriptor["kind"],
): TrackerEntry[] {
  const descriptor = actions?.find((action) => action.kind === kind && action.enabled);
  if (!descriptor) return actions ? [] : memberEntries;
  if (descriptor.targetRunIds.length === 0) return memberEntries;
  const entriesByRunId = new Map(memberEntries.map((entry) => [entry.runId ?? entry.id, entry]));
  return descriptor.targetRunIds
    .map((runId) => entriesByRunId.get(runId))
    .filter((entry): entry is TrackerEntry => entry !== undefined);
}

export function BatchFooterActions({
  workflow,
  date,
  batchParentRunId,
  memberEntries,
  projection,
  actions,
  onDeletedIds,
}: BatchFooterActionsProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const actionDescriptors = projection?.actions ?? actions;
  const retryEntries = useMemo(
    () => selectEntriesForWorkflowAction(memberEntries, actionDescriptors, "retry"),
    [actionDescriptors, memberEntries],
  );
  const deleteEntries = useMemo(
    () => selectEntriesForWorkflowAction(memberEntries, actionDescriptors, "delete"),
    [actionDescriptors, memberEntries],
  );
  const retryItems = useMemo(
    () =>
      retryEntries.map((entry) => ({
        id: entry.id,
        ...(entry.runId ? { runId: entry.runId } : {}),
      })),
    [retryEntries],
  );
  const deleteItems = useMemo(
    () =>
      deleteEntries.map((entry) => ({
        id: entry.id,
        ...(entry.runId ? { runId: entry.runId } : {}),
      })),
    [deleteEntries],
  );
  const deleteIds = useMemo(() => deleteItems.map((entry) => entry.id), [deleteItems]);

  async function deleteEntireBatch(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (deleting || deleteIds.length === 0 || !date) return;
    const n = deleteIds.length;
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
        body: JSON.stringify({ workflow, date, items: deleteItems }),
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
        onDeletedIds?.(deleteIds);
      } else {
        toast.warning("Some deletes failed", {
          id: t,
          description: `${body.count} removed · ${errors.length} failed (${errors[0]!.error})`,
        });
        const failed = new Set(errors.map((x) => x.id));
        onDeletedIds?.(deleteIds.filter((id) => !failed.has(id)));
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
    if (retrying || retryItems.length === 0) return;
    setRetrying(true);
    const t = toast.loading(`Retrying ${retryItems.length} items...`);
    try {
      const res = await fetch("/api/retry-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          items: retryItems,
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
          description: `${body.count} of ${retryItems.length} items re-added to queue`,
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
      {retryItems.length > 0 && (
        <IconActionButton
          tone="muted"
          label={`Retry all ${retryItems.length} ${retryItems.length === 1 ? "item" : "items"} in this batch`}
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
      {deleteItems.length > 0 && date ? (
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
