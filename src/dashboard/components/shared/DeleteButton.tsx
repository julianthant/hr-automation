import { useState } from "react";
import { Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface DeleteButtonProps {
  workflow: string;
  id: string;
  date: string;
  /** Called after the delete succeeds so the parent can remove the entry from state. */
  onDeleted: (id: string) => void;
  /** "sm" = 24×24 for inline queue rows. "md" = 32×32 for the LogPanel header. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Permanently removes an entry and all its logs from the JSONL tracker files
 * and the SQLite projection via POST /api/delete-entry. Non-reversible — the
 * tooltip and destructive styling make the intent clear.
 */
export function DeleteButton({ workflow, id, date, onDeleted, size = "sm", className }: DeleteButtonProps) {
  const [pending, setPending] = useState(false);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch("/api/delete-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id, date }),
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

  const sizeClass = size === "md" ? "h-8 w-8" : "h-6 w-6";
  const iconClass = "h-3.5 w-3.5";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Delete this entry permanently"
          disabled={pending}
          onClick={onClick}
          className={cn(
            sizeClass,
            "inline-flex items-center justify-center cursor-pointer transition-colors outline-none",
            size === "md"
              ? cn(
                  "rounded-lg bg-destructive/10 text-destructive border border-destructive/40",
                  "hover:bg-destructive/20 hover:border-destructive/60",
                  "focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                )
              : cn(
                  "rounded-md text-muted-foreground bg-transparent",
                  "hover:text-destructive hover:bg-destructive/10",
                  "focus-visible:ring-2 focus-visible:ring-destructive/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                ),
            className,
          )}
        >
          {pending ? (
            <Loader2 className={cn(iconClass, "animate-spin")} />
          ) : (
            <Trash2 className={iconClass} />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        Delete entry permanently
      </TooltipContent>
    </Tooltip>
  );
}
