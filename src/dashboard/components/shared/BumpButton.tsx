import { useState } from "react";
import { ArrowUp } from "lucide-react";
import { toast } from "@/lib/notify";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, compact } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import type { WorkflowActionDescriptor } from "../../../domain/workflow-runtime/types.js";
import { findEnabledAction } from "@/lib/workflow-action-utils";

interface BumpButtonProps {
  workflow: string;
  id: string;
  runId?: string;
  subject?: string;
  /** Projection action descriptors — when set, bump renders only when enabled. */
  actions?: WorkflowActionDescriptor[];
  size?: "sm" | "md";
  className?: string;
}

/**
 * Footer bump (▲) — move a queued row to the head of its priority queue. Self-
 * hides like the other footer buttons: only the kernel `bump` descriptor (which
 * the projection enables for `pending` rows) makes it render. A 409 means the
 * daemon claimed the item between the click and the SQLite priority update.
 */
export function BumpButton({ workflow, id, runId, subject, actions, size = "sm", className }: BumpButtonProps) {
  const [pending, setPending] = useState(false);
  const bumpAction = findEnabledAction(actions, "bump");
  const bumpEnabled = actions ? Boolean(bumpAction) : true;

  if (!bumpEnabled) return null;

  const label = subject?.trim() || id;

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Bumping ${label}…`);
    try {
      const res = await fetch("/api/queue/bump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(compact({ workflow, id, runId })),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        toast.success("Bumped to top", { id: t, description: label });
      } else if (res.status === 409) {
        toast.warning("Already in progress", {
          id: t,
          description: body.error ?? "This item was picked up before it could be bumped.",
        });
      } else {
        toast.error("Bump failed", { id: t, description: body.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error("Bump failed", { id: t, description: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconActionButton
          size={size}
          tone="primary"
          label="Move up in queue"
          pending={pending}
          onClick={onClick}
          icon={<ArrowUp className="h-3.5 w-3.5" />}
          className={cn(
            "rounded-md text-muted-foreground bg-transparent",
            "hover:text-primary hover:bg-muted",
            "focus-visible:ring-primary/40",
            className,
          )}
          spinnerClassName="text-primary"
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Move up in queue
      </TooltipContent>
    </Tooltip>
  );
}
