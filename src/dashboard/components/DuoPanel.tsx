import { cn } from "@/lib/utils";
import { KeyRound } from "lucide-react";
import { useSessions } from "./hooks/useSessions";

export function DuoPanel() {
  const { state } = useSessions();
  const queue = state.duoQueue;

  // Auto-hide when no workflows AND no queue items (mirrors SessionPanel)
  if (state.workflows.length === 0 && queue.length === 0) {
    return null;
  }

  const isEmpty = queue.length === 0;

  return (
    <div className="w-[120px] min-[1440px]:w-[150px] 2xl:w-[180px] flex-shrink-0 border-l border-border flex flex-col bg-card overflow-hidden">
      <div
        className={cn(
          "px-3 py-3 border-b border-border flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold",
          isEmpty ? "text-muted-foreground" : "text-[#fbbf24]",
        )}
      >
        <KeyRound className="w-3.5 h-3.5" />
        Duo Queue
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isEmpty ? (
          <div className="text-[11px] text-muted-foreground px-1.5 py-1">No pending auth</div>
        ) : (
          <div className="flex flex-col gap-1">
            {queue.map((entry) => (
              <div
                key={entry.requestId}
                className={cn(
                  "flex items-start gap-2 px-2 py-1.5 rounded",
                  entry.state === "active" && "bg-[#eab30812]",
                )}
              >
                <span
                  className={cn(
                    "text-[11px] font-semibold font-mono min-w-[16px] mt-px",
                    entry.state === "active" ? "text-[#fbbf24]" : "text-[#444]",
                  )}
                >
                  {entry.position}.
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-[11px] font-medium truncate",
                      entry.state === "active"
                        ? "text-[#fbbf24] animate-pulse"
                        : "text-[#666]",
                    )}
                  >
                    {entry.system}
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate">{entry.instance}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
