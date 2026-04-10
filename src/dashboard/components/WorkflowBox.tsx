import { cn } from "@/lib/utils";
import { BrowserChip } from "./BrowserChip";
import type { WorkflowInstanceState } from "./types";

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
}

export function WorkflowBox({ workflow }: WorkflowBoxProps) {
  const { instance, active, currentItemId, sessions } = workflow;

  return (
    <div
      className={cn(
        "flex-shrink-0 border-[1.5px] rounded-lg p-1.5 transition-opacity",
        active
          ? "border-[#7c3aed44] bg-[#7c3aed08]"
          : "border-[#7c3aed22] bg-[#7c3aed04] opacity-45",
      )}
    >
      {/* Header: dot + instance name + current item ID */}
      <div className="flex items-center gap-1 mb-1 px-0.5">
        <span
          className={cn(
            "w-[5px] h-[5px] rounded-full flex-shrink-0",
            active ? "bg-[#4ade80]" : "bg-[#444]",
          )}
        />
        <span className="text-[11px] font-semibold text-[#c4b5fd]">{instance}</span>
        <span className="flex-1" />
        {currentItemId ? (
          <span className="text-[10px] font-mono text-[#a78bfa] bg-[#7c3aed15] px-1.5 rounded">
            {currentItemId}
          </span>
        ) : !active ? (
          <span className="text-[10px] font-mono text-[#555] italic">waiting</span>
        ) : null}
      </div>

      {/* Session boxes */}
      <div className="flex gap-1">
        {sessions.map((sess) => (
          <div
            key={sess.sessionId}
            className="border-[1.5px] border-[#2563eb28] rounded-md p-1 bg-[#2563eb06]"
          >
            <div className="text-[9px] text-[#60a5fa] font-medium mb-1">{sess.sessionId}</div>
            <div className="flex gap-0.5 flex-wrap">
              {sess.browsers.map((b) => (
                <BrowserChip key={b.browserId} system={b.system} authState={b.authState} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
