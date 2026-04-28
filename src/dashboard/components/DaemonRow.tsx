import { useState } from "react";
import { FileText, PowerOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type DaemonInfo, formatUptime } from "./hooks/useDaemons";
import { DaemonLogTail } from "./DaemonLogTail";

interface DaemonRowProps {
  daemon: DaemonInfo;
  onAfterAction: () => void;
}

const phaseStyles: Record<string, string> = {
  launching: "bg-[#fbbf24]/15 text-[#fbbf24]",
  authenticating: "bg-[#fbbf24]/15 text-[#fbbf24]",
  idle: "bg-muted text-muted-foreground",
  processing: "bg-primary/15 text-primary",
  keepalive: "bg-muted text-muted-foreground italic",
  draining: "bg-destructive/15 text-destructive",
  exited: "bg-destructive/15 text-destructive",
  unknown: "bg-muted text-muted-foreground",
};

export function DaemonRow({ daemon, onAfterAction }: DaemonRowProps) {
  const [showLog, setShowLog] = useState(false);
  const [ending, setEnding] = useState(false);

  const onEnd = async (): Promise<void> => {
    if (ending) return;
    setEnding(true);
    const t = toast.loading(`Stopping worker (PID ${daemon.pid})…`);
    try {
      const res = await fetch("/api/daemons/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: daemon.workflow }),
      });
      if (res.ok) {
        toast.success(`Worker stopping`, {
          id: t,
          description: `${daemon.workflow} · PID ${daemon.pid}`,
        });
        onAfterAction();
      } else {
        toast.error(`Couldn't stop worker`, { id: t, description: `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error(`Couldn't stop worker`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="rounded-md border border-border/60 bg-card/40 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-mono text-foreground">pid {daemon.pid}</span>
          <span
            className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
              phaseStyles[daemon.phase] ?? phaseStyles.unknown,
            )}
          >
            {daemon.phase}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="font-mono text-muted-foreground tabular-nums">
            {formatUptime(daemon.uptimeMs)}
          </span>
          <span className="font-mono text-muted-foreground tabular-nums">
            {daemon.itemsProcessed} done
          </span>
        </div>
        <div className="text-[11px] truncate">
          {daemon.currentItem ? (
            <span className="font-mono text-primary" title={daemon.currentItem}>
              ▶ {daemon.currentItem}
            </span>
          ) : (
            <span className="text-muted-foreground italic">idle</span>
          )}
        </div>
        <div className="flex items-center justify-end gap-0.5 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Show daemon log"
                onClick={() => setShowLog((s) => !s)}
                className={cn(
                  "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
                  "transition-colors duration-150",
                  showLog
                    ? "text-primary bg-muted"
                    : "text-muted-foreground bg-transparent hover:text-foreground hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                )}
              >
                <FileText className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {showLog ? "Hide log" : "Show log"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="End daemon (soft stop)"
                disabled={ending}
                onClick={onEnd}
                className={cn(
                  "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
                  "text-muted-foreground bg-transparent",
                  "transition-colors duration-150",
                  "hover:text-destructive hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {ending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
                ) : (
                  <PowerOff className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              End daemon
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {showLog && <DaemonLogTail pid={daemon.pid} onClose={() => setShowLog(false)} />}
    </div>
  );
}
