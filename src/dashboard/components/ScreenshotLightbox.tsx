import { useEffect } from "react";
import type { ScreenshotEntry } from "./hooks/useRunScreenshots";

/** One flattened (entry, file-within-entry) pair in the lightbox queue. */
export interface LightboxItem {
  entry: ScreenshotEntry;
  fileIdx: number;
}

export function ScreenshotLightbox({
  items,
  idx,
  onNavigate,
  onClose,
}: {
  items: LightboxItem[];
  idx: number;
  onNavigate: (nextIdx: number) => void;
  onClose: () => void;
}) {
  // Arrow-keys cross entry boundaries so the operator can scroll through
  // every captured image with one hand — Mac Preview–style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        if (idx > 0) onNavigate(idx - 1);
        return;
      }
      if (e.key === "ArrowRight") {
        if (idx < items.length - 1) onNavigate(idx + 1);
        return;
      }
      // Optional niceties that feel right in a Preview-style viewer.
      if (e.key === "Home") {
        if (idx !== 0) onNavigate(0);
        return;
      }
      if (e.key === "End") {
        const last = items.length - 1;
        if (idx !== last) onNavigate(last);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, items.length, onNavigate, onClose]);

  const current = items[idx];
  if (!current) return null;
  const { entry, fileIdx } = current;
  const file = entry.files[fileIdx];
  if (!file) return null;

  const hasPrev = idx > 0;
  const hasNext = idx < items.length - 1;

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="relative max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={file.url}
          alt={file.system}
          className="max-w-full max-h-[85vh] rounded"
        />
        <div className="absolute bottom-2 left-2 bg-background/90 rounded px-2 py-1 text-[11px] font-mono text-foreground/80">
          <span className="uppercase tracking-wider">{file.system}</span>
          <span className="text-muted-foreground">
            {" "}· {idx + 1} / {items.length}
          </span>
          {" · "}
          <span className="truncate max-w-[40ch] inline-block align-bottom">
            {entry.label}
          </span>
        </div>
        {items.length > 1 && (
          <>
            <button
              type="button"
              disabled={!hasPrev}
              aria-label="Previous screenshot"
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/90 rounded px-2 py-1 text-xs font-mono text-foreground/80 disabled:opacity-30 hover:bg-background transition-colors"
              onClick={() => hasPrev && onNavigate(idx - 1)}
            >
              ‹
            </button>
            <button
              type="button"
              disabled={!hasNext}
              aria-label="Next screenshot"
              className="absolute right-10 top-1/2 -translate-y-1/2 bg-background/90 rounded px-2 py-1 text-xs font-mono text-foreground/80 disabled:opacity-30 hover:bg-background transition-colors"
              onClick={() => hasNext && onNavigate(idx + 1)}
            >
              ›
            </button>
          </>
        )}
        <button
          type="button"
          className="absolute top-2 right-2 bg-background/90 rounded px-2 py-1 text-[11px] font-mono text-foreground/80 hover:bg-background transition-colors"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
