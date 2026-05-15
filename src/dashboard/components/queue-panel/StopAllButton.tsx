import { useMemo } from "react";
import { Square } from "lucide-react";
import { toast } from "sonner";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { usePostAction } from "@/components/hooks/usePostAction";

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
  const n = items.length;
  const stopToasts = useMemo(() => ({
    loading: `Stopping ${n} ${n === 1 ? "entry" : "entries"}...`,
    success: (body: { count?: number }) => ({
      message: `Stopped ${body.count} ${body.count === 1 ? "entry" : "entries"}`,
    }),
    partial: (body: { count?: number; errors: Array<{ error: string }> }) => ({
      message: "Some stops failed",
      description: `${body.count} stopped · ${body.errors.length} failed (${body.errors[0]?.error})`,
    }),
    error: (msg: string, status?: number) => ({
      message: status === 422 ? "Couldn't stop any entries" : "Couldn't stop entries",
      description: msg,
    }),
    isPartial: (body: { errors?: unknown[] }) => Boolean(body.errors?.length),
  }), [n]);
  const { pending, run: postStopAll } = usePostAction<{
    ok?: boolean;
    count?: number;
    errors?: Array<{ id: string; error: string }>;
    error?: string;
  }>("/api/cancel-active-bulk", stopToasts);

  async function stopAll() {
    if (pending) return;
    if (n === 0) {
      toast.message("Nothing to stop", {
        description: "No pending or running entries in the current view.",
      });
      return;
    }
    await postStopAll({ workflow, items });
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
