import { useEffect, useMemo, useState } from "react";
import { ScreenshotLightbox, type LightboxItem } from "./ScreenshotLightbox";
import { ScreenshotTile } from "./ScreenshotTile";
import {
  ALL_FILTER,
  buildScreenshotFilters,
  filterScreenshotTiles,
  flattenScreenshotTiles,
  type ScreenshotTileData,
} from "./screenshot-gallery";
import { useRunScreenshots } from "@/components/hooks/useRunScreenshots";

export function ScreenshotsPanel({
  workflow,
  itemId,
  screenshotEventCount,
  runId,
}: {
  workflow: string | null;
  itemId: string | null;
  /** Count of `screenshot` events in useRunEvents — drives refetch. The
   *  parent owns the SSE subscription so we don't open a duplicate one
   *  here (HTTP/1.1 slot exhaustion, see useRunScreenshots). */
  screenshotEventCount: number;
  /** When set, list only PNGs tied to this tracker run (matches RunSelector tab). */
  runId?: string | null;
}) {
  const { entries } = useRunScreenshots(workflow, itemId, screenshotEventCount, runId);
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const tiles = useMemo(() => flattenScreenshotTiles(entries), [entries]);
  const chips = useMemo(() => buildScreenshotFilters(tiles), [tiles]);
  const visibleTiles = useMemo(
    () => filterScreenshotTiles(tiles, filter),
    [tiles, filter],
  );

  // Self-heal: if the active filter's chip disappears (errors cleared, a system
  // no longer present after a refetch), fall back to All.
  useEffect(() => {
    if (!chips.some((chip) => chip.id === filter)) setFilter(ALL_FILTER);
  }, [chips, filter]);

  // The lightbox steps through the CURRENTLY VISIBLE set — what the operator
  // sees is what arrow keys walk.
  const flat = useMemo<LightboxItem[]>(
    () => visibleTiles.map((tile) => ({ entry: tile.entry, fileIdx: tile.fileIdx })),
    [visibleTiles],
  );

  if (tiles.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        No screenshots captured for this run yet.
      </div>
    );
  }

  const openTile = (tile: ScreenshotTileData) => {
    const idx = visibleTiles.findIndex((item) => item.key === tile.key);
    if (idx >= 0) setLightboxIdx(idx);
  };

  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-border bg-card px-6 py-2.5">
        <div
          role="group"
          aria-label="Filter screenshots by type or system"
          className="flex flex-wrap items-center gap-1.5"
        >
          {chips.map((chip) => {
            const active = chip.id === filter;
            const activeClass =
              chip.tone === "error"
                ? "border-destructive bg-destructive text-destructive-foreground"
                : "border-primary bg-primary text-primary-foreground";
            const idleClass =
              chip.tone === "error"
                ? "border-destructive/30 text-destructive hover:bg-destructive/10"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground";
            return (
              <button
                key={chip.id}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(chip.id)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wide transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  active ? activeClass : idleClass
                }`}
              >
                <span>{chip.label}</span>
                <span
                  className={`rounded px-1 text-[10px] tabular-nums ${
                    active ? "bg-background/25 text-current" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {chip.count}
                </span>
              </button>
            );
          })}
        </div>
        <p className="sr-only" aria-live="polite">
          {visibleTiles.length} {visibleTiles.length === 1 ? "screenshot" : "screenshots"} shown
        </p>
      </div>

      <div className="px-6 py-4">
        {visibleTiles.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">
            No screenshots match this filter.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
            {visibleTiles.map((tile) => (
              <ScreenshotTile key={tile.key} tile={tile} onOpen={openTile} />
            ))}
          </div>
        )}
      </div>

      {lightboxIdx !== null && flat.length > 0 && (
        <ScreenshotLightbox
          items={flat}
          idx={Math.min(lightboxIdx, flat.length - 1)}
          onNavigate={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}
