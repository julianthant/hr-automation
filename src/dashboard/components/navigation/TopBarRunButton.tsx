import { useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { RunModal } from "@/components/run-modal/RunModal";
import { isRunModalEnabled } from "@/lib/run-modal-registry";

export interface TopBarRunButtonProps {
  activeWorkflow: string;
  busyCount?: number;
}

export function TopBarRunButton({ activeWorkflow, busyCount = 0 }: TopBarRunButtonProps) {
  const [open, setOpen] = useState(false);
  if (!isRunModalEnabled(activeWorkflow)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Upload PDF for ${activeWorkflow}`}
        title={
          busyCount > 0
            ? `${busyCount} prepare in progress — click to upload another PDF`
            : `Upload PDF for ${activeWorkflow}`
        }
        className={cn(
          "relative flex-shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-lg",
          "bg-primary text-primary-foreground border border-primary",
          "hover:bg-primary/90 hover:border-primary/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
          "transition-colors cursor-pointer",
        )}
      >
        <Upload aria-hidden className="h-3.5 w-3.5" />
        {busyCount > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-warning motion-safe:animate-pulse"
          />
        )}
      </button>
      <RunModal open={open} onOpenChange={setOpen} workflow={activeWorkflow} />
    </>
  );
}
