import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { dsClip, dsFocus, dsIcon, dsMotion, dsRadius, dsText } from "./tokens";

/**
 * DEV-ONLY — core interactive primitives for the rebuild demo.
 *
 * Everything here is keyboard-reachable, carries the one focus ring, and reads
 * its colour/size/motion from `tokens.css`. Compose these; do not restyle them
 * at the call site beyond layout (margin, width, order).
 */

/* =========================================================================
 * Button
 * ====================================================================== */

/**
 * Six variants, and the choice is semantic, not decorative:
 *   primary   — the ONE affirmative action on a surface (Approve, Run, Save)
 *   secondary — a real alternative to primary (Cancel, Back, Skip)
 *   outline   — a peer action in a group of equals (toolbar, filters)
 *   ghost     — a tertiary action that must not compete (Details, Copy)
 *   danger    — an irreversible write (Delete, Terminate). Never the default.
 *   dangerGhost — destructive but low-stakes-looking (Remove row from a list)
 *
 * A surface has at most one `primary` and at most one `danger`.
 */
const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 cursor-pointer select-none items-center justify-center border",
    "whitespace-nowrap font-medium",
    dsRadius.md,
    dsFocus,
    dsMotion.fast,
    "active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-45",
  ),
  {
    variants: {
      variant: {
        primary: cn(
          "bg-[var(--ds-accent)] text-[color:var(--ds-accent-fg)] border-transparent",
          "hover:bg-[var(--ds-accent-hover)]",
        ),
        secondary: cn(
          "bg-[var(--ds-control-bg)] text-[color:var(--ds-control-fg)]",
          "border-[color:var(--ds-border-strong)]",
          "hover:bg-[var(--ds-control-bg-hover)]",
        ),
        outline: cn(
          "bg-transparent text-[color:var(--ds-fg-secondary)]",
          "border-[color:var(--ds-border-strong)]",
          "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
        ),
        ghost: cn(
          "bg-transparent border-transparent text-[color:var(--ds-fg-muted)]",
          "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
        ),
        danger: cn(
          "bg-[var(--ds-danger-solid)] text-[color:var(--ds-danger-fg)] border-transparent font-semibold",
          "hover:brightness-110",
        ),
        dangerGhost: cn(
          "bg-transparent text-[color:var(--ds-danger)]",
          "border-[color:var(--ds-danger-border)]",
          "hover:bg-[var(--ds-danger-quiet)]",
        ),
      },
      size: {
        sm: cn("h-[var(--ds-h-sm)] px-[var(--ds-space-snug)] gap-[var(--ds-space-tight)]", dsText.meta),
        md: cn("h-[var(--ds-h-md)] px-[var(--ds-space-cozy)] gap-[var(--ds-space-snug)]", dsText.ui),
        lg: cn("h-[var(--ds-h-lg)] px-[var(--ds-space-loose)] gap-[var(--ds-space-snug)]", dsText.ui),
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "secondary", size: "md", block: false },
  },
);

export type DsButtonVariant = NonNullable<
  VariantProps<typeof buttonVariants>["variant"]
>;

