import { useState } from "react";
import { Camera } from "lucide-react";
import { cn } from "@/lib/utils";
import { CaptureModal } from "./CaptureModal";

/**
 * "Capture" CTA in the TopBar's queue zone. Opens a modal with a QR
 * code; the operator scans on their phone, takes photos of paper
 * rosters, taps Done, and the bundled PDF flows through the
 * workflow's onFinalize handler in the backend (see
 * `src/tracker/dashboard.ts → makeCaptureFinalize`).
 *
 * Only mounted for workflows that actually have a finalize handler —
 * adding a new consumer is one prop in the App.tsx mount + one case
 * in `makeCaptureFinalize`.
 */
export interface TopBarCaptureButtonProps {
  workflow: string;
  /** Free-text shown to the operator on the mobile page. */
  contextHint?: string;
}

export function TopBarCaptureButton({ workflow, contextHint }: TopBarCaptureButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Capture from phone"
        title="Capture photos from phone via QR code"
        className={cn(
          "h-8 px-3 inline-flex items-center gap-1.5 rounded-lg",
          "text-sm font-medium",
          "bg-secondary text-foreground border border-border",
          "hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
          "transition-colors cursor-pointer",
        )}
      >
        <Camera aria-hidden className="h-3.5 w-3.5" />
        <span>Capture</span>
      </button>
      <CaptureModal
        open={open}
        onOpenChange={setOpen}
        workflow={workflow}
        contextHint={contextHint}
      />
    </>
  );
}
