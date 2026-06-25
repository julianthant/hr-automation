import type { ScreenshotEntry } from "@/components/hooks/useRunScreenshots";

/**
 * One screenshot file, lifted out of its parent entry into a self-contained
 * gallery tile. An entry can carry several files (one per captured system), and
 * the gallery shows each as its own image-forward tile so the operator scans by
 * picture instead of expanding rows. The `entry`/`fileIdx` pair is preserved so
 * a click can hand the original coordinates back to the lightbox queue.
 */
export interface ScreenshotTileData {
  /** Stable React key — entry timestamp + label + the file's own path. */
  key: string;
  entry: ScreenshotEntry;
  fileIdx: number;
  file: ScreenshotEntry["files"][number];
  ts: number;
  kind: ScreenshotEntry["kind"];
  step: string | null;
  label: string;
  system: string;
}

export const ALL_FILTER = "all";
export const ERRORS_FILTER = "errors";
const SYSTEM_PREFIX = "system:";

/** Chip id for a per-system filter (round-trips through `filterScreenshotTiles`). */
export function systemFilterId(system: string): string {
  return `${SYSTEM_PREFIX}${system}`;
}

/**
 * Flatten entries → one tile per file, newest first. Array sort is stable, so
 * files within the same entry keep their declared order (chunk order for a
 * paged capture) and equal-timestamp entries keep their incoming order.
 */
export function flattenScreenshotTiles(
  entries: ScreenshotEntry[],
): ScreenshotTileData[] {
  const tiles: ScreenshotTileData[] = [];
  for (const entry of entries) {
    entry.files.forEach((file, fileIdx) => {
      tiles.push({
        key: `${entry.ts}-${entry.label}-${file.path}`,
        entry,
        fileIdx,
        file,
        ts: entry.ts,
        kind: entry.kind,
        step: entry.step,
        label: entry.label,
        system: file.system,
      });
    });
  }
  return tiles.sort((a, b) => b.ts - a.ts);
}

export interface ScreenshotFilterChip {
  id: string;
  label: string;
  count: number;
  /** `error` chips carry the destructive tone so failures stay prominent. */
  tone: "default" | "error";
}

/**
 * Build the ordered chip set: `All`, then `Errors` (only when any error tile
 * exists), then one chip per system present — most-populated first, ties broken
 * alphabetically so the bar is stable across refetches.
 */
export function buildScreenshotFilters(
  tiles: ScreenshotTileData[],
): ScreenshotFilterChip[] {
  const chips: ScreenshotFilterChip[] = [
    { id: ALL_FILTER, label: "All", count: tiles.length, tone: "default" },
  ];

  const errorCount = tiles.reduce(
    (sum, tile) => (tile.kind === "error" ? sum + 1 : sum),
    0,
  );
  if (errorCount > 0) {
    chips.push({
      id: ERRORS_FILTER,
      label: "Errors",
      count: errorCount,
      tone: "error",
    });
  }

  const bySystem = new Map<string, number>();
  for (const tile of tiles) {
    bySystem.set(tile.system, (bySystem.get(tile.system) ?? 0) + 1);
  }
  const systemChips = [...bySystem.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([system, count]): ScreenshotFilterChip => ({
      id: systemFilterId(system),
      label: system,
      count,
      tone: "default",
    }));

  return [...chips, ...systemChips];
}

/**
 * Apply a chip id to the tile list. An unknown id — e.g. a filter whose chip
 * vanished after a refetch (errors cleared, a system no longer present) —
 * falls back to the full set rather than showing an empty grid.
 */
export function filterScreenshotTiles(
  tiles: ScreenshotTileData[],
  filterId: string,
): ScreenshotTileData[] {
  if (filterId === ERRORS_FILTER) {
    return tiles.filter((tile) => tile.kind === "error");
  }
  if (filterId.startsWith(SYSTEM_PREFIX)) {
    const system = filterId.slice(SYSTEM_PREFIX.length);
    return tiles.filter((tile) => tile.system === system);
  }
  return tiles;
}
