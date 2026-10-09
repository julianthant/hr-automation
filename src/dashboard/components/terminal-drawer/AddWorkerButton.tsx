import { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "@/lib/notify";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useWorkflows, type WorkflowMetadata } from "@/lib/workflows-context";
import { getWorkflowIcon } from "@/lib/workflow-icons";
import { isRetiredDashboardWorkflow } from "../../../domain/dashboard-run-surfaces.js";

/** One row in the add-worker picker — a workflow plus its live capacity hints. */
export interface AddWorkerOption {
  name: string;
  label: string;
  iconName?: string;
  /** Alive daemons currently running this workflow. */
  workers: number;
  /** Top-level queued surface count for this workflow (backend wfQueuedCounts). */
  queued: number;
}

/**
 * Build the ordered picker rows. Retired workflows are dropped; the rest are
 * sorted so the workflows that actually need capacity float to the top:
 * most queued work first, then most running workers, then alphabetical by
 * label so the list is stable tick-to-tick. Pure + exported for unit testing.
 */
export function buildAddWorkerOptions(
  workflows: WorkflowMetadata[],
  workerCounts: Record<string, number>,
  queuedCounts: Record<string, number>,
): AddWorkerOption[] {
  return workflows
    .filter((w) => !isRetiredDashboardWorkflow(w.name))
    .map((w) => ({
      name: w.name,
      label: w.label,
      ...(w.iconName ? { iconName: w.iconName } : {}),
      workers: workerCounts[w.name] ?? 0,
      queued: queuedCounts[w.name] ?? 0,
    }))
    .sort((a, b) => {
      if (b.queued !== a.queued) return b.queued - a.queued;
      if (b.workers !== a.workers) return b.workers - a.workers;
      return a.label.localeCompare(b.label);
    });
}

interface AddWorkerButtonProps {
  /** Alive worker (daemon) count per workflow name, from live session state. */
  workerCounts: Record<string, number>;
  /** Top-level queued surface count per workflow name (backend wfQueuedCounts). */
  queuedCounts: Record<string, number>;
}

/**
 * The "+" beside the Live pill in the terminal drawer. Opens a workflow picker;
 * selecting one POSTs `/api/daemons/spawn` to spawn ONE more daemon for that
 * workflow. The new daemon authenticates (one fresh Duo) then claims from the
 * SAME shared SQLite queue every other daemon reads — so adding a worker
 * mid-run lets it pick up already-queued work (the "ran separations with one
 * worker, need more" case). Works for every registered workflow, current and
 * future, because the picker is driven by the live workflow registry.
 */
export function AddWorkerButton({ workerCounts, queuedCounts }: AddWorkerButtonProps) {
  const workflows = useWorkflows();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const options = buildAddWorkerOptions(workflows, workerCounts, queuedCounts);

  async function spawnWorker(name: string, label: string) {
    setPending(name);
    const toastId = toast.loading(`Adding a ${label} worker…`);
    try {
      const res = await fetch("/api/daemons/spawn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: name, count: 1 }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        toast.error(`Couldn't add a ${label} worker`, {
          id: toastId,
          description: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success(`Adding a ${label} worker — it joins the shared queue after UCPath auth`, {
        id: toastId,
        description:
          "One Duo at a time: if another worker is already authenticating, this one waits its turn. Prefer one healthy worker over stacking authenticating cards.",
      });
      setOpen(false);
    } catch (err) {
      toast.error(`Couldn't add a ${label} worker`, {
        id: toastId,
        description: (err as Error).message,
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Add a workflow worker"
          title="Add a worker"
          className={cn(
            "shrink-0 h-5 w-5 flex items-center justify-center rounded-md transition-colors outline-none cursor-pointer",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/10",
            "focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <Plus aria-hidden className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} className="w-72 p-1.5">
        <div className="px-2 py-1.5">
          <p className="text-[13px] font-medium text-foreground">Add a worker</p>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Spawns one more daemon for a workflow. It joins the shared queue and picks up waiting work.
          </p>
        </div>
        <div className="my-1 border-t border-border/60" aria-hidden />
        <ScrollArea className="max-h-72">
        <ul className="flex flex-col gap-0.5">
          {options.map((opt) => {
            const Icon = getWorkflowIcon(opt.iconName);
            const busy = pending === opt.name;
            return (
              <li key={opt.name}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void spawnWorker(opt.name, opt.label)}
                  aria-label={`Add a ${opt.label} worker`}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors outline-none cursor-pointer",
                    "hover:bg-secondary focus-visible:bg-secondary",
                    "disabled:opacity-60 disabled:cursor-not-allowed",
                  )}
                >
                  <Icon aria-hidden className="w-4 h-4 shrink-0 text-muted-foreground" />
                  <span className="flex flex-col min-w-0 flex-1">
                    <span className="text-[13px] font-medium text-foreground truncate">{opt.label}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {opt.workers} {opt.workers === 1 ? "worker" : "workers"}
                      {opt.queued > 0 ? ` · ${opt.queued} queued` : ""}
                    </span>
                  </span>
                  {busy ? (
                    <Loader2
                      aria-hidden
                      className="w-3.5 h-3.5 shrink-0 text-muted-foreground animate-spin motion-reduce:animate-none"
                    />
                  ) : (
                    <Plus aria-hidden className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
