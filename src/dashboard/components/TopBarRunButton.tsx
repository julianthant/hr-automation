import { useState } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunModal } from "./RunModal";

const RUN_ENABLED_WORKFLOWS = ["ocr", "emergency-contact"];

export interface TopBarRunButtonProps {
  activeWorkflow: string;
  busyCount?: number;
}

export function TopBarRunButton({ activeWorkflow, busyCount = 0 }: TopBarRunButtonProps) {
  const [open, setOpen] = useState(false);
  if (!RUN_ENABLED_WORKFLOWS.includes(activeWorkflow)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Run ${activeWorkflow}`}
        title={
          busyCount > 0
            ? `${busyCount} prepare in progress — click to start another`
            : `Run ${activeWorkflow}`
        }
        className={cn(
          "h-8 px-3 inline-flex items-center gap-1.5 rounded-lg",
          "text-sm font-medium",
          "bg-primary text-primary-foreground border border-primary",
          "hover:bg-primary/90 hover:border-primary/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
          "transition-colors cursor-pointer",
        )}
      >
        {busyCount > 0 ? (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full bg-primary-foreground motion-safe:animate-pulse"
          />
        ) : (
          <Play aria-hidden className="h-3.5 w-3.5" />
        )}
        <span>Run</span>
        {busyCount > 0 && (
          <span className="text-xs font-mono opacity-80">· {busyCount}</span>
        )}
      </button>
      <RunModal open={open} onOpenChange={setOpen} workflow={activeWorkflow} />
    </>
  );
}
