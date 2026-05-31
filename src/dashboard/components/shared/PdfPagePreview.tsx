import { useEffect, useRef, useState } from "react";
import { FileX, Loader2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PdfPagePreviewProps {
  /** Workflow name forwarded to the `/api/prep/pdf-page` query. */
  workflow: string;
  parentRunId: string;
  /** 1-indexed page number. */
  page: number;
  fileId?: string;
  className?: string;
  onStatusChange?: (page: number, status: "loading" | "ok" | "error") => void;
}

// Pre-render N pages above + below the viewport so scrolling feels instant.
const VIEWPORT_PRELOAD_MARGIN_PX = 800;
const VIEWPORT_PRELOAD_MARGIN = `${VIEWPORT_PRELOAD_MARGIN_PX}px`;

type RectLike = Pick<DOMRect, "top" | "bottom" | "left" | "right">;
type LocationLike = Pick<Location, "protocol" | "hostname" | "port">;

export function isPreviewNearViewport(
  rect: RectLike,
  viewport: { width: number; height: number },
  marginPx = VIEWPORT_PRELOAD_MARGIN_PX,
): boolean {
  return (
    rect.bottom >= -marginPx &&
    rect.top <= viewport.height + marginPx &&
    rect.right >= -marginPx &&
    rect.left <= viewport.width + marginPx
  );
}

export function resolveDashboardApiSrc(path: string, locationLike?: LocationLike): string {
  const loc = locationLike ?? (typeof window === "undefined" ? undefined : window.location);
  if (!loc) return path;
  if (loc.port !== "5173") return path;
  const protocol = loc.protocol || "http:";
  const hostname = loc.hostname || "localhost";
  return `${protocol}//${hostname}:3838${path}`;
}

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
  fileId,
  className,
  onStatusChange,
}: PdfPagePreviewProps) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const imgRef = useRef<HTMLImageElement>(null);
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
    let obs: IntersectionObserver | null = null;
    let disposed = false;

    const markIfNearViewport = (): boolean => {
      if (disposed) return false;
      const rect = el.getBoundingClientRect();
      if (!isPreviewNearViewport(rect, { width: window.innerWidth, height: window.innerHeight })) {
        return false;
      }
      setShouldLoad(true);
      obs?.disconnect();
      window.removeEventListener("scroll", markIfNearViewport, true);
      window.removeEventListener("resize", markIfNearViewport);
      return true;
    };

    if (markIfNearViewport()) return;

    if ("IntersectionObserver" in window) {
      obs = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              markIfNearViewport();
              break;
            }
          }
        },
        { rootMargin: VIEWPORT_PRELOAD_MARGIN, threshold: 0 },
      );
      obs.observe(el);
    }

    window.addEventListener("scroll", markIfNearViewport, { capture: true, passive: true });
    window.addEventListener("resize", markIfNearViewport);
    const firstLayoutCheck = window.setTimeout(markIfNearViewport, 100);
    const secondLayoutCheck = window.setTimeout(markIfNearViewport, 500);

    return () => {
      disposed = true;
      obs?.disconnect();
      window.removeEventListener("scroll", markIfNearViewport, true);
      window.removeEventListener("resize", markIfNearViewport);
      window.clearTimeout(firstLayoutCheck);
      window.clearTimeout(secondLayoutCheck);
    };
  }, [shouldLoad]);

  const srcPath = fileId
    ? `/api/files/${encodeURIComponent(fileId)}/pages/${page}`
    : `/api/prep/pdf-page?workflow=${encodeURIComponent(workflow)}&parentRunId=${encodeURIComponent(parentRunId)}&page=${page}`;
  const src = resolveDashboardApiSrc(srcPath);

  // Reset state whenever the src changes (different row / different page).
  useEffect(() => {
    setState("loading");
    onStatusChange?.(page, "loading");
  }, [src, page, onStatusChange]);

  useEffect(() => {
    if (!shouldLoad) return;
    // 15s safety net — onLoad/onError fire reliably on the <img>; this
    // is the fallback for pathological cases where neither fires (e.g.,
    // navigation aborts the fetch silently).
    const timeout = window.setTimeout(() => {
      const img = imgRef.current;
      if (img?.complete && img.naturalWidth > 0) {
        setState("ok");
        onStatusChange?.(page, "ok");
      } else {
        setState("error");
        onStatusChange?.(page, "error");
      }
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [shouldLoad, src, page, onStatusChange]);

  const markLoaded = () => {
    const img = imgRef.current;
    if (!img || img.naturalWidth <= 0) return;
    setState("ok");
    onStatusChange?.(page, "ok");
  };

  const markFailed = () => {
    setState("error");
    onStatusChange?.(page, "error");
  };

  useEffect(() => {
    if (!shouldLoad) return;
    const img = imgRef.current;
    if (img?.complete) {
      if (img.naturalWidth > 0) {
        setState("ok");
        onStatusChange?.(page, "ok");
      } else {
        setState("error");
        onStatusChange?.(page, "error");
      }
    }
  }, [shouldLoad, src, page, onStatusChange]);

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
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
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
          ref={imgRef}
          key={src}
          src={src}
          srcSet={src}
          sizes="100vw"
          alt={`PDF page ${page}`}
          decoding="async"
          fetchPriority="high"
          onLoad={markLoaded}
          onError={markFailed}
          className={cn("h-full w-full object-contain", state !== "ok" && "opacity-0")}
        />
      )}
    </div>
  );
}
