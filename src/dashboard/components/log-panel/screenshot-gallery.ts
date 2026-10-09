import type { ScreenshotEntry } from "@/components/hooks/useRunScreenshots";

/**
 * One grid item in the Screenshots tab — a whole capture EVENT, not a single
 * file. A capture of a tall page (a Kuali finalization form, a long UCPath
 * grid) emits several `-cNN` page-slice files in ONE entry; those collapse into
 * a single "folder" group (`isFolder`, cover = the first/top slice) so the grid
 * shows ONE tile instead of N, and the operator opens it to step through the
 * slices in order. A short page is a single-file group (`isFolder === false`),
 * rendered as an ordinary tile. The `entry` is preserved so a click hands the
 * full slice list to the lightbox queue.
 */
export interface ScreenshotGroup {
  /** Stable React key — entry timestamp + label + the cover file's path. */
  key: string;
  entry: ScreenshotEntry;
  /** Cover image = the first (top-of-page) slice; the folder's preview. */
  cover: ScreenshotEntry["files"][number];
  /** Number of slice files in the capture. `> 1` ⇒ a folder. */
  fileCount: number;
  isFolder: boolean;
  ts: number;
  kind: ScreenshotEntry["kind"];
  step: string | null;
  label: string;
  /** Cover slice's system. A sliced audit capture is one system, so this is
   *  the group's system for filtering. */
  system: string;
}

export const ALL_FILTER = "all";
export const ERRORS_FILTER = "errors";
export const STEPS_FILTER = "steps";
const SYSTEM_PREFIX = "system:";

/** Chip id for a per-system filter (round-trips through `filterScreenshotGroups`). */
export function systemFilterId(system: string): string {
  return `${SYSTEM_PREFIX}${system}`;
}

/**
 * Group entries → one grid item per capture event, newest first. A multi-slice
 * entry becomes a single folder group (cover = its first file); a single-file
 * entry is a group of one. Array sort is stable, so equal-timestamp entries
 * keep their incoming order. An entry whose files were all cleaned off disk
 * (no cover) is dropped.
 */
export function buildScreenshotGroups(
  entries: ScreenshotEntry[],
): ScreenshotGroup[] {
  const groups: ScreenshotGroup[] = [];
  for (const entry of entries) {
    const cover = entry.files[0];
    if (!cover) continue;
    groups.push({
      key: `${entry.ts}-${entry.label}-${cover.path}`,
      entry,
      cover,
      fileCount: entry.files.length,
      isFolder: entry.files.length > 1,
      ts: entry.ts,
      kind: entry.kind,
      step: entry.step,
      label: entry.label,
      system: cover.system,
    });
  }
  return groups.sort((a, b) => b.ts - a.ts);
}

export interface ScreenshotFilterChip {
  id: string;
  label: string;
  count: number;
  /** `error` chips carry the destructive tone so failures stay prominent. */
  tone: "default" | "error";
}

/**
 * Build the ordered chip set: `All`, then `Errors` (only when any error group
 * exists), then `Steps` (only when any step group exists), then one chip per
 * system present — most-populated first, ties broken alphabetically so the bar
 * is stable across refetches. Counts are by GROUP (visible tiles), so the `All`
 * count always equals the number of tiles rendered — a folder counts once.
 */
export function buildScreenshotFilters(
  groups: ScreenshotGroup[],
): ScreenshotFilterChip[] {
  const chips: ScreenshotFilterChip[] = [
    { id: ALL_FILTER, label: "All", count: groups.length, tone: "default" },
  ];

  const errorCount = groups.reduce(
    (sum, group) => (group.kind === "error" ? sum + 1 : sum),
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

  const stepCount = groups.reduce(
    (sum, group) => (group.kind === "step" ? sum + 1 : sum),
    0,
  );
  if (stepCount > 0) {
    chips.push({
      id: STEPS_FILTER,
      label: "Steps",
      count: stepCount,
      tone: "default",
    });
  }

  const bySystem = new Map<string, number>();
  for (const group of groups) {
    bySystem.set(group.system, (bySystem.get(group.system) ?? 0) + 1);
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
 * Apply a chip id to the group list. An unknown id — e.g. a filter whose chip
 * vanished after a refetch (errors cleared, a system no longer present) —
 * falls back to the full set rather than showing an empty grid.
 */
export function filterScreenshotGroups(
  groups: ScreenshotGroup[],
  filterId: string,
): ScreenshotGroup[] {
  if (filterId === ERRORS_FILTER) {
    return groups.filter((group) => group.kind === "error");
  }
  if (filterId === STEPS_FILTER) {
    return groups.filter((group) => group.kind === "step");
  }
  if (filterId.startsWith(SYSTEM_PREFIX)) {
    const system = filterId.slice(SYSTEM_PREFIX.length);
    return groups.filter((group) => group.system === system);
  }
  return groups;
}
