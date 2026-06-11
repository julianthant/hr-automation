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

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  type LucideIcon,
} from "lucide-react";

export type StatusKey = "running" | "done" | "failed" | "pending" | "skipped" | "not found";

/**
 * A tracker entry/member as seen by status resolution. A cancelled row is the
 * tracker shape `status: "failed"` + `step: "cancelled"` — there is no separate
 * `cancelled` enum value, so `step` is the discriminator.
 */
interface StatusBearer {
  status: string;
  step?: string | null;
}

/**
 * The status key for a row, applying the ONE shared override every status map
 * needs: a cancelled row (`failed` + `step === "cancelled"`) is reported as
 * `"cancelled"`, not `"failed"`, so it renders amber (intentional) instead of
 * red (a bug). EntryItem's `STATUS_CONFIG`, the operation coordinator's
 * `HEADER_STATUS`, and the batch member status map all route their lookup
 * through this so the special-case can't drift between them. Each component
 * keeps its own status→class map keyed on the returned string.
 */
export function statusKeyForEntry(entry: StatusBearer): string {
  if (entry.status === "failed" && entry.step === "cancelled") return "cancelled";
  return entry.status;
}

/** Shared status → lucide icon (shape carries meaning across every status surface). */
const STATUS_ICON: Record<string, { Icon: LucideIcon; spin?: boolean }> = {
  running: { Icon: Loader2, spin: true },
  done: { Icon: CheckCircle2 },
  failed: { Icon: AlertTriangle },
  cancelled: { Icon: Clock },
  pending: { Icon: Clock },
  skipped: { Icon: Clock },
};

export interface MemberStatusSpec {
  Icon: LucideIcon;
  label: string;
  tone: string;
  spin?: boolean;
}

const MEMBER_STATUS_LABEL_TONE: Record<string, { label: string; tone: string }> = {
  done: { label: "done", tone: "text-success" },
  running: { label: "running", tone: "text-primary" },
  pending: { label: "queued", tone: "text-warning" },
  skipped: { label: "queued", tone: "text-warning" },
  failed: { label: "failed", tone: "text-destructive" },
  cancelled: { label: "cancelled", tone: "text-warning" },
};

/**
 * Member-row status spec (icon + label + tone) for the batch member preview.
 * Routes the cancelled special-case through {@link statusKeyForEntry} and reuses
 * the shared {@link STATUS_ICON} so it can't drift from the other status maps.
 */
export function memberStatusSpec(member: StatusBearer): MemberStatusSpec {
  const key = statusKeyForEntry(member);
  const labelTone = MEMBER_STATUS_LABEL_TONE[key] ?? MEMBER_STATUS_LABEL_TONE.pending;
  const icon = STATUS_ICON[key] ?? STATUS_ICON.pending;
  return {
    Icon: icon.Icon,
    label: labelTone.label,
    tone: labelTone.tone,
    ...(icon.spin ? { spin: true } : {}),
  };
}

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
    case "not found":
    case "Not found":
      return "bg-secondary/90 text-muted-foreground";
    default:
      return "";
  }
}
