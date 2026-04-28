import { useState } from "react";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunModal } from "./RunModal";

/**
 * "Run" CTA in the TopBar's queue zone, scoped to the emergency-contact
 * workflow. Triggers the upload modal; the modal owns submission state.
 *
 * `busyCount` shows a small numeric badge if N prep rows are still in
 * progress; the operator CAN start a second prep concurrently, so we don't
 * disable the button.
 */
export interface TopBarRunButtonProps {
  busyCount?: number;
}

export function TopBarRunButton({ busyCount = 0 }: TopBarRunButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Run emergency contact prep"
        title={
          busyCount > 0
            ? `${busyCount} prepare in progress — click to start another`
            : "Run emergency contact"
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
      <RunModal open={open} onOpenChange={setOpen} />
    </>
  );
}
