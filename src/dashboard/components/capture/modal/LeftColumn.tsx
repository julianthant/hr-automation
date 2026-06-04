import { Loader2, RefreshCw, XOctagon } from "lucide-react";
import type { CaptureState } from "../capture-types.js";
import type { StartedSession } from "./index.js";
import { CtaButton } from "./CtaButton.js";

export interface LeftColumnProps {
  state: CaptureState;
  started: StartedSession | null;
  error: string | null;
  onCopy: () => void;
  onCloseAndStartNew: () => void;
}

export function LeftColumn({
  state,
  started,
  error,
  onCopy,
  onCloseAndStartNew,
}: LeftColumnProps) {
  void onCopy;
  if (state === "starting") return <StartingPanel />;
  if (state === "error") return <ErrorPanel message={error ?? "Couldn't start"} onRetry={onCloseAndStartNew} />;
  if (!started) return null;

  return (
    <div
      className="box-border shrink-0 rounded-[10px] p-[14px] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
      style={{
        backgroundColor: "white",
        width: "var(--capture-band-h, 12rem)",
        height: "var(--capture-band-h, 12rem)",
      }}
      aria-label="QR code for capture URL"
      dangerouslySetInnerHTML={{ __html: started.qrSvg }}
    />
  );
}

function StartingPanel() {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 py-12">
      <Loader2 aria-hidden className="h-6 w-6 animate-spin motion-reduce:animate-none" style={{ color: "var(--capture-fg-muted)" }} />
      <span className="font-sans text-[12px]" style={{ color: "var(--capture-fg-muted)" }}>
        Generating QR code…
      </span>
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex w-full flex-col gap-3 rounded-md p-3"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        borderLeft: "2px solid var(--capture-error)",
        backgroundColor: "transparent",
      }}
    >
      <div
        className="flex items-center gap-1.5 font-sans text-[9.5px] uppercase tracking-[0.10em] font-medium"
        style={{ color: "var(--capture-fg-muted)" }}
      >
        <XOctagon aria-hidden className="h-3.5 w-3.5" />
        Error
      </div>
      <code className="font-mono text-xs leading-relaxed" style={{ color: "var(--capture-fg-body)" }}>
        {message}
      </code>
      <CtaButton variant="primary" onClick={onRetry}>
        <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        Close
      </CtaButton>
    </div>
  );
}
