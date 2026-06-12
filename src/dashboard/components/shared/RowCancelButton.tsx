import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { useWorkflowActionDispatcher } from "@/components/hooks/useWorkflowActionDispatcher";
import { IconActionButton } from "@/components/shared/IconActionButton";
import type { WorkflowActionDescriptor } from "../../../domain/workflow-runtime/types.js";
import { findEnabledAction } from "@/lib/workflow-action-utils";
import {
  buildRowCancelDispatchArgs,
  isOcrPrepProxyEntry,
  resolveRowCancelStatus,
} from "@/lib/row-cancel-request";

interface RowCancelButtonProps {
  workflow: string;
  id: string;
  runId?: string;
  date?: string;
  subject?: string;
  /**
   * Tracker entry — used to detect OCR-prep parent rows that must route through
   * discard, and to read the row status when the action descriptor omits it.
   */
  entry?: TrackerEntry;
  /** Projection action descriptors — when set, cancel renders only when enabled. */
  actions?: WorkflowActionDescriptor[];
  size?: "sm" | "md";
  className?: string;
}

/**
 * Unified footer cancel (×). Self-hides exactly like {@link RetryButton} /
 * {@link DeleteButton}: when `actions` is provided it renders only if the
 * kernel marks `cancel` enabled (running + queued rows; never terminal rows).
 *
 * One button, three routes — picked from the target status, not a prop:
 *   - running row  → `status: "running"` → `buildCancelRunningHandler`
 *   - queued row   → `status: "pending"` → `buildCancelQueuedHandler`
 *   - OCR-prep row → queued cancel + OCR context → discard handler
 *
 * Contract 5: one `/api/cancel-queued` route, status discriminates the handler.
 */
export function RowCancelButton({
  workflow,
  id,
  runId,
  date,
  subject,
  entry,
  actions,
  size = "sm",
  className,
}: RowCancelButtonProps) {
  const [pending, setPending] = useState(false);
  const { dispatchWorkflowAction } = useWorkflowActionDispatcher();
  const cancelAction = findEnabledAction(actions, "cancel");
  const cancelEnabled = actions ? Boolean(cancelAction) : true;

  if (!cancelEnabled) return null;

  const label = subject?.trim() || id;
  const isOcrPrep = isOcrPrepProxyEntry(entry);
  const isRunning = resolveRowCancelStatus({ workflow, id, runId, date, entry, actions }) === "running";

  const tooltip = isOcrPrep ? "Discard OCR prep" : isRunning ? "Stop running item" : "Cancel queued item";

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    const verbing = isOcrPrep ? "Discarding OCR prep" : isRunning ? "Stopping" : "Cancelling";
    const t = toast.loading(`${verbing} ${label}…`);
    try {
      const result = await dispatchWorkflowAction<{ ok?: boolean; error?: string }>(
        buildRowCancelDispatchArgs({ workflow, id, runId, date, entry, actions }),
      );
      if (result.ok) {
        toast.success(isOcrPrep ? "OCR prep discarded" : isRunning ? `Stopped ${label}` : "Cancelled", {
          id: t,
          description: label,
        });
      } else if (result.status === 409) {
        toast.warning("Already in progress", {
          id: t,
          description: result.error ?? "This item was picked up before the action could complete.",
        });
      } else {
        toast.error(isOcrPrep ? "Couldn't discard OCR prep" : "Cancel failed", {
          id: t,
          description: result.error ?? `HTTP ${result.status}`,
        });
      }
    } catch (err) {
      toast.error(isOcrPrep ? "Couldn't discard OCR prep" : "Cancel failed", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconActionButton
          size={size}
          tone="destructive"
          label={tooltip}
          pending={pending}
          onClick={onClick}
          icon={<X className="h-3.5 w-3.5" />}
          className={cn(
            "rounded-md text-muted-foreground bg-transparent",
            "hover:text-destructive hover:bg-destructive/10",
            "focus-visible:ring-destructive/40",
            className,
          )}
          spinnerClassName="text-destructive"
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
