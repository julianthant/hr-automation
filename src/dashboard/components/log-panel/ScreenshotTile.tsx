import { Layers, Maximize2 } from "lucide-react";
import type { ScreenshotGroup } from "./screenshot-gallery";

const KIND_BADGE: Record<
  ScreenshotGroup["kind"],
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
  step: {
    label: "Step",
    className: "border-info/40 bg-info/15 text-info",
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
 * One image-forward gallery tile representing a whole capture event. A
 * single-file capture is an ordinary tile; a multi-slice capture (a tall Kuali
 * form, a long grid) is a FOLDER — the cover is the first slice, a persistent
 * `Layers · N` badge marks it as a stack, and a bottom strip invites opening
 * the gallery. Clicking either opens the lightbox: a folder lands on its first
 * slice and the operator pages down through all of them; the whole capture
 * shows as one tile so it never floods the grid. Error captures keep a
 * persistent destructive ring so they stay visible even in the "All" view.
 */
export function ScreenshotTile({
  group,
  onOpen,
}: {
  group: ScreenshotGroup;
  onOpen: (group: ScreenshotGroup) => void;
}) {
  const badge = KIND_BADGE[group.kind];
  const isError = group.kind === "error";
  const { isFolder, fileCount } = group;
  const time = formatTileTime(group.ts);
  const caption = group.label || group.step || group.system;
  const altDetail = [group.system, group.step ?? group.label]
    .filter(Boolean)
    .join(" — ");
  const ariaLabel = isFolder
    ? `Open ${group.system} capture — ${caption}, ${fileCount} pages, captured ${time.short}`
    : `Open ${group.system} screenshot — ${caption}, captured ${time.short}`;

  return (
    <button
      type="button"
      onClick={() => onOpen(group)}
      aria-label={ariaLabel}
      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border bg-card text-left shadow-sm transition-[border-color,box-shadow] duration-200 hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        isError ? "border-destructive/50 ring-1 ring-destructive/40" : "border-border"
      }`}
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-muted">
        <img
          src={group.cover.url}
          srcSet={group.cover.url}
          sizes="(min-width: 1536px) 18rem, (min-width: 768px) 16rem, 50vw"
          alt={`${altDetail} screenshot${isFolder ? ` (page 1 of ${fileCount})` : ""}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-top transition-transform duration-200 motion-safe:group-hover:scale-105 motion-reduce:transform-none"
        />

        {isFolder && (
          <span
            className="pointer-events-none absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md border border-border bg-card/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-foreground shadow-sm backdrop-blur"
            title={`${fileCount} pages`}
          >
            <Layers aria-hidden className="h-3 w-3" />
            {fileCount}
          </span>
        )}

        <span
          aria-hidden
          className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card/90 text-foreground opacity-0 shadow-sm backdrop-blur transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {isFolder ? <Layers className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </span>

        {isFolder && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 border-t border-border/60 bg-card/85 px-2 py-1 font-mono text-[10.5px] uppercase tracking-wide text-foreground/90 backdrop-blur">
            <Layers aria-hidden className="h-3 w-3 shrink-0" />
            View all {fileCount} pages
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-xs font-semibold uppercase tracking-wide text-foreground">
            {group.system}
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
          title={group.label || undefined}
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
