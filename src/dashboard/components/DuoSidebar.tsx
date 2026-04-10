import { cn } from "@/lib/utils";
import { KeyRound } from "lucide-react";
import type { DuoQueueEntry } from "./types";

interface DuoSidebarProps {
  queue: DuoQueueEntry[];
}

export function DuoSidebar({ queue }: DuoSidebarProps) {
  const isEmpty = queue.length === 0;

  return (
    <div
      className={cn(
        "w-[150px] flex-shrink-0 border-l border-border p-2 overflow-y-auto",
        isEmpty ? "bg-card" : "bg-[#12121a]",
      )}
    >
      <div
        className={cn(
          "text-[10px] uppercase tracking-wider font-semibold mb-1.5 flex items-center gap-1",
          isEmpty ? "text-muted-foreground" : "text-[#fbbf24]",
        )}
      >
        <KeyRound className="w-3 h-3" />
        Duo Queue
      </div>

      {isEmpty ? (
        <div className="text-[11px] text-muted-foreground">No pending auth</div>
      ) : (
        <div className="flex flex-col gap-1">
          {queue.map((entry) => (
            <div
              key={entry.requestId}
              className={cn(
                "flex items-center gap-1.5 px-1.5 py-1 rounded",
                entry.state === "active" && "bg-[#eab30812]",
              )}
            >
              <span
                className={cn(
                  "text-[11px] font-semibold font-mono min-w-[14px]",
                  entry.state === "active" ? "text-[#fbbf24]" : "text-[#444]",
                )}
              >
                {entry.position}.
              </span>
              <div className="min-w-0">
                <div
                  className={cn(
                    "text-[11px] font-medium truncate",
                    entry.state === "active"
                      ? "text-[#fbbf24] animate-pulse"
                      : "text-[#555]",
                  )}
                >
                  {entry.system}
                </div>
                <div className="text-[9px] text-muted-foreground truncate">{entry.instance}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
