import { Monitor } from "lucide-react";
import { useSessions } from "./hooks/useSessions";
import { WorkflowBox } from "./WorkflowBox";

export function SessionPanel() {
  const { state } = useSessions();

  // Auto-collapse when no workflows active
  if (state.workflows.length === 0) {
    return null;
  }

  return (
    <div className="h-[140px] min-[1440px]:h-[125px] 2xl:h-[115px] flex-shrink-0 border-t border-border bg-card overflow-hidden">
      <div className="h-full p-1.5 min-[1440px]:p-2 overflow-x-auto overflow-y-hidden">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1 min-[1440px]:mb-1.5 flex items-center gap-1">
          <Monitor className="w-3 h-3 text-[#4ade80]" />
          Sessions
        </div>
        <div className="flex gap-1.5 min-[1440px]:gap-2 items-start">
          {state.workflows.map((wf) => (
            <WorkflowBox key={wf.instance} workflow={wf} />
          ))}
        </div>
      </div>
    </div>
  );
}
