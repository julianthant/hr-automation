import type { CaptureState } from "../capture-types.js";

export function describeCaptureStatus(
  state: CaptureState,
  phoneConnected: boolean,
  photoCount: number,
): string {
  if (state === "finalizing") return "Bundling photos for handoff…";
  if (state === "finalized") return "Sent to handler. Closing automatically…";
  if (state === "finalize_failed") return "Couldn't send to handler.";
  if (state === "expired") return "Session expired.";
  if (state === "discarded") return "Session discarded.";
  if (!phoneConnected) return "Waiting for phone to scan QR.";
  if (photoCount === 0) return "Phone connected — awaiting photos.";
  return `Phone connected — ${photoCount} photo${photoCount === 1 ? "" : "s"} received.`;
}

export function CaptureStatusBlock({
  state,
  phoneConnected,
  photoCount,
  className,
}: {
  state: CaptureState;
  phoneConnected: boolean;
  photoCount: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <div
        className="font-sans text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1"
        style={{ color: "var(--capture-fg-faint)" }}
      >
        Status
      </div>
      <div
        className="flex items-center gap-2.5 py-1 text-[12px]"
        style={{ color: "var(--capture-fg-secondary)" }}
        aria-live="polite"
      >
        <span
          className="inline-block h-[5px] w-[5px] shrink-0 rounded-full"
          style={{ backgroundColor: "var(--capture-fg-secondary)" }}
          aria-hidden
        />
        <span>{describeCaptureStatus(state, phoneConnected, photoCount)}</span>
      </div>
    </div>
  );
}
