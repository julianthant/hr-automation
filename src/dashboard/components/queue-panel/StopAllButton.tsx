import { useState } from "react";
import { Loader2, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface StopAllItem {
  id: string;
  status: "pending" | "running";
  runId?: string;
}

interface StopAllButtonProps {
  workflow: string;
  items: StopAllItem[];
}

export function StopAllButton({ workflow, items }: StopAllButtonProps) {
  const [pending, setPending] = useState(false);
  const n = items.length;

  async function stopAll() {
    if (pending) return;
    if (n === 0) {
      toast.message("Nothing to stop", {
        description: "No pending or running entries in the current view.",
      });
      return;
    }
    setPending(true);
    const t = toast.loading(`Stopping ${n} ${n === 1 ? "entry" : "entries"}…`);
    try {
      const res = await fetch("/api/cancel-active-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, items }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        count?: number;
        errors?: Array<{ id: string; error: string }>;
        error?: string;
      };
      const errors = body.errors ?? [];
      if (!res.ok) {
        toast.error(res.status === 422 ? "Couldn't stop any entries" : "Couldn't stop entries", {
          id: t,
          description:
            errors.length > 0
              ? `${errors[0]!.error}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`
              : body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (errors.length === 0) {
        toast.success(`Stopped ${body.count} ${body.count === 1 ? "entry" : "entries"}`, { id: t });
      } else {
        toast.warning(`Some stops failed`, {
          id: t,
          description: `${body.count} stopped · ${errors.length} failed (${errors[0]!.error})`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't stop entries`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={stopAll}
      disabled={pending}
      aria-label={
        n === 0
          ? "Stop all pending and running entries (none in view)"
          : `Stop ${n} pending or running ${n === 1 ? "entry" : "entries"}`
      }
      title={
        n === 0
          ? "Stop pending + running entries in this view"
          : `Cancel ${n} pending/queued or in-progress ${n === 1 ? "run" : "runs"}`
      }
      className={cn(
        "flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
        "bg-warning/15 text-warning border border-warning/45",
        "hover:bg-warning/25 hover:border-warning/65",
        "focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:opacity-50 disabled:cursor-wait cursor-pointer",
      )}
    >
      {pending ? (
        <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Square aria-hidden className="w-3.5 h-3.5 fill-current" />
      )}
    </button>
  );
}
