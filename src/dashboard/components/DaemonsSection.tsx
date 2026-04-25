import { useMemo, useState } from "react";
import { Plus, Square, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useDaemons, type DaemonInfo } from "./hooks/useDaemons";
import { useWorkflows, autoLabel } from "../workflows-context";
import { DaemonRow } from "./DaemonRow";

/**
 * Top section of the right rail: groups alive daemons by workflow and
 * surfaces spawn/stop affordances per group. Renders nothing when no
 * daemons are alive AND no workflows are visible (zero-state matches
 * the existing "No active workflows" placeholder elsewhere on the rail).
 */
export function DaemonsSection() {
  const { daemons, refresh } = useDaemons();

  const grouped = useMemo(() => {
    const byWorkflow = new Map<string, DaemonInfo[]>();
    for (const d of daemons) {
      const list = byWorkflow.get(d.workflow) ?? [];
      list.push(d);
      byWorkflow.set(d.workflow, list);
    }
    return byWorkflow;
  }, [daemons]);

  if (grouped.size === 0) return null;

  return (
    <div className="space-y-3 mb-3">
      {[...grouped.entries()].map(([workflow, list]) => (
        <DaemonGroup key={workflow} workflow={workflow} daemons={list} onRefresh={refresh} />
      ))}
    </div>
  );
}

function DaemonGroup({
  workflow,
  daemons,
  onRefresh,
}: {
  workflow: string;
  daemons: DaemonInfo[];
  onRefresh: () => void;
}) {
  const registered = useWorkflows();
  const label = registered.find((r) => r.name === workflow)?.label ?? autoLabel(workflow);
  const [spawning, setSpawning] = useState(false);
  const [stopping, setStopping] = useState(false);

  const onSpawn = async (): Promise<void> => {
    if (spawning) return;
    setSpawning(true);
    const t = toast.loading(`Spawning ${label} daemon…`);
    try {
      const res = await fetch("/api/daemons/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, count: 1 }),
      });
      if (res.ok) {
        toast.success(`Spawn queued`, {
          id: t,
          description: `Approve Duo to bring it online`,
        });
        // Re-poll soon — daemon may take 30-60s to come online behind Duo.
        setTimeout(onRefresh, 2_000);
      } else {
        toast.error(`Spawn failed`, { id: t, description: `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error(`Spawn failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSpawning(false);
    }
  };

  const onStopAll = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    const t = toast.loading(`Stopping all ${label} daemons…`);
    try {
      const res = await fetch("/api/daemons/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow }),
      });
      if (res.ok) {
        toast.success(`Stop signal sent`, { id: t, description: `${daemons.length} daemons` });
        onRefresh();
      } else {
        toast.error(`Stop failed`, { id: t, description: `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error(`Stop failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {label} daemons ({daemons.length})
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Spawn one more ${label} daemon`}
                disabled={spawning}
                onClick={onSpawn}
                className={cn(
                  "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
                  "text-muted-foreground bg-transparent",
                  "transition-colors duration-150",
                  "hover:text-primary hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {spawning ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Spawn one more
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`Stop all ${label} daemons`}
                disabled={stopping}
                onClick={onStopAll}
                className={cn(
                  "h-6 w-6 inline-flex items-center justify-center rounded-md cursor-pointer",
                  "text-muted-foreground bg-transparent",
                  "transition-colors duration-150",
                  "hover:text-destructive hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40",
                  "disabled:opacity-60 disabled:cursor-wait",
                )}
              >
                {stopping ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-destructive" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Stop all
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 px-1.5">
        {daemons.map((d) => (
          <DaemonRow key={d.pid} daemon={d} onAfterAction={onRefresh} />
        ))}
      </div>
    </div>
  );
}
