import { useRef } from "react";
import { cn } from "@/lib/utils";

interface ColumnResizerProps {
  width: number;
  onWidthChange: (w: number) => void;
  /** Fired on drag-end / nudge so the parent can persist the width. */
  onCommit?: (w: number) => void;
  /** Fired on double-click to restore the default width. */
  onReset?: () => void;
  min?: number;
  max?: number;
  ariaLabel?: string;
}

/**
 * Thin vertical drag handle between two columns. Drag to resize, double-click
 * to reset, ←/→ to nudge by 16px when focused. Presentational — the parent
 * owns the width state + persistence.
 */
export function ColumnResizer({
  width,
  onWidthChange,
  onCommit,
  onReset,
  min = 260,
  max = 760,
  ariaLabel = "Resize panel",
}: ColumnResizerProps) {
  const latest = useRef(width);
  latest.current = width;

  const clamp = (w: number) => Math.min(max, Math.max(min, w));

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const next = clamp(startW + (ev.clientX - startX));
      latest.current = next;
      onWidthChange(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommit?.(latest.current);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const nudge = (dir: -1 | 1) => {
    const next = clamp(latest.current + dir * 16);
    onWidthChange(next);
    onCommit?.(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      onMouseDown={startDrag}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          nudge(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          nudge(1);
        }
      }}
      title="Drag to resize · double-click to reset"
      className={cn(
        "group relative w-1.5 shrink-0 cursor-col-resize self-stretch",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-info/60 group-focus-visible:bg-info/60"
      />
    </div>
  );
}
