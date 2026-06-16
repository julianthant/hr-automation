import { useState } from "react";
import { XCircle } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { postWorkflowActionRequest } from "@/components/hooks/useWorkflowActionDispatcher";
import { buildOperationTreeCancelRequest } from "@/lib/row-cancel-request";

interface OperationCancelButtonProps {
  /** Coordinator's workflow id. */
  workflow: string;
  /** Coordinator's item id. */
  id: string;
  /** Coordinator's runId — BFS root for the tree-cancel. */
  runId?: string;
  /** Display subject for the toast (falls back to id). */
  subject?: string;
}

/**
 * "Cancel remaining" button for an operation coordinator (E2E-102).
 *
 * Posts `/api/cancel-queued` with `scope: "tree"` so the backend BFS
 * (`collectDescendants` in resolve-targets.ts) cancels every non-terminal
 * member linked by `parent_run_id` — queued members get the queued handler,
 * running members get the running handler — without touching sibling
 * operations. Terminal members (done/failed/skipped) are skipped by the BFS
 * automatically.
 *
 * The coordinator is a display row with no daemon task of its own; this
 * button is the ONE action that cancels the whole fan-out in a single click.
 * It is only rendered when non-terminal members exist (caller's gate).
 */
export function OperationCancelButton({
  workflow,
  id,
  runId,
  subject,
}: OperationCancelButtonProps) {
  const [pending, setPending] = useState(false);

  const label = subject?.trim() || id;

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Cancelling operation for ${label}…`);
    try {
      const result = await postWorkflowActionRequest<{ ok?: boolean; error?: string }>(
        buildOperationTreeCancelRequest({ workflow, id, runId }),
      );
      if (result.ok) {
        toast.success("Operation cancelled", {
          id: t,
          description: `All active members for ${label} have been cancelled.`,
        });
      } else if (result.status === 409) {
        toast.warning("Already in progress", {
          id: t,
          description: result.error ?? "One or more members were already being claimed.",
        });
      } else {
        toast.error("Cancel failed", {
          id: t,
          description: result.error ?? `HTTP ${result.status}`,
        });
      }
    } catch (err) {
      toast.error("Cancel failed", {
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
          size="sm"
          tone="destructive"
          label="Cancel remaining members"
          pending={pending}
          onClick={onClick}
          icon={<XCircle className="h-3.5 w-3.5" />}
          className={cn(
            "rounded-md text-muted-foreground bg-transparent",
            "hover:text-destructive hover:bg-destructive/10",
            "focus-visible:ring-destructive/40",
          )}
          spinnerClassName="text-destructive"
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Cancel remaining members
      </TooltipContent>
    </Tooltip>
  );
}
