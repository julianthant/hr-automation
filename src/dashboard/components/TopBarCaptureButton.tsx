import { useState } from "react";
import { Camera } from "lucide-react";
import { cn } from "@/lib/utils";
import { CaptureModal } from "./CaptureModal";
import { useCaptureRegistration } from "./hooks/useCaptureRegistration";

/**
 * "Capture" CTA in the TopBar's queue zone.
 *
 * Self-gating: queries `GET /api/capture/registry` via
 * `useCaptureRegistration(workflow)` and renders nothing if the active
 * workflow hasn't registered a capture handler. New workflows opt in
 * by calling `captureRegistry.register({...})` server-side; no UI
 * change required (matches the spec's "generic primitive" decision).
 *
 * Modal is mounted here (not at the App root) so its lifecycle is
 * scoped to button clicks — fresh state per session, SSE stream
 * scoped to the dialog being open.
 */
export interface TopBarCaptureButtonProps {
  /** The currently-active workflow on the dashboard. */
  workflow: string;
  /** Optional per-invocation context shown above the photo list on mobile. */
  contextHint?: string;
}

export function TopBarCaptureButton({ workflow, contextHint }: TopBarCaptureButtonProps) {
  const registration = useCaptureRegistration(workflow);
  const [open, setOpen] = useState(false);

  if (!registration) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={registration.label}
        title={registration.label}
        className={cn(
          "h-8 w-8 flex items-center justify-center rounded-lg",
          "bg-secondary text-foreground border border-border",
          "hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
          "transition-colors cursor-pointer",
        )}
      >
        <Camera aria-hidden className="h-3.5 w-3.5" />
      </button>
      <CaptureModal
        open={open}
        onOpenChange={setOpen}
        workflow={workflow}
        workflowLabel={registration.label}
        contextHint={contextHint}
      />
    </>
  );
}
