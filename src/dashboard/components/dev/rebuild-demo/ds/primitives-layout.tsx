import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CircleAlert, Info, ShieldAlert, TriangleAlert, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { dsElev, dsFocus, dsIcon, dsMotion, dsRadius, dsText } from "./tokens";

/**
 * DEV-ONLY — containers, structure and navigation for the rebuild demo.
 *
 * The layout rule of this product: DEPTH COMES FROM SURFACE + HAIRLINE, not
 * from shadow. A Panel sits on the page; a Card sits in a Panel; a well sits
 * in a Card. Anything with a shadow is FLOATING (menu, dialog, drawer, toast)
 * — if it is not floating and it has a shadow, that is a bug.
 */

/* =========================================================================
 * Panel — the primary region container (queue, log, settings, inbox…)
 * ====================================================================== */

export function Panel({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <section
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden border",
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
        dsRadius.lg,
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

/**
 * A panel's header. `title` is the only required part; `meta` is the quiet
 * right-hand slot for counts and timestamps, `actions` for controls.
 */
export function PanelHeader({
  title,
  subtitle,
  icon,
  meta,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-[var(--ds-space-base)] border-b px-[var(--ds-space-cozy)]",
        "min-h-[var(--ds-h-bar)] border-[color:var(--ds-border)]",
        className,
      )}
    >
      {icon && <span className="shrink-0 text-[color:var(--ds-fg-muted)]">{icon}</span>}
      <span className="flex min-w-0 flex-col">
        <span className={cn(dsText.title, "truncate font-semibold text-[color:var(--ds-fg)]")}>
          {title}
        </span>
        {subtitle && (
          <span className={cn(dsText.meta, "truncate text-[color:var(--ds-fg-muted)]")}>
            {subtitle}
          </span>
        )}
      </span>
      {meta && (
        <span className={cn(dsText.meta, "ml-auto shrink-0 text-[color:var(--ds-fg-muted)]")}>
          {meta}
        </span>
      )}
      {actions && (
        <span className={cn("flex shrink-0 items-center gap-[var(--ds-space-tight)]", !meta && "ml-auto")}>
          {actions}
        </span>
      )}
    </header>
  );
}

/** A secondary bar under a PanelHeader: filters, search, view switches. */
export function PanelToolbar({
  label,
  className,
  children,
}: {
  /** accessible name — a toolbar without one is a mystery to a screen reader */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex shrink-0 items-center gap-[var(--ds-space-tight)] overflow-x-auto border-b px-[var(--ds-space-base)]",
        "min-h-[var(--ds-h-bar)] border-[color:var(--ds-border-subtle)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The scrolling region of a Panel. Exactly one per Panel. */
export function PanelBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>;
}

export function PanelFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center gap-[var(--ds-space-base)] border-t px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)]",
        className,
      )}
    >
      {children}
    </footer>
  );
}

/* =========================================================================
 * Card — a single object inside a Panel (a run, a session, a receipt)
 * ====================================================================== */

export function Card({
  interactive,
  selected,
  tone = "default",
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  /** hover/press affordance — only when the whole card is clickable */
  interactive?: boolean;
  selected?: boolean;
  /** `attention` draws the left rail in amber; use it for gated rows only */
  tone?: "default" | "attention" | "danger";
}) {
  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col border bg-[var(--ds-surface-1)]",
        dsRadius.lg,
        dsMotion.base,
        "border-[color:var(--ds-border)]",
        tone === "attention" &&
          "border-l-[length:var(--ds-border-w-rail)] border-l-[color:var(--ds-status-waiting-mark)]",
        tone === "danger" &&
          "border-l-[length:var(--ds-border-w-rail)] border-l-[color:var(--ds-status-failed-fg)]",
        interactive && cn("cursor-pointer hover:border-[color:var(--ds-border-strong)] hover:bg-[var(--ds-surface-2)]"),
        selected && "border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-selected)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-[var(--ds-space-base)] px-[var(--ds-space-cozy)] pt-[var(--ds-space-base)]", className)}>
      {children}
    </div>
  );
}