export interface DsButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color">,
    VariantProps<typeof buttonVariants> {
  /** icon before the label — 14px, never a bare emoji */
  icon?: ReactNode;
  /** icon after the label (chevrons, external-link) */
  iconAfter?: ReactNode;
  /**
   * Shows a spinner in place of `icon` and disables the button. The LABEL
   * stays put so the button never changes width mid-click.
   */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, DsButtonProps>(
  function Button(
    { className, variant, size, block, icon, iconAfter, loading, children, disabled, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={props.type ?? "button"}
        aria-busy={loading || undefined}
        disabled={disabled ?? loading}
        className={cn(buttonVariants({ variant, size, block }), className)}
        {...props}
      >
        {loading ? (
          <Loader2 aria-hidden className={cn(dsIcon.md, "animate-spin motion-reduce:animate-none")} />
        ) : (
          icon
        )}
        {children}
        {iconAfter}
      </button>
    );
  },
);

/* =========================================================================
 * IconButton
 * ====================================================================== */

const iconButtonVariants = cva(
  cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center border",
    dsRadius.md,
    dsFocus,
    dsMotion.fast,
    "active:translate-y-px",
    "disabled:pointer-events-none disabled:opacity-45",
  ),
  {
    variants: {
      variant: {
        ghost: cn(
          "bg-transparent border-transparent text-[color:var(--ds-fg-muted)]",
          "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
        ),
        outline: cn(
          "bg-transparent text-[color:var(--ds-fg-secondary)]",
          "border-[color:var(--ds-border-strong)]",
          "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
        ),
        danger: cn(
          "bg-transparent border-transparent text-[color:var(--ds-fg-muted)]",
          "hover:bg-[var(--ds-danger-quiet)] hover:text-[color:var(--ds-danger)]",
        ),
      },
      size: {
        // 20px — the chip height. For a control that sits ON a chip line and
        // must not grow it; anywhere else, start at `sm`.
        xs: "size-[var(--ds-h-xs)]",
        sm: "size-[var(--ds-h-sm)]",
        md: "size-[var(--ds-h-md)]",
        lg: "size-[var(--ds-h-lg)]",
      },
    },
    defaultVariants: { variant: "ghost", size: "md" },
  },
);

export interface DsIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">,
    VariantProps<typeof iconButtonVariants> {
  /** REQUIRED. Becomes both the accessible name and the tooltip. */
  label: string;
  icon: ReactNode;
  loading?: boolean;
}

