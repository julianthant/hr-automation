import { useState } from "react";
import { Inbox } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "../workflows-context";
import { usePreviewInbox } from "./hooks/usePreviewInbox";
import type { PreviewInboxRow } from "./types";

export interface ApprovalInboxProps {
  onSelect: (row: PreviewInboxRow) => void;
}

/**
 * Navbar inbox button. Amber badge shows count of preview rows ready
 * for review across all workflows. Click → popover lists them; clicking
 * a row delegates to `onSelect` (App.tsx wires this to the same handler
 * the command palette uses — switching workflow + date + selectedId).
 */
export function ApprovalInbox({ onSelect }: ApprovalInboxProps) {
  const [open, setOpen] = useState(false);
  const { rows } = usePreviewInbox(open);
  const registered = useWorkflows();
  const labelFor = (wf: string): string =>
    registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  const count = rows.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            count === 0
              ? "Approval inbox — nothing pending"
              : `Approval inbox — ${count} pending review`
          }
          className={cn(
            "h-8 w-8 rounded-md border border-border bg-secondary",
            "flex items-center justify-center relative cursor-pointer",
            "text-muted-foreground hover:bg-accent hover:text-foreground",
            "outline-none focus-visible:ring-2 focus-visible:ring-primary",
            "transition-colors",
          )}
        >
          <Inbox className="h-3.5 w-3.5" aria-hidden />
          {count > 0 && (
            <span
              aria-hidden
              className={cn(
                "absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1",
                "bg-warning text-warning-foreground rounded-full",
                "font-mono text-[10px] font-bold leading-[18px] text-center",
                "ring-2 ring-card",
              )}
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="p-0 w-[420px]">
        {count === 0 ? (
          <div className="px-4 py-6 text-center">
            <div className="text-sm text-foreground font-medium">Inbox empty</div>
            <div className="text-xs text-muted-foreground mt-1">
              No preview rows pending review.
            </div>
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {rows.map((row) => (
              <button
                key={`${row.workflow}::${row.id}::${row.runId}`}
                type="button"
                onClick={() => {
                  onSelect(row);
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3.5 py-2.5 cursor-pointer transition-colors",
                  "border-b border-border last:border-b-0",
                  "hover:bg-accent focus-visible:bg-accent outline-none",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                    {labelFor(row.workflow)}
                  </span>
                  {row.recordCount !== undefined && (
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {row.recordCount} record{row.recordCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-sm font-semibold text-foreground truncate">
                  {row.summary}
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground">
                  <span className="truncate">{row.id}</span>
                  <span>{shortTime(row.ts)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