/**
 * A card's content.
 *
 * `grow` is what makes a card in a GRID behave. Sibling cards in a grid row all
 * stretch to the tallest one, but a body that does not claim the slack leaves
 * it below itself — so the card's border sits at the row's height while its
 * content stops wherever it happened to end, and `CardFooter` / `CardBase`
 * cannot pin to the bottom because there is nothing pushing them there.
 *
 * It sets `flex-grow`, never `flex-1`: the body absorbs the extra space without
 * having its basis reset, so nothing inside is squeezed to make it fit.
 *
 * Pass it whenever the card is one of several in a row. It costs nothing on a
 * card that stands alone.
 */
export function CardBody({
  grow,
  className,
  children,
}: {
  /** claim the card's leftover height — required for anything to sit on the bottom edge */
  grow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]", grow && "grow", className)}>
      {children}
    </div>
  );
}

/**
 * The card's BASE — whatever must sit on the bottom edge of the row rather than
 * at the end of this card's own content.
 *
 * The defect it exists to kill: a card is a flex column that stretches to its
 * grid row's height, its trailing element is separated by a fixed `mt-*`, and
 * so a card whose description wraps to two lines pushes its button a line lower
 * than the sibling beside it. Every such card was fixing it locally, or not at
 * all — `DemoShell`'s Session Cards got it right inline and nothing else could
 * reuse that.
 *
 * ```tsx
 * <Card>
 *   <CardBody grow className="flex flex-col gap-[var(--ds-space-snug)]">
 *     <p>…description of any length…</p>
 *     <CardBase><Button>See this candidate</Button></CardBase>
 *   </CardBody>
 * </Card>
 * ```
 *
 * **It must sit inside a flex column** (a `CardBody`/card that is
 * `flex flex-col`) — `mt-auto` is a flexbox mechanism and does nothing in a
 * block container. The slack lands ABOVE it, and is left empty on purpose: a
 * card with less to say genuinely has less to say, and padding it out dresses
 * it up as fuller than it is.
 */
export function CardBase({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mt-auto flex min-w-0 flex-col", className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center gap-[var(--ds-space-tight)] border-t px-[var(--ds-space-cozy)] py-[var(--ds-space-snug)]",
        "border-[color:var(--ds-border-subtle)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** An uppercase micro heading above a group of things. Not a `<h*>` substitute. */
export function SectionLabel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn(dsText.caps, "text-[color:var(--ds-fg-muted)]", className)}>{children}</div>
  );
}

/* =========================================================================
 * Banner / Callout
 * ====================================================================== */

const BANNER_TONE = {
  info: {
    shell: "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)]",
    icon: "text-[color:var(--ds-info-fg)]",
    Icon: Info,
    live: "status" as const,
  },
  success: {
    shell: "border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)]",
    icon: "text-[color:var(--ds-success-fg)]",
    Icon: CheckCircle2,
    live: "status" as const,
  },
  warning: {
    shell:
      "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
    icon: "text-[color:var(--ds-status-waiting-fg)]",
    Icon: CircleAlert,
    live: "status" as const,
  },
  danger: {
    shell: "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)]",
    icon: "text-[color:var(--ds-danger)]",
    Icon: TriangleAlert,
    live: "alert" as const,
  },
};

export type DsBannerTone = keyof typeof BANNER_TONE;

/**
 * An in-page message attached to a surface (not a toast — this one stays).
 * `danger` announces as an alert; the rest as status. Keep the title to one
 * line and put the recovery action in `action` — a message with no next step
 * is a message the operator cannot act on.
 */
