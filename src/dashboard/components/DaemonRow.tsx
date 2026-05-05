import { useState } from "react";
import { FileText, Power, Square, Ban, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type DaemonInfo, formatHeartbeatAge, formatUptime } from "./hooks/useDaemons";
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

const statusStyles: Record<string, string> = {
  alive: "bg-primary/10 text-primary",
  running: "bg-primary/10 text-primary",
  idle: "bg-muted text-muted-foreground",
  stopping: "bg-[#fbbf24]/15 text-[#fbbf24]",
  stopped: "bg-muted text-muted-foreground",
  dead: "bg-destructive/15 text-destructive",
};

function compactId(value: string | null | undefined): string {
  if (!value) return "unknown";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function DaemonRow({ daemon, onAfterAction }: DaemonRowProps) {
  const [showLog, setShowLog] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const postCommand = async ({
    path,
    body,
    pending,
    loading,
    accepted,
    description,
  }: {
    path: string;
    body: Record<string, unknown>;
    pending: string;
    loading: string;
    accepted: string;
    description?: string;
  }): Promise<void> => {
    if (pendingAction) return;
    setPendingAction(pending);
    const t = toast.loading(loading);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && payload.ok !== false) {
        toast.success(accepted, {
          id: t,
          ...(description ? { description } : {}),
        });
        onAfterAction();
      } else {
        toast.error("Worker command failed", {
          id: t,
          description: payload.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error("Worker command failed", {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPendingAction(null);
    }
  };

  const onDrain = (): void => {
    void postCommand({
      path: "/api/worker/drain",
      body: { workerId: daemon.workerId },
      pending: "drain",
      loading: `Draining worker ${compactId(daemon.workerId)}…`,
      accepted: "Worker will stop after the current item.",
      description: `${daemon.workflow} · PID ${daemon.pid}`,
    });
  };

  const onStop = (): void => {
    void postCommand({
      path: "/api/worker/stop",
      body: { workerId: daemon.workerId },
      pending: "stop",
      loading: `Stopping worker ${compactId(daemon.workerId)}…`,
      accepted: "Worker stop requested.",
      description: `${daemon.workflow} · PID ${daemon.pid}`,
    });
  };

  const onKillBrowser = (browserProcessId: string, pid: number): void => {
    void postCommand({
      path: "/api/browser/kill",
      body: { browserProcessId },
      pending: `kill:${browserProcessId}`,
      loading: `Killing browser PID ${pid}…`,
      accepted: "Browser kill sent. The run should fail shortly.",
      description: `${daemon.workflow} · browser PID ${pid}`,
    });
  };

  const heartbeatLabel = formatHeartbeatAge(daemon.heartbeatAgeMs);
  const browserProcesses = daemon.browserProcesses ?? [];
  const workerLabel = compactId(daemon.workerId || daemon.instanceId);

  return (
    <div className="space-y-1">
      <div className="rounded-md border border-border/60 bg-card/40 p-2.5 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-mono text-foreground truncate" title={daemon.workerId}>
              {workerLabel}
            </div>
            <div className="text-[10px] font-mono text-muted-foreground tabular-nums">
              pid {daemon.pid}
              {daemon.instanceId && daemon.instanceId !== daemon.workerId && (
                <span title={daemon.instanceId}> · {compactId(daemon.instanceId)}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                phaseStyles[daemon.phase] ?? phaseStyles.unknown,
              )}
            >
              {daemon.phase}
            </span>
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                statusStyles[daemon.status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {daemon.status}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <span className="font-mono text-muted-foreground tabular-nums">
            {formatUptime(daemon.uptimeMs)}
          </span>
          <span className="font-mono text-muted-foreground tabular-nums text-right">
            {daemon.itemsProcessed} done
          </span>
          <span className="font-mono text-muted-foreground tabular-nums" title={daemon.startedAt}>
            hb {heartbeatLabel}
          </span>
          <span className="font-mono text-muted-foreground tabular-nums text-right">
            {daemon.lockfileAlive === false ? "no lock" : "lock ok"}
          </span>
        </div>
        <div className="text-[11px] truncate">
          {daemon.currentItem ? (
            <span className="font-mono text-primary" title={daemon.currentItem}>
              ▶ {daemon.currentItem}
              {daemon.currentRunId && (
                <span className="text-muted-foreground"> · run {compactId(daemon.currentRunId)}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground italic">idle</span>
          )}
        </div>
        {browserProcesses.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {browserProcesses.map((browser) => {
              const pending = pendingAction === `kill:${browser.browserProcessId}`;
              return (
                <span
                  key={browser.browserProcessId}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-secondary/40 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                  title={browser.browserProcessId}
                >
                  <span className="truncate max-w-[5.5rem]">
                    {browser.systemId} pid {browser.pid}
                  </span>
                  <span className="text-foreground/70">{browser.status}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Force stop browser ${browser.pid}`}
                        disabled={pendingAction !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          onKillBrowser(browser.browserProcessId, browser.pid);
                        }}
                        className={cn(
                          "h-5 w-5 inline-flex items-center justify-center rounded cursor-pointer",
                          "text-muted-foreground bg-transparent",
                          "transition-colors duration-150",
                          "hover:text-destructive hover:bg-muted",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
                          "disabled:opacity-60 disabled:cursor-wait",
                        )}
                      >
                        {pending ? (
                          <Loader2 className="h-3 w-3 animate-spin text-destructive" />
                        ) : (
                          <Ban className="h-3 w-3" />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      Force stop browser
                    </TooltipContent>
                  </Tooltip>
                </span>
              );
            })}
          </div>
        )}
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
                aria-label="Drain worker"
                disabled={pendingAction !== null || !daemon.workerId}
                onClick={onDrain}
                className={cn(
                  "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
                  "text-muted-foreground bg-transparent",
                  "transition-colors duration-150",
                  "hover:text-[#fbbf24] hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#fbbf24]/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {pendingAction === "drain" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#fbbf24]" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Drain worker
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="Stop worker"
                disabled={pendingAction !== null || !daemon.workerId}
                onClick={onStop}
                className={cn(
                  "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
                  "text-muted-foreground bg-transparent",
                  "transition-colors duration-150",
                  "hover:text-destructive hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {pendingAction === "stop" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Stop worker
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {showLog && <DaemonLogTail pid={daemon.pid} onClose={() => setShowLog(false)} />}
    </div>
  );
}
