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
    <div className="flex flex-col items-center gap-4">
      {/* QR — server-generated SVG; we control the input.
          Inner SVG ships with width=200; the [&>svg] selector forces it
          to fit the 192px frame regardless of the baked-in attributes. */}
      <div
        className="rounded-[10px] p-[14px] [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
        style={{ backgroundColor: "#FFFFFF", width: 192, height: 192 }}
        aria-label="QR code for capture URL"
        dangerouslySetInnerHTML={{ __html: started.qrSvg }}
      />

      {/* Shortcode — manual fallback if the QR can't be scanned. */}
      <div
        className="font-mono text-[28px] font-light"
        style={{
          color: "var(--capture-fg-primary)",
          letterSpacing: "0.14em",
          lineHeight: 1.1,
        }}
        aria-label={`Manual entry shortcode ${started.shortcode}`}
      >
        {started.shortcode}
      </div>
    </div>
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
