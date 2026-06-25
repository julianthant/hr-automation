import { Maximize2 } from "lucide-react";
import type { ScreenshotTileData } from "./screenshot-gallery";

const KIND_BADGE: Record<
  ScreenshotTileData["kind"],
  { label: string; className: string }
> = {
  error: {
    label: "Error",
    className: "border-destructive/40 bg-destructive/15 text-destructive",
  },
  form: {
    label: "Form",
    className: "border-primary/40 bg-primary/15 text-primary",
  },
  manual: {
    label: "Manual",
    className: "border-border bg-muted text-muted-foreground",
  },
};

function formatTileTime(ts: number): { short: string; full: string } {
  const date = new Date(ts);
  return {
    short: date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }),
    full: date.toLocaleString(),
  };
}

/**
 * One image-forward gallery tile. The whole tile is the button — clicking opens
 * the lightbox at this file. Error captures keep a persistent destructive ring
 * so they stay visible even in the unfiltered "All" view.
 */
export function ScreenshotTile({
  tile,
  onOpen,
}: {
  tile: ScreenshotTileData;
  onOpen: (tile: ScreenshotTileData) => void;
}) {
  const badge = KIND_BADGE[tile.kind];
  const isError = tile.kind === "error";
  const time = formatTileTime(tile.ts);
  const caption = tile.label || tile.step || tile.system;
  const altDetail = [tile.system, tile.step ?? tile.label]
    .filter(Boolean)
    .join(" — ");

  return (
    <button
      type="button"
      onClick={() => onOpen(tile)}
      aria-label={`Open ${tile.system} screenshot — ${caption}, captured ${time.short}`}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isError ? "border-destructive/50 ring-1 ring-destructive/40" : "border-border"
      }`}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        <img
          src={tile.file.url}
          srcSet={tile.file.url}
          sizes="(min-width: 1536px) 18rem, (min-width: 768px) 16rem, 50vw"
          alt={`${altDetail} screenshot`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-top transition-transform duration-200 motion-safe:group-hover:scale-105 motion-reduce:transform-none"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card/90 text-foreground opacity-0 shadow-sm backdrop-blur transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </span>
      </div>

      <div className="flex flex-col gap-1 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs font-semibold uppercase tracking-wide text-foreground">
            {tile.system}
          </span>
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${badge.className}`}
          >
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-current opacity-80"
            />
            {badge.label}
          </span>
        </div>
        <span
          className="truncate font-mono text-[11px] text-foreground/80"
          title={tile.label || undefined}
        >
          {caption}
        </span>
        <span
          className="font-mono text-[11px] text-muted-foreground"
          title={time.full}
        >
          {time.short}
        </span>
      </div>
    </button>
  );
}
