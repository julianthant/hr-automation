import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CircleAlert, Info, TriangleAlert, CheckCircle2 } from "lucide-react";
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
          "border-l-[length:var(--ds-border-w-rail)] border-l-[color:var(--ds-status-waiting-fg)]",
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

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]", className)}>{children}</div>;
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
        dsMotion.base,
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

/** A floating surface: menus and popovers built outside the Dialog primitive. */
export function FloatingSurface({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
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
}
