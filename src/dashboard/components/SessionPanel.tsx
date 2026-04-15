import { Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSessions } from "./hooks/useSessions";
import { WorkflowBox } from "./WorkflowBox";

export function SessionPanel() {
  const { state } = useSessions();
  // A workflow's session (its Playwright browsers) ends when the spawning Node process
  // dies. We keep the workflow visible through the DONE/FAILED pill until then, and
  // drop it automatically once pidAlive flips to false (i.e., user closed the browser
  // / Ctrl+C'd the run / dry-run process naturally exited).
  const visible = state.workflows.filter((w) => w.pidAlive);
  const isEmpty = visible.length === 0;
  const hasActive = visible.some((w) => w.active);

  return (
    <div className="w-[240px] min-[1440px]:w-[280px] 2xl:w-[320px] flex-shrink-0 border-l border-border flex flex-col bg-card overflow-hidden">
      <div
        className={cn(
          "h-[60px] px-3 border-b border-border flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold flex-shrink-0",
          hasActive ? "text-[#4ade80]" : "text-muted-foreground",
        )}
      >
        <Monitor className="w-3.5 h-3.5" />
        Sessions
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {isEmpty ? (
          <div className="text-[11px] text-muted-foreground px-1.5 py-1">No active workflows</div>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.map((wf) => (
              <WorkflowBox key={wf.instance} workflow={wf} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
