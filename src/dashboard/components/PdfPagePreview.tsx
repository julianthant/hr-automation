import { useState } from "react";
import { FileX } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PdfPagePreviewProps {
  workflow: "emergency-contact" | "oath-signature";
  parentRunId: string;
  /** 1-indexed page number. */
  page: number;
  className?: string;
}

/**
 * <img> wrapper that pulls a single PDF page render from the
 * `/api/prep/pdf-page` endpoint. Three states:
 *   - loading  → animated muted skeleton
 *   - ok       → image visible
 *   - error    → 404 / decode failure → file-x icon + "PDF preview unavailable"
 *
 * Native lazy loading; the dashboard's review pane is paired-scroll, so
 * out-of-viewport pages don't fetch until the user scrolls to them.
 */
export function PdfPagePreview({
  workflow,
  parentRunId,
  page,
  className,
}: PdfPagePreviewProps) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const src = `/api/prep/pdf-page?workflow=${encodeURIComponent(workflow)}&parentRunId=${encodeURIComponent(parentRunId)}&page=${page}`;
  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-md border border-border bg-muted",
        "aspect-[8.5/11]",
        className,
      )}
      data-pdf-page={page}
    >
      {state === "loading" && (
        <div
          className="absolute inset-0 animate-pulse bg-muted"
          aria-label="Loading PDF page"
        />
      )}
      {state === "error" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
          <FileX className="h-8 w-8 opacity-40" aria-hidden />
          <span>PDF preview unavailable</span>
          <span className="font-mono opacity-60">page {page}</span>
        </div>
      )}
      <img
        src={src}
        alt={`PDF page ${page}`}
        loading="lazy"
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
        className={cn("h-full w-full object-contain", state !== "ok" && "opacity-0")}
      />
    </div>
  );
}