export function Banner({
  tone = "info",
  title,
  children,
  icon,
  action,
  className,
}: {
  tone?: DsBannerTone;
  title: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const spec = BANNER_TONE[tone];
  const Icon = spec.Icon;
  return (
    <div
      role={spec.live}
      className={cn(
        "flex items-start gap-[var(--ds-space-base)] border p-[var(--ds-space-cozy)]",
        dsRadius.md,
        spec.shell,
        className,
      )}
    >
      <span className={cn("mt-px shrink-0", spec.icon)}>
        {icon ?? <Icon aria-hidden className={dsIcon.lg} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-tight)]">
        <div className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>{title}</div>
        {children && (
          <div className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{children}</div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* =========================================================================
 * PageHeader — the bar at the top of a full-page takeover
 * ====================================================================== */

/**
 * The header a full-page view wears when it replaces the dashboard: a way back,
 * what you are looking at, and at most one action.
 *
 * The three takeovers (Archive, Explorer, Activity report) each hand-rolled
 * this, and drifted — two put the back button before the title and one after,
 * the icons were `size-4` in two places and `dsIcon.lg` in the third, and only
 * two of the three marked themselves read-only. Leaving the dashboard should
 * look the same every time you do it.
 */
export function PageHeader({
  title,
  icon,
  badge,
  back,
  actions,
  className,
}: {
  title: ReactNode;
  icon?: ReactNode;
  /** e.g. a read-only marker — sits with the title, not with the actions */
  badge?: ReactNode;
  /** the way back to the dashboard, always leftmost */
  back?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-[var(--ds-space-base)] border-b px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
        "border-[color:var(--ds-border)]",
        className,
      )}
    >
      {back}
      <span className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
        {icon && <span className="shrink-0 text-[color:var(--ds-fg-muted)]">{icon}</span>}
        <span className={cn(dsText.section, "truncate font-semibold text-[color:var(--ds-fg)]")}>{title}</span>
        {badge}
      </span>
      {actions && <span className="ml-auto flex shrink-0 items-center gap-[var(--ds-space-tight)]">{actions}</span>}
    </header>
  );
}

/* =========================================================================
 * MetaLine — the provenance line
 * ====================================================================== */

/**
 * "Where this came from", in one line: ids, codes, clocks, actors, hashes.
 *
 * Every surface in this product ends up printing one — `code X · query "Y" · no
 * corpus was scanned`, `receipt R · generated 2:20 PM · attempt 2`, `header row
 * 4 · fingerprint 503172dd`. They were hand-rolled seven different ways, four of
 * them reaching for a raw `font-mono` (which drops the tabular figures that stop
 * a clock from jittering) instead of `dsText.nums`. One component, one treatment.
 *
 * Segments are joined with the product's ` · ` separator so no call site has to
 * remember it, and `undefined`/`null`/`false` segments drop out — a conditional
 * fact never leaves a dangling dot behind.
 */
export function MetaLine({
  items,
  tone = "muted",
  className,
}: {
  items: ReactNode[];
  /** `faint` for a footer's standing note; `muted` for a fact about this run */
  tone?: "muted" | "faint";
  className?: string;
}) {
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false);
  if (shown.length === 0) return null;
  return (
    <span
      className={cn(
        dsText.meta,
        dsText.nums,
        tone === "faint" ? "text-[color:var(--ds-fg-faint)]" : "text-[color:var(--ds-fg-muted)]",
        className,
      )}
    >
      {shown.map((item, index) => (
        <span key={index}>
          {index > 0 && <span aria-hidden> · </span>}
          {item}
        </span>
      ))}
    </span>
  );
}

/* =========================================================================
 * ChipRow — a wrapping row of facts that ends on ONE edge
 * ====================================================================== */

/**
 * A row of chips that WRAPS without going ragged.
 *
 * `flex-wrap` on a set of chips of unequal width leaves each line ending
 * wherever its last chip happened to stop, and the commonest result is one
 * orphan on line two: `wage $18.50/hr` `effective 07/01` `dept 000482` above a
 * lone `txn TXN-0891245`. Four facts then read as three-plus-one instead of as
 * one block of four.
 *
 * A GRID track fixes it at the root: every chip occupies one cell of the same
 * width, so every line ends on the same edge and the wrap is a second row of a
 * table rather than an overflow. `auto-fit` means the track count is whatever
 * the container can hold, so the same row is two columns in a 400px queue and
 * four in a full-width panel with no breakpoint anywhere.
 *
 * Use it for a set of PEER facts. A row that mixes a chip with a sentence or a
 * button is not this — it is a flex row, and the chip is one item in it.
 */
export function ChipRow({
  children,
  /** the widest a single cell may be — defaults to `--ds-w-chip-cell` */
  cell,
  className,
}: {
  children: ReactNode;
  cell?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("grid min-w-0 items-center gap-[var(--ds-space-tight)]", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${cell ?? "var(--ds-w-chip-cell)"}, 1fr))` }}
    >
      {children}
    </div>
  );
}

/* =========================================================================
 * Refusal — the server said no
 * ====================================================================== */

/**
 * A REFUSAL, which is not the same thing as a failure.
 *
 * A failure is the product breaking; a refusal is the product declining, on
 * purpose, with a rule behind it — a stale contract, an unresolved parked write,
 * a fence that has not cleared. This surface exists in seven places (enqueue
 * rejected, an intake block, a park-resolve fence miss, a search lookup that
 * could not run, a setting the environment owns, a bump that would bury a live
 * run, a notification backfill gap) and was drawn seven different ways.
 *
 * Two things it always does, because they are the whole point:
 *
 *  - **It carries the CODE**, in the standard `MetaLine` position. A refusal the
 *    operator cannot quote is a refusal they cannot get help with.
 *  - **It says what was NOT done.** Pass `outcome` — "nothing was recorded",
 *    "nothing is enqueued". `role="alert"` comes from `Banner`'s danger tone.
 *
 * `ShieldAlert` is deliberately not `TriangleAlert`: the triangle means
 * something broke, the shield means something was refused. Two different
 * questions, two different icons.
 */
export function Refusal({
  title,
  code,
  outcome,
  meta = [],
  action,
  className,
  children,
}: {
  title: ReactNode;
  /** the machine-readable refusal code — required; a refusal without one is a shrug */
  code: string;
  /** what was NOT done, in the product's own words */
  outcome?: ReactNode;
  /** extra provenance segments beside the code */
  meta?: ReactNode[];
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Banner
      tone="danger"
      title={title}
      icon={<ShieldAlert aria-hidden className={dsIcon.lg} />}
      action={action}
      className={className}
    >
      <span className="flex flex-col gap-[var(--ds-space-tight)]">
        {children && <span>{children}</span>}
        <MetaLine items={[`code ${code}`, ...meta, outcome]} />
      </span>
    </Banner>
  );
}

/* =========================================================================
 * BulletList
 * ====================================================================== */

/**
 * A short list of facts. Five surfaces were rendering these as a column of
 * `<p>· {item}</p>` — a literal middle-dot character, which a screen reader
 * reads aloud and which gives the reader no list semantics at all. Same look,
 * real `<ul>`, the marker drawn rather than spoken.
 */
export function BulletList({
  items,
  tone = "secondary",
  className,
}: {
  items: ReactNode[];
  tone?: "secondary" | "muted";
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className={cn("flex min-w-0 flex-col gap-[var(--ds-space-hair)]", className)}>
      {items.map((item, index) => (
        <li
          key={index}
          className={cn(
            dsText.body,
            "flex min-w-0 gap-[var(--ds-space-snug)]",
            tone === "muted"
              ? "text-[color:var(--ds-fg-muted)]"
              : "text-[color:var(--ds-fg-secondary)]",
          )}
        >
          <span aria-hidden className="select-none text-[color:var(--ds-fg-faint)]">
            ·
          </span>
          <span className="min-w-0 flex-1">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* =========================================================================
 * EmptyState
 * ====================================================================== */

/**
 * Empty is a STATE, not a blank. Say what would be here, why it is not, and
 * what to do — in that order. No illustrations, no jokes.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-[var(--ds-space-base)] p-[var(--ds-space-section)] text-center",
        className,
      )}
    >
      {icon && <span className="text-[color:var(--ds-fg-faint)]">{icon}</span>}
      <span className={cn(dsText.ui, "font-medium text-[color:var(--ds-fg-secondary)]")}>{title}</span>
      {description && (
        <span className={cn(dsText.body, "max-w-[46ch] text-[color:var(--ds-fg-muted)]")}>
          {description}
        </span>
      )}
      {action && <span className="mt-[var(--ds-space-tight)]">{action}</span>}
    </div>
  );
}

/* =========================================================================
 * Tabs — roving tabindex, arrow keys, Home/End, correct ARIA wiring
 * ====================================================================== */

interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error(`<${component}> must be rendered inside <Tabs>`);
  return ctx;
}

/**
 * ```tsx
 * <Tabs value={tab} onValueChange={setTab}>
 *   <TabList label="Run detail">
 *     <Tab value="log">Log</Tab>
 *     <Tab value="data" count={12}>Data</Tab>
 *   </TabList>
 *   <TabPanel value="log">…</TabPanel>
 * </Tabs>
 * ```
 * Arrow keys move between tabs, Home/End jump to the ends, and only the
 * active tab is in the tab order — the WAI-ARIA "manual activation" pattern
 * with automatic selection on arrow, which is what a keyboard-first operator
 * expects.
 */
export function Tabs({
  value,
  onValueChange,
  className,
  children,
}: {
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value, setValue: onValueChange, baseId }}>
      <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabList({
  label,
  className,
  children,
}: {
  /** accessible name for the tab set */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const list = listRef.current;
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'));
    if (tabs.length === 0) return;
    const current = tabs.findIndex((t) => t === document.activeElement);
    let next: number;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else next = tabs.length - 1;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  }, []);

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        "flex shrink-0 items-center gap-[var(--ds-space-tight)] border-b",
        "border-[color:var(--ds-border)] px-[var(--ds-space-base)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Tab({
  value,
  count,
  icon,
  disabled,
  className,
  children,
}: {
  value: string;
  /** a count beside the label — omit rather than render 0 */
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { value: active, setValue, baseId } = useTabsContext("Tab");
  const selected = active === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-controls={`${baseId}-panel-${value}`}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={() => setValue(value)}
      className={cn(
        "relative inline-flex cursor-pointer items-center gap-[var(--ds-space-snug)]",
        "h-[var(--ds-h-bar)] px-[var(--ds-space-base)]",
        dsText.ui,
        dsFocus,
        dsMotion.fast,
        "active:translate-y-px",
        "border-b-2 border-transparent -mb-px",
        selected
          ? "border-b-[color:var(--ds-accent)] font-semibold text-[color:var(--ds-fg)]"
          : "text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
    >
      {icon}
      {children}
      {typeof count === "number" && count > 0 && (
        <span className={cn(dsText.nums, dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{count}</span>
      )}
    </button>
  );
}

export function TabPanel({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const { value: active, baseId } = useTabsContext("TabPanel");
  if (active !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      tabIndex={0}
      className={cn("min-h-0 flex-1 overflow-y-auto", dsFocus, className)}
    >
      {children}
    </div>
  );
}

/* =========================================================================
 * Well — an inset region inside a Card (raw output, a preview, a diff)
 * ====================================================================== */

export function Well({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "min-w-0 border bg-[var(--ds-surface-2)] p-[var(--ds-space-base)]",
        "border-[color:var(--ds-border-subtle)]",
        dsRadius.md,
        dsText.body,
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A floating surface: menus and popovers built outside the Dialog primitive.
 *
 * It forwards its ref and spreads the rest of its props so a positioning
 * primitive (Radix `Popover.Content`, a menu, an anchored panel) can adopt it
 * with `asChild` instead of re-drawing the same four tokens locally.
 */
export const FloatingSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FloatingSurface({ className, children, ...rest }, ref) {
    return (
      <div
        ref={ref}
        {...rest}
        className={cn(
          "border bg-[var(--ds-surface-overlay)]",
          "border-[color:var(--ds-border-strong)]",
          dsRadius.md,
          dsElev.mid,
          className,
        )}
      >
        {children}
      </div>
    );
  },
);