/** An icon-only control. `label` is required — there is no unlabelled button. */
export const IconButton = forwardRef<HTMLButtonElement, DsIconButtonProps>(
  function IconButton(
    { className, variant, size, label, icon, loading, disabled, title, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={props.type ?? "button"}
        aria-label={label}
        title={title ?? label}
        aria-busy={loading || undefined}
        disabled={disabled ?? loading}
        className={cn(iconButtonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? (
          <Loader2 aria-hidden className={cn(dsIcon.md, "animate-spin motion-reduce:animate-none")} />
        ) : (
          icon
        )}
      </button>
    );
  },
);

/* =========================================================================
 * Badge / Count
 * ====================================================================== */

const badgeVariants = cva(
  cn(
    // `text-ellipsis` rides `dsClip.token` here rather than living on a child,
    // because a Badge's content is usually a bare text node with no element to
    // hang the cut on. `shrink-0` stays — a badge is not squeezed by its
    // neighbours — but `max-w-full` means it can never exceed its parent
    // either, which is what it used to do.
    "inline-flex w-fit shrink-0 items-center border text-ellipsis",
    dsClip.token,
    dsRadius.sm,
    dsText.micro,
    "h-[var(--ds-h-xs)] px-[var(--ds-space-snug)] gap-[var(--ds-space-tight)] font-medium",
  ),
  {
    variants: {
      tone: {
        // The recessed plane, the same one `Chip`'s neutral tone reads. It was
        // outlined-with-its-own-fill a hundred lines above the chip that had
        // already been migrated off exactly that treatment.
        neutral:
          "border-transparent bg-[var(--ds-recess-bg)] text-[color:var(--ds-recess-fg)]",
        info: "bg-[var(--ds-info-bg)] border-[color:var(--ds-info-border)] text-[color:var(--ds-info-fg)]",
        success:
          "bg-[var(--ds-success-bg)] border-[color:var(--ds-success-border)] text-[color:var(--ds-success-fg)]",
        warning:
          "bg-[var(--ds-status-waiting-bg)] border-[color:var(--ds-status-waiting-border)] text-[color:var(--ds-status-waiting-fg)]",
        danger:
          "bg-[var(--ds-danger-quiet)] border-[color:var(--ds-danger-border)] text-[color:var(--ds-danger)]",
        /** the loudest badge — reserve it for "N need you" */
        attention:
          "bg-[var(--ds-status-waiting-solid-bg)] border-transparent text-[color:var(--ds-status-waiting-solid-fg)] font-semibold",
        /**
         * A standing SYSTEM label that must stay legible but must never compete
         * for attention — an environment marker, a build tag. Same hue as
         * `info`, no fill, so it reads as chrome rather than as news.
         */
        infoOutline:
          "bg-transparent border-[color:var(--ds-info-border)] text-[color:var(--ds-info-fg)]",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface DsBadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/** A small labelled marker. For a bare number use `CountBadge`. */
export function Badge({ className, tone, ...props }: DsBadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/**
 * A numeric count. Always tabular so a ticking number does not reflow the row.
 * `zeroStyle="dim"` keeps the slot occupied (a count that disappears at 0
 * makes the eye re-scan the whole rail).
 */
export function CountBadge({
  value,
  tone = "neutral",
  max = 999,
  zeroStyle = "dim",
  className,
  ...props
}: Omit<DsBadgeProps, "children"> & {
  value: number;
  max?: number;
  zeroStyle?: "dim" | "hide";
}) {
  if (value === 0 && zeroStyle === "hide") return null;
  return (
    <span
      className={cn(
        badgeVariants({ tone }),
        dsText.nums,
        "justify-center px-[var(--ds-space-tight)] tabular-nums",
        value === 0 && "opacity-40",
        className,
      )}
      {...props}
    >
      {value > max ? `${max}+` : value}
    </span>
  );
}

/* =========================================================================
 * Chip
 * ====================================================================== */

export interface DsChipProps {
  children: ReactNode;
  /** a dim prefix inside the chip ("EID", "file") */
  label?: string;
  icon?: ReactNode;
  tone?: "neutral" | "info" | "warning" | "danger";
  /** renders the chip as a toggle with `aria-pressed` */
  selected?: boolean;
  onSelect?: () => void;
  /** renders a remove affordance with its own accessible name */
  onRemove?: () => void;
  removeLabel?: string;
  /**
   * A hover explanation. SUPPLEMENTARY only — a chip's own text must still say
   * what it is, because a title is invisible to touch and to a keyboard user who
   * never tabs to it (DESIGN.md: nothing load-bearing lives in a tooltip alone).
   */
  title?: string;
  className?: string;
}

/**
 * Tone is a FILL, never a fill plus an outline.
 *
 * Every chip sits on the one recessed plane (`--ds-recess-*`, see tokens.css):
 * the row footer's treatment — a fill and no line — is the house answer to
 * "this sits back from the card", and a chip is the same statement at chip
 * size. The border box is still there (`border-transparent`), so a chip that
 * genuinely needs an edge can draw one without anything shifting a pixel.
 */
const CHIP_TONE: Record<NonNullable<DsChipProps["tone"]>, string> = {
  neutral: "border-transparent bg-[var(--ds-recess-bg)] text-[color:var(--ds-recess-fg)]",
  info: "border-transparent bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)]",
  warning:
    "border-transparent bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
  danger: "border-transparent bg-[var(--ds-danger-quiet)] text-[color:var(--ds-danger)]",
};

/**
 * A compact fact or filter token: `EID 10084412`, `pdf · oath-batch-7.pdf`.
 * Values render monospace so columns of them line up down a dense queue.
 *
 * **A chip is a SINGLE-LINE token, always.** It truncates inside its own
 * border and never wraps, at any width, with any value. This is not a
 * preference: laid on the `ChipRow` grid track a long value used to wrap to a
 * second line and render OUTSIDE the border it belongs to — a chip drawn as
 * debris. The mechanism that stops it is `min-w-0` on the value span (a flex
 * child's `min-width` is `auto`, so without it the chip refuses to shrink
 * below its own text and overflows its cell) plus `whitespace-nowrap`.
 *
 * The full value stays reachable: it goes on the element's `title` and, when a
 * chip is a control, into its accessible name. **If a fact cannot survive
 * truncation it is not a chip** — put it on the row's `MetaLine`, on its own
 * line, where it can wrap.
 */
export function Chip({
  children,
  label,
  icon,
  tone = "neutral",
  selected,
  onSelect,
  onRemove,
  removeLabel = "Remove",
  title,
  className,
}: DsChipProps) {
  const interactive = Boolean(onSelect);
  const text = typeof children === "string" ? children : undefined;
  // The full value is never lost to the cut. For a screen reader nothing is
  // lost in the first place — `text-overflow` clips the PAINT, not the DOM, so
  // the accessible name is already whole and an `aria-label` here would only
  // overwrite it. What the cut does cost is the SIGHTED read, so a chip with
  // no explanatory title of its own falls back to printing itself on hover.
  const hoverText = title ?? text;
  const body = (
    <>
      {icon}
      {label && (
        <span className="shrink-0 text-[color:var(--ds-fg-muted)]">{label}</span>
      )}
      <span className={cn(dsText.nums, dsClip.text)}>{children}</span>
    </>
  );
  const shell = cn(
    "inline-flex w-fit items-center border",
    dsClip.token,
    dsRadius.sm,
    dsText.meta,
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
    CHIP_TONE[tone],
    selected && "bg-[var(--ds-surface-selected)] text-[color:var(--ds-fg)]",
    className,
  );

  if (interactive) {
    return (
      <button
        type="button"
        aria-pressed={selected ?? false}
        onClick={onSelect}
        title={hoverText}
        className={cn(
          shell,
          "cursor-pointer",
          dsFocus,
          dsMotion.fast,
          "hover:bg-[var(--ds-surface-3)]",
          // The same 1px dip Button uses. A filter chip is a button; without
          // this it was the only pressable in the system that ignored a press.
          "active:translate-y-px",
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <span className={shell} title={hoverText}>
      {body}
      {onRemove && (
        <button
          type="button"
          aria-label={`${removeLabel} ${typeof children === "string" ? children : ""}`.trim()}
          onClick={onRemove}
          className={cn(
            "-mr-0.5 inline-flex size-3.5 cursor-pointer items-center justify-center rounded-full",
            dsFocus,
            dsMotion.fast,
            "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
          )}
        >
          <X aria-hidden className="size-2.5" />
        </button>
      )}
    </span>
  );
}

/* =========================================================================
 * Small parts
 * ====================================================================== */

/** A keyboard hint. Shortcuts are first-class in this product — show them. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        // KEPT OUTLINED, deliberately, while every other `surface-2 + border`
        // token moved to the recessed plane: this one is drawing a KEY. The
        // outline plus the fill is the whole cue that says "a thing you press",
        // and a border-less keycap reads as a word in a slightly different
        // colour. Its raw `h-4 min-w-4 px-1` went on the scale, though — those
        // were three literals with no argument behind them.
        "inline-flex items-center justify-center border",
        "h-[var(--ds-h-xs)] min-w-[var(--ds-h-xs)] px-[var(--ds-space-tight)]",
        dsRadius.xs,
        dsText.micro,
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] font-mono text-[color:var(--ds-fg-muted)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn(dsIcon.md, "animate-spin motion-reduce:animate-none text-[color:var(--ds-fg-muted)]", className)}
    />
  );
}

/**
 * A loading placeholder. It must match the SHAPE of what is coming, so the
 * layout does not jump when real content lands — pass the same height/width
 * classes the real element uses.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "block animate-pulse motion-reduce:animate-none bg-[var(--ds-surface-3)]",
        dsRadius.sm,
        "h-3 w-full",
        className,
      )}
    />
  );
}

export function Separator({
  orientation = "horizontal",
  className,
}: {
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  return (
    <span
      role="separator"
      aria-orientation={orientation}
      className={cn(
        "block shrink-0 bg-[var(--ds-border)]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
    />
  );
}

/** Text for screen readers only — the accessible name for an icon-only region. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
