import { AlertTriangle, XOctagon } from "lucide-react";
import type { CaptureValidation } from "../capture-types.js";

export function ValidationBanner({
  validation,
  blurFlaggedCount,
  photoCount,
  active,
}: {
  validation: CaptureValidation | null;
  blurFlaggedCount: number;
  photoCount: number;
  active: boolean;
}) {
  if (!active) return null;
  const blockers = validation?.blockers ?? [];
  const warnings = validation?.warnings ?? [];

  // Suppress the "Can't finalize" banner before any photos arrive — the
  // disabled Finalize button + "awaiting photos" status row already
  // convey the constraint, and a red-bordered alert at session start
  // reads as an error the operator must fix.
  if (blockers.length > 0 && photoCount > 0) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md p-3"
        style={{
          border: "1px solid var(--capture-border-subtle)",
          borderLeft: "2px solid var(--capture-error)",
          backgroundColor: "transparent",
        }}
      >
        <XOctagon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--capture-fg-muted)" }} />
        <div className="flex flex-col gap-0.5">
          <span
            className="text-[9.5px] uppercase tracking-[0.10em] font-medium"
            style={{ color: "var(--capture-fg-muted)" }}
          >
            Can't finalize
          </span>
          <span className="font-sans text-[13px]" style={{ color: "var(--capture-fg-body)" }}>
            {blockers.join(" · ")}
          </span>
        </div>
      </div>
    );
  }

  const allWarnings = [
    ...warnings,
    ...(blurFlaggedCount > 0
      ? [`${blurFlaggedCount} photo${blurFlaggedCount === 1 ? "" : "s"} flagged as blurry — review before finalizing`]
      : []),
  ];
  if (allWarnings.length === 0 || photoCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-md p-3"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        borderLeft: "2px solid var(--capture-warn)",
        backgroundColor: "transparent",
      }}
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--capture-warn)" }} />
      <div className="flex flex-col gap-0.5">
        <span
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium"
          style={{ color: "var(--capture-fg-muted)" }}
        >
          Heads up
        </span>
        <ul className="font-sans text-[13px] leading-relaxed" style={{ color: "var(--capture-fg-body)" }}>
          {allWarnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
