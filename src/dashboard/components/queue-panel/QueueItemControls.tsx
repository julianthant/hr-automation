import { useState } from "react";
import { ArrowUp, X } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, compact } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import type { TrackerEntry } from "@/components/shared/types";

interface QueueItemControlsProps {
  workflow: string;
  id: string;
  runId?: string;
  subject?: string;
  entry?: TrackerEntry;
  className?: string;
}

interface QueueCancelRequestArgs {
  workflow: string;
  id: string;
  runId?: string;
  entry?: TrackerEntry;
}

export function buildQueueCancelRequest({ workflow, id, runId, entry }: QueueCancelRequestArgs): {
  path: string;
  body: Record<string, string>;
} {
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

  if (!ocrPrep) {
    return {
      path: "/api/cancel-queued",
      body: compact({ workflow, id, runId }),
    };
  }

  return {
    path: "/api/ocr/discard-prepare",
    body: compact({
      sessionId: ocrPrep.ocrSessionId,
      runId: ocrPrep.ocrRunId,
      reason: `Cancelled from ${workflow} queue`,
      parentWorkflow: workflow,
      parentRunId: runId,
      parentItemId: id,
      formType: ocrPrep.formType,
    }),
  };
}

/**
 * Cancel (×) + Bump (▲) icon buttons for pending queue rows.
 * 409s from the backend are surfaced as warnings — the daemon claimed the
 * item between the user's click and the backend lock.
 */
export function QueueItemControls({ workflow, id, runId, subject, entry, className }: QueueItemControlsProps) {
  const [pending, setPending] = useState<"cancel" | "bump" | null>(null);
  const label = subject?.trim() || id;

  const post = async (path: string, body: Record<string, string>, action: "cancel" | "bump") => {
    setPending(action);
    const verbing = action === "cancel" ? "Cancelling" : "Bumping";
    const verbed = action === "cancel" ? "Cancelled" : "Bumped to top";
    const t = toast.loading(`${verbing} ${label}…`);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json()) as { ok: boolean; error?: string };
      if (resBody.ok) {
        toast.success(verbed, { id: t, description: label });
      } else if (res.status === 409) {
        toast.warning(`Already in progress`, {
          id: t,
          description: resBody.error ?? "This item was picked up before the action could complete.",
        });
      } else {
        toast.error(`${action === "cancel" ? "Cancel" : "Bump"} failed`, {
          id: t,
          description: resBody.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`${action === "cancel" ? "Cancel" : "Bump"} failed`, {
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
    const request = buildQueueCancelRequest({ workflow, id, runId, entry });
    void post(request.path, request.body, "cancel");
  };

  const onBumpClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    void post("/api/queue/bump", compact({ workflow, id, runId }), "bump");
  };

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconActionButton
            tone="primary"
            label="Bump to top of queue"
            pending={pending === "bump"}
            disabled={pending !== null}
            onClick={onBumpClick}
            icon={<ArrowUp className="h-3.5 w-3.5" />}
            className={cn(
              "text-muted-foreground bg-transparent",
              "hover:text-primary hover:bg-muted",
              "focus-visible:ring-primary/40",
            )}
            spinnerClassName="text-primary"
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Bump to top of queue
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconActionButton
            tone="destructive"
            label="Cancel queued item"
            pending={pending === "cancel"}
            disabled={pending !== null}
            onClick={onCancelClick}
            icon={<X className="h-3.5 w-3.5" />}
            className={cn(
              "text-muted-foreground bg-transparent",
              "hover:text-destructive hover:bg-muted",
              "focus-visible:ring-destructive/40",
            )}
            spinnerClassName="text-destructive"
          />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          Cancel queued item
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
