import { useState } from "react";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { useWorkflowActionDispatcher } from "@/components/hooks/useWorkflowActionDispatcher";
import { IconActionButton } from "@/components/shared/IconActionButton";
import type { WorkflowActionDescriptor } from "../../../domain/workflow-runtime/types.js";
import { findEnabledAction } from "@/lib/workflow-action-utils";

interface CancelRunningButtonProps {
  workflow: string;
  id: string;
  runId: string;
  subject?: string;
  /** Tracker entry — used to detect prep-parent rows that need OCR discard
   *  routing instead of the kernel cancel-running path. Optional for legacy
   *  callers that don't have the entry handy (kernel daemon items only). */
  entry?: TrackerEntry;
  actions?: WorkflowActionDescriptor[];
  className?: string;
}

/**
 * Stop the running item belonging to a daemon. Contract 5 unified soft and
 * force cancel into a single AbortSignal-based mechanism — the
 * `cancel-queued` transport now propagates into any in-flight Playwright
 * call within ms (via the per-run AbortController and the Page proxy in
 * `src/core/kernel/page-proxy.ts`), so the dashboard's old "Force Stop"
 * variant is no longer needed.
 */
export function CancelRunningButton({ workflow, id, runId, subject, entry, actions, className }: CancelRunningButtonProps) {
  const [pending, setPending] = useState(false);
  const { dispatchWorkflowAction } = useWorkflowActionDispatcher();
  const label = subject?.trim() || id;
  const cancelAction = findEnabledAction(actions, "cancel");
  const cancelEnabled = actions ? Boolean(cancelAction) : true;

  // OCR-prep parent rows live in the downstream workflow's queue but aren't
  // daemon-claimed — they're tracker-only proxies for the OCR session. Send
  // them through central cancel with OCR context so the action engine routes
  // to discard and mirrors `failed step=discarded` back onto this row.
  const ocrPrep =
    entry?.data?.mode === "prepare"
      && typeof entry.data.ocrSessionId === "string"
      && typeof entry.data.ocrRunId === "string"
      ? {
          ocrSessionId: entry.data.ocrSessionId,
          ocrRunId: entry.data.ocrRunId,
          formType: entry.data.formType,
        }
      : null;

  const fire = async () => {
    if (ocrPrep) return fireOcrDiscard();
    return fireStopNow();
  };

  const fireOcrDiscard = async () => {
    if (!ocrPrep) return;
    setPending(true);
    const t = toast.loading(`Discarding OCR prep ${label}…`, {
      description: "Cancelling the OCR session and removing this row from the queue.",
    });
    try {
      const result = await dispatchWorkflowAction<{ ok?: boolean; error?: string }>({
        transport: "cancel-queued",
        kind: "cancel",
        action: cancelAction,
        fallbackTarget: { workflowId: workflow, id, runId: ocrPrep.ocrRunId },
        // OCR prep parents aren't daemon-claimed — route through queued
        // cancel so discard executes via tracker-side OCR discard handler.
        status: "pending",
        ocrSessionId: ocrPrep.ocrSessionId,
        reason: `Cancelled from ${workflow} queue`,
        parentWorkflow: workflow,
        parentRunId: runId,
        parentItemId: id,
        formType: typeof ocrPrep.formType === "string" ? ocrPrep.formType : undefined,
      });
      if (result.ok) {
        toast.success("OCR prep discarded", { id: t });
      } else {
        toast.error("Couldn't discard OCR prep", {
          id: t,
          description: result.error ?? `HTTP ${result.status}`,
        });
      }
    } catch (err) {
      toast.error("Couldn't discard OCR prep", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  const fireStopNow = async () => {
    setPending(true);
    const t = toast.loading(`Stopping ${label}…`);
    try {
      const result = await dispatchWorkflowAction<{ ok?: boolean; error?: string }>({
        transport: "cancel-queued",
        kind: "cancel",
        action: cancelAction,
        fallbackTarget: { workflowId: workflow, id, runId },
        // Running row — backend must route through buildCancelRunningHandler.
        // Without this the route hardcodes status:"pending" and the daemon's
        // already-claimed lease causes a 409 ("use cancel running").
        status: "running",
      });
      if (result.ok) {
        toast.success(`Stopped ${label}`, {
          id: t,
          description: "Task marked cancelled; session and browser stop requested.",
        });
      } else {
        toast.error("Stop failed", {
          id: t,
          description: result.error ?? `HTTP ${result.status}`,
        });
      }
    } catch (err) {
      toast.error("Stop failed", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending || !cancelEnabled) return;
    void fire();
  };

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconActionButton
            tone="destructive"
            label={ocrPrep ? "Discard OCR prep" : "Stop running item"}
            pending={pending}
            disabled={!cancelEnabled}
            onClick={onClick}
            icon={<Square className="h-3.5 w-3.5" />}
            className="text-muted-foreground bg-transparent hover:text-destructive hover:bg-muted focus-visible:ring-destructive/40"
            spinnerClassName="text-destructive"
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {ocrPrep ? "Discard OCR prep" : "Stop running item"}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
