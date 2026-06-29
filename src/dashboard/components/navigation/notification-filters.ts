import type { AppNotification } from "@/lib/notifications";

/**
 * Pure filter logic for the notification center, mirroring the screenshot
 * gallery's chip model (`log-panel/screenshot-gallery.ts`): an adaptive chip set
 * built from whatever notifications are present, plus a pure apply function. The
 * bell header renders the chips and `filterNotifications` narrows the feed —
 * keeping all the branching unit-testable away from the component.
 *
 * Two axes are exposed as chips:
 *   - `All` (always) and `Errors` (severity === "error", only when present) — a
 *     cross-category severity lens;
 *   - one chip per `domain` CATEGORY present (`run` → Runs, `ocr` → OCR,
 *     `capture` → Capture), derived from the notification `kind`
 *     (`<domain>.<event>`), so a future kind gets a chip with no code change.
 */

export const ALL_FILTER = "all";
export const ERRORS_FILTER = "errors";
const CATEGORY_PREFIX = "category:";

/** Chip id for a per-category filter (round-trips through `filterNotifications`). */
export function categoryFilterId(category: string): string {
  return `${CATEGORY_PREFIX}${category}`;
}

/** The `domain` half of a `domain.event` kind — the category key (`run`/`ocr`/`capture`). */
export function categoryForNotification(n: AppNotification): string {
  const dot = n.kind.indexOf(".");
  return dot > 0 ? n.kind.slice(0, dot) : n.kind;
}

/** Human label for a category key. Falls back to a capitalized key for new domains. */
export function categoryLabel(category: string): string {
  switch (category) {
    case "run":
      return "Runs";
    case "ocr":
      return "OCR";
    case "capture":
      return "Capture";
    default:
      return category.charAt(0).toUpperCase() + category.slice(1);
  }
}

export interface NotificationFilterChip {
  id: string;
  label: string;
  count: number;
  /** `error` chips carry the destructive tone so failures stay prominent. */
  tone: "default" | "error";
}

/**
 * Build the ordered chip set: `All`, then `Errors` (only when an error
 * notification exists), then one chip per category present — most-populated
 * first, ties broken alphabetically so the bar is stable across re-renders.
 */
export function buildNotificationFilters(
  list: AppNotification[],
): NotificationFilterChip[] {
  const chips: NotificationFilterChip[] = [
    { id: ALL_FILTER, label: "All", count: list.length, tone: "default" },
  ];

  const errorCount = list.reduce((sum, n) => (n.severity === "error" ? sum + 1 : sum), 0);
  if (errorCount > 0) {
    chips.push({ id: ERRORS_FILTER, label: "Errors", count: errorCount, tone: "error" });
  }

  const byCategory = new Map<string, number>();
  for (const n of list) {
    const cat = categoryForNotification(n);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }
  const categoryChips = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]): NotificationFilterChip => ({
      id: categoryFilterId(category),
      label: categoryLabel(category),
      count,
      tone: "default",
    }));

  return [...chips, ...categoryChips];
}

/**
 * Apply a chip id to the notification list. An unknown id — e.g. a chip that
 * vanished after the feed changed (errors cleared, a category emptied) — falls
 * back to the full list rather than showing an empty center.
 */
export function filterNotifications(
  list: AppNotification[],
  filterId: string,
): AppNotification[] {
  if (filterId === ERRORS_FILTER) {
    return list.filter((n) => n.severity === "error");
  }
  if (filterId.startsWith(CATEGORY_PREFIX)) {
    const category = filterId.slice(CATEGORY_PREFIX.length);
    return list.filter((n) => categoryForNotification(n) === category);
  }
  return list;
}
