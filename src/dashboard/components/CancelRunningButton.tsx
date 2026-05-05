import { useState } from "react";
import { Square, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";

interface CancelRunningButtonProps {
  workflow: string;
  id: string;
  runId: string;
  subject?: string;
  /** Tracker entry — used to detect prep-parent rows that need OCR discard
   *  routing instead of the kernel cancel-running path. Optional for legacy
   *  callers that don't have the entry handy (kernel daemon items only). */
  entry?: TrackerEntry;
  className?: string;
}

/**
 * Stop the running item belonging to a daemon. The primary control now uses
 * the force-stop endpoint directly so a single click actually stops the
 * browser-backed run instead of waiting on a cooperative step boundary.
 */
export function CancelRunningButton({ workflow, id, runId, subject, entry, className }: CancelRunningButtonProps) {
  const [pending, setPending] = useState(false);
  const label = subject?.trim() || id;

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
    return fireStopNow();
  };

  const fireOcrDiscard = async () => {
    if (!ocrPrep) return;
    setPending(true);
    const t = toast.loading(`Discarding OCR prep ${label}…`, {
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

  const fireStopNow = async () => {
    setPending(true);
    const t = toast.loading(`Stopping ${label}…`);
    try {
      const res = await fetch("/api/task/force-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id, runId }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        toast.success(`Stopped ${label}`, {
          id: t,
          description: "Task marked cancelled; session and browser stop requested.",
        });
      } else {
        toast.error("Stop failed", {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
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
    if (pending) return;
    void fire();
  };

  const buttonClass = cn(
    "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
    "text-muted-foreground bg-transparent",
    "transition-colors duration-150",
    "hover:text-destructive hover:bg-muted",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
    "disabled:opacity-60 disabled:cursor-wait",
  );

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={ocrPrep ? "Discard OCR prep" : "Stop running item"}
            disabled={pending}
            onClick={onClick}
            className={buttonClass}
          >
            {pending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {ocrPrep ? "Discard OCR prep" : "Stop running item"}
        </TooltipContent>
      </Tooltip>
    </span>
  );
}
