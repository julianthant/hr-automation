import { useMemo } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { usePostAction } from "@/components/hooks/usePostAction";

interface DeleteAllButtonProps {
  workflow: string;
  date: string;
  entries: Array<{ id: string; runId?: string }>;
  onDeleted: (ids: string[]) => void;
}

export function DeleteAllButton({ workflow, date, entries, onDeleted }: DeleteAllButtonProps) {
  const n = entries.length;
  const entryIds = entries.map((entry) => entry.id);
  const deleteToasts = useMemo(() => ({
    loading: `Deleting ${n} ${n === 1 ? "entry" : "entries"}...`,
    success: (body: { count?: number }) => ({
      message: `Deleted ${body.count} ${body.count === 1 ? "entry" : "entries"}`,
    }),
    partial: (body: { count?: number; errors: Array<{ error: string }> }) => ({
      message: "Some deletes failed",
      description: `${body.count} removed · ${body.errors.length} failed (${body.errors[0]?.error})`,
    }),
    error: (msg: string, status?: number) => ({
      message: status === 422 ? "Couldn't delete any entries" : "Couldn't delete entries",
      description: msg,
    }),
    isPartial: (body: { errors?: unknown[] }) => Boolean(body.errors?.length),
  }), [n]);
  const { pending, run: postDeleteAll } = usePostAction<{
    ok?: boolean;
    count?: number;
    errors?: Array<{ id: string; error: string }>;
    error?: string;
  }>("/api/delete-bulk", deleteToasts);

  async function deleteAll() {
    if (pending) return;
    if (n === 0) {
      toast.message("Nothing to delete", { description: "No queue entries in the current view." });
      return;
    }
    const label = n === 1 ? "this queue entry" : `all ${n} queue entries`;
    if (
      !window.confirm(
        `Permanently delete ${label} for ${workflow} on ${date}? This cannot be undone.`,
      )
    ) {
      return;
    }
    const result = await postDeleteAll({ workflow, date, items: entries });
    if (result.ok && result.body) {
      const errors = result.body.errors ?? [];
      if (errors.length === 0) {
        onDeleted(entryIds);
      } else {
        const failed = new Set(errors.map((e) => e.id));
        onDeleted(entryIds.filter((id) => !failed.has(id)));
      }
    }
  }

  return (
    <IconActionButton
      size="md"
      tone="destructive"
      onClick={deleteAll}
      pending={pending}
      label={n === 0 ? "Delete all queue entries (none in view)" : `Delete all ${n} queue entries in view`}
      title={n === 0 ? "Delete all entries in this view" : `Delete ${n} ${n === 1 ? "entry" : "entries"} in this view`}
      icon={<Trash2 aria-hidden className="w-3.5 h-3.5" />}
      className={cn(
        "rounded-lg",
        "bg-destructive/15 text-destructive border border-destructive/50",
        "hover:bg-destructive/25 hover:border-destructive/70",
        "focus-visible:ring-destructive",
      )}
    />
  );
}
