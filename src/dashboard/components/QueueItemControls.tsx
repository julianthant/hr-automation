import { useState } from "react";
import { ArrowUp, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface QueueItemControlsProps {
  workflow: string;
  id: string;
  className?: string;
}

/**
 * Cancel (×) + Bump (▲) icon buttons for pending queue rows.
 * Cancel uses a sonner action-toast as a lightweight confirm step
 * (rather than dragging in a full AlertDialog primitive that the
 * component library doesn't yet ship). 409s from the backend are
 * surfaced as warnings — the daemon claimed the item between the
 * user's click and the backend lock.
 */
export function QueueItemControls({ workflow, id, className }: QueueItemControlsProps) {
  const [pending, setPending] = useState<"cancel" | "bump" | null>(null);

  const post = async (path: string, action: "cancel" | "bump") => {
    setPending(action);
    const verbing = action === "cancel" ? "Cancelling" : "Bumping";
    const verbed = action === "cancel" ? "Cancelled" : "Bumped to top";
    const t = toast.loading(`${verbing} ${id}…`);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        toast.success(verbed, { id: t, description: id });
      } else if (res.status === 409) {
        toast.warning(`Already claimed`, {
          id: t,
          description: body.error ?? "A daemon picked it up before us.",
        });
      } else {
        toast.error(`${action} failed`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`${action} failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(null);
    }
  };

  const onCancelClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    // Lightweight confirm via toast.action — destructive but recoverable
    // (cancellation creates a `failed` row that can itself be retried).
    toast(`Cancel ${id}?`, {
      description: "Removes the item from the queue. Can be retried later.",
      action: {
        label: "Cancel item",
        onClick: () => post("/api/cancel-queued", "cancel"),
      },
      cancel: { label: "Keep", onClick: () => {} },
      duration: 8_000,
    });
  };

  const onBumpClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    void post("/api/queue/bump", "bump");
  };

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Bump to top of queue"
            disabled={pending !== null}
            onClick={onBumpClick}
            className={cn(
              "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
              "text-muted-foreground bg-transparent",
              "transition-colors duration-150",
              "hover:text-primary hover:bg-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              "disabled:opacity-60 disabled:cursor-wait",
            )}
          >
            {pending === "bump" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            ) : (
              <ArrowUp className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Bump to top of queue
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Cancel queued item"
            disabled={pending !== null}
            onClick={onCancelClick}
            className={cn(
              "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
              "text-muted-foreground bg-transparent",
              "transition-colors duration-150",
              "hover:text-destructive hover:bg-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
              "disabled:opacity-60 disabled:cursor-wait",
            )}
          >
            {pending === "cancel" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Cancel queued item
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
