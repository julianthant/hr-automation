/**
 * RunnerLauncher — the amber-trimmed button in the topbar that opens the
 * runner drawer. Visually distinct from the dashboard's other controls
 * (which lean primary-tan) so the operator can spot it instantly.
 */

import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface RunnerLauncherProps {
  onClick: () => void;
  /** Becomes true when there's at least one active runner-spawned run. */
  active?: boolean;
}

export function RunnerLauncher({ onClick, active = false }: RunnerLauncherProps) {
  return (
    <button
      onClick={onClick}
      title="Run a workflow from the dashboard"
      className={cn(
        "flex items-center gap-2 px-3.5 py-2 rounded-lg",
        "border bg-[#0F1116] hover:bg-[#13151A]",
        "transition-all duration-150",
        "font-runner-mono text-[11px] tracking-[0.18em] uppercase",
        active
          ? "border-runner-accent text-runner-accent shadow-[0_0_16px_-4px_rgba(245,158,11,0.6)]"
          : "border-runner-accent/50 text-runner-accent/90 hover:border-runner-accent hover:text-runner-accent",
      )}
    >
      <Zap className="w-3.5 h-3.5" />
      <span>Run</span>
      {active && (
        <span
          className="runner-status-dot ml-1"
          data-state="running"
          aria-hidden
        />
      )}
    </button>
  );
}
