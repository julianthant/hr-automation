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
import { useWorkflowActionDispatcher } from "@/components/hooks/useWorkflowActionDispatcher";

export interface BatchFooterActionsProps {
  workflow: string;
  date?: string;
  batchParentRunId: string;
  memberEntries: TrackerEntry[];
  /** Override retry target rows; defaults to {@link memberEntries}. */
  retryMemberEntries?: TrackerEntry[];
  /** Override delete target rows; defaults to {@link memberEntries}. */
  deleteMemberEntries?: TrackerEntry[];
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
  if (descriptor.targets.length === 0) return memberEntries;
  const entriesByTarget = new Map(
    memberEntries.map((entry) => [`${entry.workflow}\0${entry.runId ?? entry.id}`, entry]),
  );
  return descriptor.targets
    .map((target) => entriesByTarget.get(`${target.workflowId}\0${target.runId ?? target.id}`))
    .filter((entry): entry is TrackerEntry => entry !== undefined);
}

export function BatchFooterActions({
  workflow,
  date,
  batchParentRunId,
  memberEntries,
  retryMemberEntries,
  deleteMemberEntries,
  projection,
  actions,
  onDeletedIds,
}: BatchFooterActionsProps) {
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { dispatchBulkWorkflowAction } = useWorkflowActionDispatcher();

  const actionDescriptors = projection?.actions ?? actions;
  const retrySourceEntries = retryMemberEntries ?? memberEntries;
  const deleteSourceEntries = deleteMemberEntries ?? memberEntries;
  const retryEntries = useMemo(
    () => selectEntriesForWorkflowAction(retrySourceEntries, actionDescriptors, "retry"),
    [actionDescriptors, retrySourceEntries],
  );
  const deleteEntries = useMemo(
    () => selectEntriesForWorkflowAction(deleteSourceEntries, actionDescriptors, "delete"),
    [actionDescriptors, deleteSourceEntries],
  );
  const retryItems = useMemo(
    () =>
      retryEntries.map((entry) => ({
        workflowId: entry.workflow,
        id: entry.id,
        ...(entry.runId ? { runId: entry.runId } : {}),
      })),
    [retryEntries],
  );
  const deleteItems = useMemo(
    () =>
      deleteEntries.map((entry) => ({
        workflowId: entry.workflow,
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
      const result = await dispatchBulkWorkflowAction<{
        ok?: boolean;
        count?: number;
        errors?: Array<{ id: string; error: string }>;
        error?: string;
      }>({
        transport: "delete-bulk",
        kind: "delete",
        workflow,
        items: deleteItems,
        date,
        actions: actionDescriptors,
        source: "batch-view",
        scope: "visible-view",
      });
      const body = result.body;
      const errors = body.errors ?? [];
      if (!result.ok) {
        if (result.status === 0) {
          toast.error("Couldn't delete batch", {
            id: t,
            description: result.error,
          });
          return;
        }
        toast.error(result.status === 422 ? "Couldn't delete any entries" : "Couldn't delete entries", {
          id: t,
          description:
            errors.length > 0
              ? `${errors[0]!.error}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`
              : body.error ?? result.error ?? `HTTP ${result.status}`,
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
      const result = await dispatchBulkWorkflowAction<{
        ok: boolean;
        count: number;
        errors: Array<{ id: string; error: string }>;
        error?: string;
      }>({
        transport: "retry-bulk",
        kind: "retry",
        workflow,
        items: retryItems,
        date,
        parentRunId: batchParentRunId,
        actions: actionDescriptors,
        source: "batch-view",
        scope: "visible-view",
      });
      const body = result.body;
      if (!result.ok) {
        toast.error("Couldn't retry", {
          id: t,
          description: body.error ?? result.error,
        });
        return;
      }
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
