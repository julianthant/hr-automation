import { useEffect, useRef, useState } from "react";
import { FileX, Loader2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PdfPagePreviewProps {
  /** Workflow name forwarded to the `/api/prep/pdf-page` query. */
  workflow: string;
  parentRunId: string;
  /** 1-indexed page number. */
  page: number;
  className?: string;
}

// Pre-render N pages above + below the viewport so scrolling feels instant.
const VIEWPORT_PRELOAD_MARGIN = "800px";

/**
 * <img> wrapper that pulls a single PDF page render from the
 * `/api/prep/pdf-page` endpoint. Three states (always visible — no
 * silent loading/error). White background so the actual page render
 * (typically dark text on white paper) is clearly distinguishable
 * from the dark dashboard chrome around it.
 *
 * The parentRunId already changes per OCR run so caching is naturally
 * scoped per upload — no extra cache-buster needed.
 */
export function PdfPagePreview({
  workflow,
  parentRunId,
  page,
  className,
}: PdfPagePreviewProps) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  // Defer the image fetch until the container is near the viewport — for a
  // 50-page PDF that means we never download the bytes for pages the
  // operator never scrolled to. IntersectionObserver with a generous
  // rootMargin (VIEWPORT_PRELOAD_MARGIN) so scrolling stays smooth.
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  useEffect(() => {
    if (shouldLoad) return; // already loading/loaded
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setShouldLoad(true);
            obs.disconnect();
            break;
          }
        }
      },
      { rootMargin: VIEWPORT_PRELOAD_MARGIN, threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [shouldLoad]);

  const src = `/api/prep/pdf-page?workflow=${encodeURIComponent(workflow)}&parentRunId=${encodeURIComponent(parentRunId)}&page=${page}`;
  // Reset state whenever the src changes (different row / different page).
  useEffect(() => { setState("loading"); }, [src]);
  return (
    <div
      ref={containerRef}
      className={cn(
        "relative w-full overflow-hidden rounded-md border border-border bg-white",
        "aspect-[8.5/11]",
        className,
      )}
      data-pdf-page={page}
    >
      {state === "loading" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted text-xs text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading page {page}…</span>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[10px] underline opacity-60 hover:opacity-100"
            title="Open the PDF page request directly to debug"
          >
            <ExternalLink className="h-3 w-3" /> open URL
          </a>
        </div>
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground bg-muted">
          <FileX className="h-8 w-8 opacity-60" aria-hidden />
          <span className="font-medium">PDF preview unavailable</span>
          <span className="font-mono opacity-60">page {page}</span>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-[10px] underline opacity-80 hover:opacity-100"
          >
            <ExternalLink className="h-3 w-3" /> try the URL directly
          </a>
        </div>
      )}
      {shouldLoad && (
        <img
          key={src}
          src={src}
          alt={`PDF page ${page}`}
          decoding="async"
          // @ts-expect-error fetchpriority is a valid HTML attribute but React types lag.
          fetchpriority="high"
          onLoad={() => setState("ok")}
          onError={() => setState("error")}
          className={cn("h-full w-full object-contain", state !== "ok" && "opacity-0")}
        />
      )}
    </div>
  );
}
