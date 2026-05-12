import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DeleteAllButtonProps {
  workflow: string;
  date: string;
  entries: Array<{ id: string; runId?: string }>;
  onDeleted: (ids: string[]) => void;
}

export function DeleteAllButton({ workflow, date, entries, onDeleted }: DeleteAllButtonProps) {
  const [pending, setPending] = useState(false);
  const n = entries.length;
  const entryIds = entries.map((entry) => entry.id);

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
    setPending(true);
    const t = toast.loading(`Deleting ${n} ${n === 1 ? "entry" : "entries"}…`);
    try {
      const res = await fetch("/api/delete-bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, date, items: entries }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        count?: number;
        errors?: Array<{ id: string; error: string }>;
        error?: string;
      };
      const errors = body.errors ?? [];
      if (!res.ok) {
        toast.error(res.status === 422 ? "Couldn't delete any entries" : "Couldn't delete entries", {
          id: t,
          description:
            errors.length > 0
              ? `${errors[0]!.error}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`
              : body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (errors.length === 0) {
        toast.success(`Deleted ${body.count} ${body.count === 1 ? "entry" : "entries"}`, { id: t });
        onDeleted(entryIds);
      } else {
        toast.warning(`Some deletes failed`, {
          id: t,
          description: `${body.count} removed · ${errors.length} failed (${errors[0]!.error})`,
        });
        const failed = new Set(errors.map((e) => e.id));
        onDeleted(entryIds.filter((id) => !failed.has(id)));
      }
    } catch (err) {
      toast.error(`Couldn't delete entries`, {
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
      onClick={deleteAll}
      disabled={pending}
      aria-label={n === 0 ? "Delete all queue entries (none in view)" : `Delete all ${n} queue entries in view`}
      title={n === 0 ? "Delete all entries in this view" : `Delete ${n} ${n === 1 ? "entry" : "entries"} in this view`}
      className={cn(
        "flex-shrink-0 h-8 w-8 flex items-center justify-center rounded-lg transition-colors outline-none",
        "bg-destructive/15 text-destructive border border-destructive/50",
        "hover:bg-destructive/25 hover:border-destructive/70",
        "focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:opacity-50 disabled:cursor-wait cursor-pointer",
      )}
    >
      {pending ? (
        <Loader2 aria-hidden className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Trash2 aria-hidden className="w-3.5 h-3.5" />
      )}
    </button>
  );
}
