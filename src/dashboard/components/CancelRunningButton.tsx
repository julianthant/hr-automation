import { useState } from "react";
import { Square, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { clearActionToast, registerActionToast } from "./hooks/useActionToasts";
import type { TrackerEntry } from "./types";

interface CancelRunningButtonProps {
  workflow: string;
  id: string;
  runId: string;
  /** Tracker entry — used to detect prep-parent rows that need OCR discard
   *  routing instead of the kernel cancel-running path. Optional for legacy
   *  callers that don't have the entry handy (kernel daemon items only). */
  entry?: TrackerEntry;
  className?: string;
}

/**
 * Cancel the running item belonging to a daemon. Posts to
 * `/api/cancel-running`, which proxies to the daemon's `/cancel-current`
 * endpoint. The cancel is **cooperative**: the kernel checks the flag at
 * the next `ctx.step(...)` boundary and throws `CancelledError`, which
 * surfaces as a tracker `failed` row with `step="cancelled"`. Latency is
 * 0–30s depending on what the in-flight step is doing — the toast wording
 * tells the user this so a "Cancel requested" toast that takes 25s to
 * materialize on the dashboard doesn't feel stuck.
 *
 * Confirms via lightweight sonner action toast (matching QueueItemControls'
 * cancel-queued pattern) — destructive but recoverable, since the kernel
 * marks the item failed (retryable).
 */
export function CancelRunningButton({ workflow, id, runId, entry, className }: CancelRunningButtonProps) {
  const [pending, setPending] = useState(false);

  // OCR-prep parent rows live in the downstream workflow's queue but aren't
  // daemon-claimed — they're tracker-only proxies for the OCR session. The
  // /api/cancel-running endpoint would 4xx with "not claimed by any daemon".
  // Route to /api/ocr/discard-prepare with the OCR session info from data;
  // the discard handler mirrors `failed step=discarded` back onto this row.
  const ocrPrep =
    entry?.data?.mode === "prepare"
      && typeof entry.data.ocrSessionId === "string"
      && typeof entry.data.ocrRunId === "string"
      ? { ocrSessionId: entry.data.ocrSessionId, ocrRunId: entry.data.ocrRunId }
      : null;

  const fire = async () => {
    if (ocrPrep) return fireOcrDiscard();
    return fireKernelCancel();
  };

  const fireOcrDiscard = async () => {
    if (!ocrPrep) return;
    setPending(true);
    const t = toast.loading(`Discarding OCR prep ${id}…`, {
      description: "Cancelling the OCR session and removing this row from the queue.",
    });
    try {
      const res = await fetch("/api/ocr/discard-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: ocrPrep.ocrSessionId,
          runId: ocrPrep.ocrRunId,
          reason: `Cancelled from ${workflow} queue`,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        toast.success("OCR prep discarded", { id: t });
      } else {
        toast.error("Couldn't discard OCR prep", {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
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

  const fireKernelCancel = async () => {
    setPending(true);
    // Loading toast is held open until the entries SSE observes a terminal
    // status for (workflow, id, runId). The kind="cancel-running" entry in
    // the action-toast registry maps the toast id so resolveActionToastsForEntry
    // (called from App's entries effect) can update it in-place when the
    // tracker writes step="cancelled" or any other terminal state.
    const t = toast.loading(`Cancelling ${id}…`, {
      description: "Daemon stops at the next step boundary (up to 30s).",
    });
    registerActionToast({
      toastId: t,
      workflow,
      id,
      runId,
      kind: "cancel-running",
      timeoutMs: 30_000,
      fallbackMessage: `Still cancelling ${id}…`,
      fallbackDescription:
        "Daemon hasn't reached a step boundary yet. Check the entry status directly.",
    });
    try {
      const res = await fetch("/api/cancel-running", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id, runId }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string; accepted?: boolean };
      if (body.ok) {
        // Daemon accepted the request — leave the loading toast open. SSE
        // will resolve it with a concrete "Cancelled" message once the
        // tracker row hits step="cancelled".
        return;
      }
      // Immediate failure: resolve the toast now and clear the registry
      // entry so the SSE effect ignores any later transitions for this run.
      if (res.status === 409) {
        toast.warning(`No matching item in flight`, {
          id: t,
          description: body.error ?? "The item likely just finished.",
        });
      } else if (res.status === 410) {
        toast.warning(`Item is no longer in flight`, {
          id: t,
          description: body.error ?? "Refresh to see current state.",
        });
      } else {
        toast.error(`Cancel failed`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
      clearActionToast(workflow, id, runId, "cancel-running");
    } catch (err) {
      toast.error(`Cancel failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
      clearActionToast(workflow, id, runId, "cancel-running");
    } finally {
      setPending(false);
    }
  };

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    if (ocrPrep) {
      toast(`Discard OCR prep ${id}?`, {
        description:
          "Cancels the OCR session for this PDF. You can re-upload to start over.",
        action: { label: "Discard prep", onClick: () => void fire() },
        cancel: { label: "Keep running", onClick: () => {} },
        duration: 8_000,
      });
      return;
    }
    toast(`Cancel running ${id}?`, {
      description:
        "The current item will fail at the next step. The daemon stays alive and picks up the next item.",
      action: { label: "Cancel item", onClick: () => void fire() },
      cancel: { label: "Keep running", onClick: () => {} },
      duration: 8_000,
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Cancel running item"
          disabled={pending}
          onClick={onClick}
          className={cn(
            "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
            "text-muted-foreground bg-transparent",
            "transition-colors duration-150",
            "hover:text-destructive hover:bg-muted",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
            "disabled:opacity-60 disabled:cursor-wait",
            className,
          )}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
          ) : (
            <Square className="h-3.5 w-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Cancel running item
      </TooltipContent>
    </Tooltip>
  );
}
