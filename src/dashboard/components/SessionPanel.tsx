import { Monitor } from "lucide-react";
import { useSessions } from "./hooks/useSessions";
import { WorkflowBox } from "./WorkflowBox";
import { DuoSidebar } from "./DuoSidebar";

export function SessionPanel() {
  const { state } = useSessions();

  // Auto-collapse when no workflows active
  if (state.workflows.length === 0 && state.duoQueue.length === 0) {
    return null;
  }

  return (
    <div className="h-[110px] flex-shrink-0 border-t border-border bg-card flex overflow-hidden">
      {/* Session main area — horizontal scroll */}
      <div className="flex-1 p-2 overflow-x-auto overflow-y-hidden min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5 flex items-center gap-1">
          <Monitor className="w-3 h-3 text-[#4ade80]" />
          Sessions
        </div>
        <div className="flex gap-2 items-start">
          {state.workflows.map((wf) => (
            <WorkflowBox key={wf.instance} workflow={wf} />
          ))}
        </div>
      </div>

      {/* Duo Queue sidebar */}
      <DuoSidebar queue={state.duoQueue} />
    </div>
  );
}
