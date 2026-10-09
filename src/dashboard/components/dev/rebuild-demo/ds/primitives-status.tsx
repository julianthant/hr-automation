import type { ComponentType, SVGProps } from "react";
import {
  Ban,
  CheckCircle2,
  CircleAlert,
  Clock,
  Loader2,
  PauseCircle,
  TriangleAlert,
  UserRoundSearch,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { dsClip, dsIcon, dsRadius, dsText } from "./tokens";

/**
 * DEV-ONLY — the eight ratified queue statuses.
 *
 * These eight values are the spine of the whole product: the queue, the rail
 * badges, the status bar, the notifications inbox, the archive and every
 * receipt all speak this vocabulary. Getting them distinguishable *at a glance
 * in a list of eighty rows* is the single highest-leverage visual decision in
 * the rebuild, so each status is separated on FOUR independent channels:
 *
 *   1. HUE          — amber / red / violet / blue / slate / green / neutral
 *   2. EMPHASIS     — solid · dashed · tinted · outline · ghost
 *   3. ICON         — a distinct silhouette per status
 *   4. TEXT         — the label itself, always present, never abbreviated
 *
 * Two statuses share the SOLID fill shape — `waiting` and `failed` stay the
 * loudest (amber / red). `verifiedDone` uses the same solid pill shape in
 * green with the word only (no icon, no age), so Done reads finished without
 * looking like a demand. Most rows in a healthy day are done; the quieter hue
 * is what lets them recede beside Waiting on you.
 *
 * Colour never carries meaning alone — an operator with a red/green deficiency
 * still reads emphasis tier, icon shape and the label.
 */

export type DsStatus =
  | "queued"
  | "running"
  | "waiting"
  | "parked"
  | "verifiedDone"
  | "doneWarnings"
  | "failed"
  | "cancelled";

/** How loud a status is allowed to be. Drives fill, weight and dot shape. */
export type DsStatusTier = "solid" | "dashed" | "tinted" | "outline" | "ghost";

export interface DsStatusSpec {
  /** The operator-facing name. Never abbreviate it, never translate it. */
  label: string;
  tier: DsStatusTier;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** chip surface: background + border */
  chip: string;
  /** the label's color inside the chip */
  text: string;
  /** the icon's color inside the chip */
  iconTone: string;
  /**
   * The icon's color when it stands ALONE on a panel surface with no chip
   * behind it (a row's leading glyph, a menu item, a legend).
   *
   * It cannot simply be `iconTone`: the two solid statuses paint dark ink on a
   * bright fill, and that ink is invisible on the near-black page. For the six
   * non-solid statuses the two are the same value.
   */
  soloTone: string;
  /** the standalone dot/marker fill (loud tiers) */
  dot: string;
  /** the standalone dot/marker outline (quiet tiers) — a literal class, never
      derived from `dot` at runtime: Tailwind only sees classes it can read in
      the source text. */
  dotBorder: string;
  /** extra text treatment that is not colour (e.g. strikethrough) */
  labelDecoration?: string;
  /** the icon spins — `running` only */
  spin?: boolean;
  /**
   * This status's PILL carries no icon — `verifiedDone` only.
   *
   * The word `Done` in the success green is the whole chip: it is the
   * commonest state in a healthy day, so every pixel it spends is spent on
   * most of the queue. It is not colour-only encoding — the word survives, and
   * it is the only status whose label is that word — and the status's
   * GUARANTEE is untouched: `Done` is still reachable only by reading the
   * write back out of the system, and the receipt still carries the read-back
   * checks that earned it. Only the label got shorter.
   *
   * The row's LEADING glyph (`StatusIcon`) is a different channel on a
   * different surface and keeps its check — the row grid has a column for it,
   * and an empty column is not a saving.
   */
  pillHideIcon?: boolean;
  /** what this status means for the operator; used as the chip's tooltip */
  meaning: string;
}

export const DS_STATUS: Record<DsStatus, DsStatusSpec> = {
  waiting: {
    // Was "Waiting on you · age" in solid amber. Operator: drop the timer,
    // and every waiting tag becomes the blue `Review` pill (same info solid
    // as the old outcome CTA) — the word names the work, not the wait.
    label: "Review",
    tier: "solid",
    icon: UserRoundSearch,
    chip: "bg-[var(--ds-info-solid-bg)] border-transparent",
    text: "text-[color:var(--ds-info-solid-fg)] font-semibold",
    pillHideIcon: true,
    iconTone: "text-[color:var(--ds-info-solid-fg)]",
    soloTone: "text-[color:var(--ds-info-fg)]",
    dot: "bg-[var(--ds-info-solid-bg)]",
    dotBorder: "border-[color:var(--ds-info-solid-bg)]",
    meaning:
      "Stopped at a gate for a decision. Nothing is written until you answer. Open Review to act.",
  },
  failed: {
    label: "Failed",
    tier: "solid",
    icon: TriangleAlert,
    chip: "bg-[var(--ds-status-failed-solid-bg)] border-transparent",
    text: "text-[color:var(--ds-status-failed-solid-fg)] font-semibold",
    iconTone: "text-[color:var(--ds-status-failed-solid-fg)]",
    soloTone: "text-[color:var(--ds-status-failed-fg)]",
    dot: "bg-[var(--ds-status-failed-mark)]",
    dotBorder: "border-[color:var(--ds-status-failed-mark)]",
    meaning: "Stopped on an error. Retry replays the same input.",
  },
  parked: {
    label: "Write parked",
    tier: "dashed",
    icon: PauseCircle,
    // The dashed hairline is this status's shape cue — nothing else dashes.
    chip:
      "bg-[var(--ds-status-parked-bg)] border-[color:var(--ds-status-parked-border)] ds-dashed",
    text: "text-[color:var(--ds-status-parked-fg)] font-medium",
    iconTone: "text-[color:var(--ds-status-parked-fg)]",
    soloTone: "text-[color:var(--ds-status-parked-fg)]",
    dot: "bg-[var(--ds-status-parked-mark)]",
    dotBorder: "border-[color:var(--ds-status-parked-mark)]",
    meaning:
      "A write may or may not have landed. Never auto-retried — you resolve present or absent.",
  },
  doneWarnings: {
    // Word is just `Done` — same length as verified Done. The long
    // "with warnings" qualifier shoved the title off the header beside the
    // triangle count chip that already names the warning (operator: keep
    // Done + △ n, drop "with warnings"). Amber tint + that chip distinguish
    // it from the green solid Done; the CircleAlert stays for filters/solo.
    label: "Done",
    tier: "tinted",
    icon: CircleAlert,
    chip:
      "bg-[var(--ds-status-done-warnings-bg)] border-[color:var(--ds-status-done-warnings-border)]",
    text: "text-[color:var(--ds-fg-secondary)]",
    pillHideIcon: true,
    iconTone: "text-[color:var(--ds-status-done-warnings-fg)]",
    soloTone: "text-[color:var(--ds-status-done-warnings-fg)]",
    dot: "bg-[var(--ds-status-done-warnings-mark)]",
    dotBorder: "border-[color:var(--ds-status-done-warnings-mark)]",
    meaning:
      "Finished, but something needs your eyes — a fallback, a gap, a rejected page. The △ count beside the pill names how many.",
  },
  running: {
    label: "Running",
    tier: "tinted",
    icon: Loader2,
    chip:
      "bg-[var(--ds-status-running-bg)] border-[color:var(--ds-status-running-border)]",
    text: "text-[color:var(--ds-status-running-fg)]",
    iconTone: "text-[color:var(--ds-status-running-fg)]",
    soloTone: "text-[color:var(--ds-status-running-fg)]",
    dot: "bg-[var(--ds-status-running-mark)]",
    dotBorder: "border-[color:var(--ds-status-running-mark)]",
    spin: true,
    meaning: "A worker owns it right now. Only cancel is offered.",
  },
  queued: {
    label: "Queued",
    tier: "outline",
    icon: Clock,
    // No fill at all: nothing has happened to this row yet.
    chip: "bg-transparent border-[color:var(--ds-status-queued-border)]",
    text: "text-[color:var(--ds-status-queued-fg)]",
    iconTone: "text-[color:var(--ds-status-queued-fg)]",
    soloTone: "text-[color:var(--ds-status-queued-fg)]",
    dot: "bg-[var(--ds-status-queued-mark)]",
    dotBorder: "border-[color:var(--ds-status-queued-mark)]",
    meaning: "Accepted, nothing has run. Can be bumped or cancelled.",
  },
  cancelled: {
    // Operator: same solid pill shape as Done, gray, no strikethrough.
    // Neither amber nor red — a deliberate stop is not a warning and not a failure.
    label: "Cancelled",
    tier: "solid",
    icon: Ban,
    chip: "bg-[var(--ds-status-cancelled-solid-bg)] border-transparent",
    text: "text-[color:var(--ds-status-cancelled-solid-fg)] font-semibold",
    pillHideIcon: true,
    iconTone: "text-[color:var(--ds-status-cancelled-solid-fg)]",
    soloTone: "text-[color:var(--ds-status-cancelled-fg)]",
    dot: "bg-[var(--ds-status-cancelled-mark)]",
    dotBorder: "border-[color:var(--ds-status-cancelled-mark)]",
    meaning: "You stopped it. Not an alert — a deliberate act.",
  },
  verifiedDone: {
    // `Verified done` → `Done`. Both terminal dones now share the short word;
    // green solid vs amber tint (+ △ count chip when warnings exist) is the
    // distinction — not a longer label that crowds the title.
    //
    // SOLID green fill, same shape as Waiting on you — just the word, no icon
    // and no age. A bare green `Done` next to a shield glyph was the prior
    // look; the operator asked for the Waiting-on-you pill, in green (2026-07-29).
    label: "Done",
    tier: "solid",
    icon: CheckCircle2,
    chip: "bg-[var(--ds-status-verified-done-solid-bg)] border-transparent",
    text: "text-[color:var(--ds-status-verified-done-solid-fg)] font-semibold",
    pillHideIcon: true,
    iconTone: "text-[color:var(--ds-status-verified-done-solid-fg)]",
    soloTone: "text-[color:var(--ds-status-verified-done-fg)]",
    dot: "bg-[var(--ds-status-verified-done-mark)]",
    dotBorder: "border-[color:var(--ds-status-verified-done-mark)]",
    meaning:
      "Finished AND read back from the system. The receipt carries the proof.",
  },
};

/** Reading order for pickers, legends and status bars: loudest first. */
export const DS_STATUS_ORDER: DsStatus[] = [
  "waiting",
  "failed",
  "parked",
  "doneWarnings",
  "running",
  "queued",
  "cancelled",
  "verifiedDone",
];

/** The two statuses that own the operator's attention. */
export const DS_ATTENTION_STATUSES: DsStatus[] = ["waiting", "failed"];

/**
 * A status plus its age. "Waiting on you" is a state; "Waiting on you · 10m"
 * is a priority — that is the difference between a queue you scan and a queue
 * you triage. Always pass `age` when you have it.
 */
export function dsStatusText(status: DsStatus, age?: string): string {
  const base = DS_STATUS[status].label;
  return age ? `${base} · ${age}` : base;
}

export type DsStatusPillSize = "sm" | "md";

const PILL_SIZE: Record<DsStatusPillSize, string> = {
  sm: "h-[var(--ds-h-xs)] px-[var(--ds-space-snug)] gap-[var(--ds-space-tight)]",
  md: "h-[var(--ds-h-sm)] px-[var(--ds-space-base)] gap-[var(--ds-space-snug)]",
};

/**
 * The status chip. This is the ONLY way a status may be rendered — do not
 * hand-roll a coloured span, and do not swap the icon or the label.
 *
 * ```tsx
 * <StatusPill status="waiting" age="12m" />
 * <StatusPill status="verifiedDone" size="sm" />
 * ```
 */
export function StatusPill({
  status,
  age,
  size = "md",
  hideIcon,
  label,
  className,
}: {
  status: DsStatus;
  /** how long it has been in this state — "12m", "2h". Show it when known. */
  age?: string;
  size?: DsStatusPillSize;
  /**
   * Drop the icon in extremely tight cells, or where the row already leads with
   * this exact glyph. The label always stays, so the status is still named.
   */
  hideIcon?: boolean;
  /**
   * Override the word only for a state that is NOT one of the eight — a
   * rejected record ("Rejected") never became work and has no status of its
   * own. Never use this to abbreviate or rename a real status.
   */
  label?: string;
  className?: string;
}) {
  const spec = DS_STATUS[status];
  const Icon = spec.icon;
  return (
    <span
      title={spec.meaning}
      className={cn(
        // `dsClip.token` gives the pill a ceiling of its parent's width. Without
        // it the label's `truncate` was decorative: a flex child defaults to
        // `min-width: auto` and refuses to shrink, so the pill simply overflowed
        // whatever it sat in rather than cutting.
        "inline-flex w-fit shrink-0 items-center border",
        dsClip.token,
        dsRadius.sm,
        dsText.meta,
        dsText.flush,
        PILL_SIZE[size],
        spec.chip,
        spec.text,
        className,
      )}
    >
      {!hideIcon && !spec.pillHideIcon && (
        <Icon
          aria-hidden
          className={cn(
            dsIcon.sm,
            "shrink-0",
            spec.iconTone,
            spec.spin && "animate-spin motion-reduce:animate-none",
          )}
        />
      )}
      <span className={cn(dsClip.text, label === undefined && spec.labelDecoration)}>
        {label ?? spec.label}
      </span>
      {/* The AGE never gives — except on Done, Review, and Write parked,
          which never carry one. Operator: timer not needed on Write parked;
          click the row to resolve. Gate age still lives on the detail panel's
          outcome bar where triage across two open gates needs it. */}
      {age &&
        status !== "verifiedDone" &&
        status !== "doneWarnings" &&
        status !== "waiting" &&
        status !== "parked" && (
        <span className={cn(dsText.nums, "shrink-0 opacity-80")} aria-label={`for ${age}`}>
          · {age}
        </span>
      )}
    </span>
  );
}

/**
 * The leading marker for a dense row where a full pill would not fit. Three
 * shapes, tier-derived: a filled DISC for the loud statuses, a RING for active
 * ones, a HOLLOW dot for finished ones. Always paired with the status label
 * somewhere in the row, or with an accessible name here.
 */
export function StatusDot({
  status,
  className,
}: {
  status: DsStatus;
  className?: string;
}) {
  const spec = DS_STATUS[status];
  const shape =
    spec.tier === "solid"
      ? cn("size-2", spec.dot) // filled disc — loudest
      : spec.tier === "ghost"
        ? cn("size-1.5 border bg-transparent opacity-70", spec.dotBorder) // hollow — finished
        : cn("size-1.5 border-2 bg-transparent", spec.dotBorder); // ring — active
  return (
    <span
      role="img"
      aria-label={spec.label}
      title={spec.label}
      className={cn("inline-block shrink-0 rounded-full", shape, className)}
    />
  );
}

/**
 * The status icon on its own — a row's leading glyph, a menu item, a legend.
 * It uses `soloTone`, not `iconTone`: there is no chip behind it, so the two
 * solid statuses must paint their hue rather than the dark ink they use ON that
 * chip (which would be invisible against the page).
 */
export function StatusIcon({
  status,
  className,
}: {
  status: DsStatus;
  className?: string;
}) {
  const spec = DS_STATUS[status];
  const Icon = spec.icon;
  return (
    <Icon
      aria-hidden
      className={cn(
        dsIcon.md,
        "shrink-0",
        spec.soloTone,
        spec.spin && "animate-spin motion-reduce:animate-none",
        className,
      )}
    />
  );
}
