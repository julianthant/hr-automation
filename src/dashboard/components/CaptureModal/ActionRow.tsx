import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import type { CaptureState } from "../capture-types.js";
import { CtaButton } from "./CtaButton.js";

export function ActionRow({
  state,
  retrying,
  finalizeDisabled,
  photoCount,
  onFinalize,
  onRetryHandoff,
  onDiscard,
  onCloseAndStartNew,
}: {
  state: CaptureState;
  retrying: boolean;
  finalizeDisabled: boolean;
  photoCount: number;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onCloseAndStartNew: () => void;
}) {
  void photoCount; // reserved for a future "Finalize · N" UI if it returns.
  if (state === "open") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onFinalize}
          disabled={finalizeDisabled}
          style={{ gridColumn: "span 3" }}
        >
          Finalize
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard} style={{ gridColumn: "span 1" }}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "finalizing") {
    return <FinalizingBar />;
  }
  if (state === "finalized") {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-md p-3"
        style={{
          border: "1px solid var(--capture-border-subtle)",
          borderLeft: "2px solid var(--capture-border-cta-strong)",
          backgroundColor: "transparent",
        }}
      >
        <div
          className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.10em] font-medium"
          style={{ color: "var(--capture-fg-secondary)" }}
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          Done · sent to handler
        </div>
        <span className="font-mono text-xs" style={{ color: "var(--capture-fg-muted)" }}>
          Closing automatically…
        </span>
      </div>
    );
  }
  if (state === "finalize_failed") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onRetryHandoff}
          disabled={retrying}
          style={{ gridColumn: "span 3" }}
        >
          {retrying ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          )}
          Retry handoff
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard} style={{ gridColumn: "span 1" }}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "expired" || state === "discarded") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onCloseAndStartNew}
          style={{ gridColumn: "span 4" }}
        >
          Close
        </CtaButton>
      </div>
    );
  }
  return null;
}

function FinalizingBar() {
  return (
    <div
      className="relative h-[1.5px] w-full overflow-hidden rounded-full"
      style={{ backgroundColor: "var(--capture-border-subtle)" }}
      role="progressbar"
      aria-label="Bundling photos"
      aria-busy="true"
    >
      <div
        className="absolute inset-y-0 left-0 w-1/2 rounded-full"
        style={{
          backgroundColor: "var(--capture-fg-body)",
          animation: "finalizing-strip 1.6s var(--cap-ease-smooth) infinite",
        }}
      />
    </div>
  );
}
