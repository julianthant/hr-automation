import { useEffect } from "react";
import type { ScreenshotEntry } from "./hooks/useRunScreenshots";

export function ScreenshotLightbox({
  entry,
  fileIdx,
  onNavigate,
  onClose,
}: {
  entry: ScreenshotEntry;
  fileIdx: number;
  onNavigate: (nextIdx: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onNavigate(Math.max(0, fileIdx - 1));
      if (e.key === "ArrowRight")
        onNavigate(Math.min(entry.files.length - 1, fileIdx + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [entry, fileIdx, onNavigate, onClose]);

  const file = entry.files[fileIdx];
  if (!file) return null;

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
            {" "}
            · {fileIdx + 1} / {entry.files.length}
          </span>
          {" · "}
          <span className="truncate max-w-[40ch] inline-block align-bottom">
            {entry.label}
          </span>
        </div>
        {entry.files.length > 1 && (
          <>
            <button
              type="button"
              disabled={fileIdx === 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/90 rounded px-2 py-1 text-xs font-mono text-foreground/80 disabled:opacity-30 hover:bg-background transition-colors"
              onClick={() => onNavigate(Math.max(0, fileIdx - 1))}
            >
              ‹
            </button>
            <button
              type="button"
              disabled={fileIdx === entry.files.length - 1}
              className="absolute right-10 top-1/2 -translate-y-1/2 bg-background/90 rounded px-2 py-1 text-xs font-mono text-foreground/80 disabled:opacity-30 hover:bg-background transition-colors"
              onClick={() =>
                onNavigate(Math.min(entry.files.length - 1, fileIdx + 1))
              }
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
