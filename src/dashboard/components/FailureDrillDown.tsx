import { useEffect, useState } from "react";
import { X, ImageOff, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LogEntry, ScreenshotListEntry, TrackerEntry } from "./types";

interface FailureDrillDownProps {
  entry: TrackerEntry;
  workflow: string;
  logs: LogEntry[];
}

/**
 * Compact "what went wrong" strip shown above the full log stream for a
 * failed entry. Three rows:
 *   1. Classified error (entry.error) — the dashboard source of truth.
 *   2. Last ~20 log lines — already visible in LogStream below; this
 *      condensed view makes the most recent context instantly readable.
 *   3. Screenshot strip (horizontally scrollable) when screenshotCount > 0.
 *      Click a thumbnail → lightbox modal showing the full PNG.
 */
export function FailureDrillDown({ entry, workflow, logs }: FailureDrillDownProps) {
  const [screenshots, setScreenshots] = useState<ScreenshotListEntry[]>([]);
  const [lightbox, setLightbox] = useState<ScreenshotListEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const hasScreenshots = (entry.screenshotCount ?? 0) > 0;

  useEffect(() => {
    if (!hasScreenshots) {
      setScreenshots([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(
      `/api/screenshots?workflow=${encodeURIComponent(workflow)}&itemId=${encodeURIComponent(entry.id)}`,
    )
      .then((r) => r.json())
      .then((data: ScreenshotListEntry[]) => {
        if (!cancelled) setScreenshots(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setScreenshots([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workflow, entry.id, hasScreenshots]);

  // Lightbox: close on Escape key for keyboard parity with the close button.
  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightbox]);

  return (
    <>
      {/* Error header */}
      <div className="flex-shrink-0">
        {entry.error && (
          <div className="flex items-start gap-2 px-6 py-3 bg-destructive/5 border-b border-destructive/20">
            <AlertCircle className="w-4 h-4 mt-0.5 text-destructive flex-shrink-0" />
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-destructive font-semibold mb-1">
                Failure
              </div>
              <div className="text-sm font-mono text-foreground/90 break-words whitespace-pre-wrap">
                {entry.error}
              </div>
            </div>
          </div>
        )}

        {/* Screenshot strip */}
        {hasScreenshots && (
          <div className="px-6 py-3 bg-secondary/20">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
              Screenshots ({entry.screenshotCount})
            </div>
            {loading && screenshots.length === 0 ? (
              <div className="flex gap-2">
                {Array.from({ length: Math.min(entry.screenshotCount ?? 0, 4) }).map((_, i) => (
                  <div
                    key={i}
                    className="w-32 h-20 rounded-md bg-muted animate-pulse flex-shrink-0"
                  />
                ))}
              </div>
            ) : screenshots.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ImageOff className="w-4 h-4" />
                No screenshot files found
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1">
                {screenshots.map((s) => (
                  <button
                    key={s.filename}
                    type="button"
                    onClick={() => setLightbox(s)}
                    className="flex flex-col flex-shrink-0 rounded-md border border-border overflow-hidden hover:border-primary/60 transition-colors group/thumb text-left"
                    title={`${s.filename}\n${(s.sizeBytes / 1024).toFixed(1)} KB`}
                  >
                    <img
                      src={`/screenshots/${encodeURIComponent(s.filename)}`}
                      alt={s.step || s.filename}
                      loading="lazy"
                      className="w-32 h-20 object-cover bg-background"
                    />
                    <div className="px-2 py-1 bg-card">
                      <div className="text-[10px] font-mono truncate w-28" title={s.step}>
                        {s.step || "\u2014"}
                      </div>
                      <div className="text-[9px] text-muted-foreground font-mono">
                        {s.ts ? new Date(s.ts).toLocaleTimeString() : ""}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Lightbox modal — lightweight custom impl to match the shadcn-style
          primitives already in use; avoids pulling HeroUI into the bundle. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative bg-card rounded-xl border border-border shadow-2xl max-w-[95vw] max-h-[95vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-border">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{lightbox.step || "Screenshot"}</div>
                <div className="text-[11px] font-mono text-muted-foreground truncate">
                  {lightbox.filename}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setLightbox(null)}
                className="p-1 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
                aria-label="Close screenshot"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-auto p-2 border-b border-border">
              <img
                src={`/screenshots/${encodeURIComponent(lightbox.filename)}`}
                alt={lightbox.step || lightbox.filename}
                className="max-w-full max-h-[85vh] rounded-md"
              />
            </div>
            <div className="px-5 py-2 text-[11px] text-muted-foreground font-mono flex justify-between">
              <span>{lightbox.ts ? new Date(lightbox.ts).toLocaleString() : ""}</span>
              <span>{(lightbox.sizeBytes / 1024).toFixed(1)} KB</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
