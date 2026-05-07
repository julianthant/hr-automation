/**
 * Shared status → badge-color utilities.
 *
 * Multiple components surface the same five-status palette (running, done,
 * failed, pending, skipped) — LogPanel header, EntryItem queue rows,
 * SearchResults across-workflow rows, StatPills filter buttons,
 * EditDataTab's "Copy from prior" popover, etc. This module centralises the
 * tinted-background + matching-foreground tokens so a future palette tweak
 * is a one-line change here, not a sweep across every consumer.
 *
 * Why these specific hex tokens:
 *   - `done` uses `#4ade80` (Tailwind `green-400`) — bright enough on the
 *     warm-dark theme to read as "success" without screaming. The theme's
 *     `--success` variable isn't defined, so the hex is the contract.
 *   - `pending` uses `#fbbf24` (Tailwind `amber-400`) — same family as
 *     `--primary` (warm orange) but lighter, distinct enough that "queued"
 *     reads differently from "in-flight running" (which uses `--primary`).
 *   - `running` uses `--primary` (theme-driven amber) — picked up via
 *     `bg-primary/15 text-primary`, so a future theme swap recolors it
 *     automatically. Critically distinct from `pending`: a viewer scanning
 *     the queue expects "running" to be the dominant theme accent.
 *   - `failed` uses `--destructive` — semantic and theme-driven.
 *   - `skipped` uses `--secondary` + `--muted-foreground` — visually
 *     subdued, signaling "intentionally bypassed, no attention needed".
 *
 * Tailwind constraint: opacity classes (`bg-X/12`) are scanned as static
 * strings by the JIT, so dynamic-alpha helpers don't work. The "subtle"
 * (12% bg opacity) and "prominent" (15% bg opacity) variants below are
 * the only two we surface — every existing caller fits one of them, and
 * promoting more variants is one entry away if needed.
 */

export type StatusKey = "running" | "done" | "failed" | "pending" | "skipped";

/**
 * Tailwind class string for a tinted status badge — bg/12 + text.
 * Returns the empty string for unknown statuses so the caller's `cn(...)`
 * cleanly falls through to its default styling.
 */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case "running":
      return "bg-primary/15 text-primary";
    case "done":
      return "bg-[#4ade80]/12 text-[#4ade80]";
    case "failed":
      return "bg-destructive/12 text-destructive";
    case "pending":
      return "bg-[#fbbf24]/12 text-[#fbbf24]";
    case "skipped":
      return "bg-secondary text-muted-foreground";
    default:
      return "";
  }
}
