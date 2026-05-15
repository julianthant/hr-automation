import { useState } from "react";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { IconActionButton } from "@/components/shared/IconActionButton";

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
    <IconActionButton
      size="md"
      tone="warning"
      onClick={stopAll}
      pending={pending}
      label={
        n === 0
          ? "Stop all pending and running entries (none in view)"
          : `Stop ${n} pending or running ${n === 1 ? "entry" : "entries"}`
      }
      title={
        n === 0
          ? "Stop pending + running entries in this view"
          : `Cancel ${n} pending/queued or in-progress ${n === 1 ? "run" : "runs"}`
      }
      icon={<Square aria-hidden className="w-3.5 h-3.5 fill-current" />}
      className="rounded-lg"
    />
  );
}
