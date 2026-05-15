import { useState } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";

interface DeleteButtonProps {
  workflow: string;
  id: string;
  date: string;
  /** Optional run scope. Omit to delete every run for the queue item. */
  runId?: string;
  /** Called after the delete succeeds so the parent can remove the entry from state. */
  onDeleted: (id: string) => void;
  /** "sm" = 24×24 for inline queue rows. "md" = 32×32 for the LogPanel header. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Permanently removes either a queue item or one scoped run from the JSONL
 * tracker files and the SQLite projection via POST /api/delete-entry.
 * Non-reversible — the tooltip and destructive styling make the intent clear.
 */
export function DeleteButton({ workflow, id, date, runId, onDeleted, size = "sm", className }: DeleteButtonProps) {
  const [pending, setPending] = useState(false);
  const label = runId ? "Delete this run permanently" : "Delete this entry permanently";

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch("/api/delete-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id, date, ...(runId ? { runId } : {}) }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        onDeleted(id);
      } else {
        toast.error("Couldn't delete entry", { description: body.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error("Couldn't delete entry", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  const iconClass = "h-3.5 w-3.5";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <IconActionButton
          size={size}
          tone="destructive"
          label={label}
          pending={pending}
          onClick={onClick}
          icon={<Trash2 className={iconClass} />}
          className={cn(
            size === "md"
              ? cn(
                  "rounded-lg bg-destructive/10 text-destructive border border-destructive/40",
                  "hover:bg-destructive/20 hover:border-destructive/60",
                  "focus-visible:ring-destructive",
                )
              : cn(
                  "rounded-md text-muted-foreground bg-transparent",
                  "hover:text-destructive hover:bg-destructive/10",
                  "focus-visible:ring-destructive/40",
                ),
            className,
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {runId ? "Delete run permanently" : "Delete entry permanently"}
      </TooltipContent>
    </Tooltip>
  );
}
