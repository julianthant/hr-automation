import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type SVGProps } from "react";
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Eye,
  Gauge,
  Hourglass,
  LayoutDashboard,
  Minus,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  PictureInPicture2,
  Plus,
  RotateCw,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { effectiveStatus, fmtElapsed, type DemoRow } from "./demo-data";
import { DEMO_WORKFLOW_LIST, DEMO_WORKFLOWS, type DemoWorkflowCategory } from "./demo-wire";
import { DEMO_DAY, topLevelRowsForDay } from "./demo-days";
import {
  DemoDateNav,
  DemoNotificationBell,
  DemoSearchControl,
  DemoShortcutsPopover,
  type DemoNavigateTo,
} from "./DemoTopBarSurfaces";
import { PROPOSED_STATUS, type ProposedStatus } from "./demo-status";
import { toolbarControl } from "./DemoBulkBar";
import {
  Badge,
  Button,
  CountBadge,
  DEMO_THEME_LABEL,
  DS_STATUS,
  IconButton,
  type DemoTheme,
  dsBorder,
  dsElev,
  dsFocus,
  dsIcon,
  dsLayer,
  dsMotion,
  dsRadius,
  dsSize,
  dsSurface,
  dsText,
} from "./demo-ui";

/**
 * DEV-ONLY — the replica shell around the rebuild demo.
 *
 * The queue and log panel were already faithful; everything AROUND them was
 * missing, so the demo could not be used to plan the real dashboard. This file
 * adds the other four named surfaces — Top Bar, Workflow Panel, Status Bar and
 * Session Panel — at production fidelity.
 *
 * One rule is load-bearing here and is the fix for the legacy "badges always
 * error out" bug: the Workflow Panel badges, the Status Bar pills and the
 * Queue Panel rows all read from `countRows` below. There is exactly ONE
 * counting path, so two surfaces can never disagree.
 */

const NOOP = () => {};

// ---------------------------------------------------------------------------
// One counting path — the whole point
// ---------------------------------------------------------------------------

/**
 * `all` + a composite `Needs you` + the eight ratified statuses. Every status is
 * reachable; none is folded away.
 *
 * The old bar had SEVEN buckets and counted some rows twice — a
 * Done-with-warnings row landed in both `attention` and `done`, so the pills
 * summed to more than the queue held. Here each row lands in exactly one status
 * bucket, and `needsYou` is the only deliberate overlap (it is a composite of
 * two of them, labelled as such).
 */
export type StatusBucket = "all" | "needsYou" | ProposedStatus;

/**
 * The panel the app opens on. There is no "All workflows" entry: an operator
 * works one workflow at a time, the cross-panel view was a fifteenth rail row
 * that no triage pass ever used, and a queue mixing fourteen workflows made
 * every row's title carry a workflow label to stay legible. Read from the
 * registry rather than typed as a string, so renaming a workflow cannot leave
 * the app opening on a panel that does not exist.
 */
export const DEFAULT_WORKFLOW = DEMO_WORKFLOWS["oath-signature"].label;

/**
 * Every top-level row ON A DAY (members belong to their group, never to the
 * counts). The day is a parameter rather than a constant because the queue is
 * day-partitioned: moving the date must move the corpus every surface counts,
 * or the badges and the rows start disagreeing again.
 */
export function topLevelRows(day: string = DEMO_DAY): DemoRow[] {
  return topLevelRowsForDay(day);
}

export function rowsForWorkflow(rows: DemoRow[], workflow: string): DemoRow[] {
  return rows.filter((r) => r.wfLabel === workflow);
}

export function rowInBucket(row: DemoRow, bucket: StatusBucket): boolean {
  if (bucket === "all") return true;
  const s = effectiveStatus(row);
  if (bucket === "needsYou") return s === "waiting" || s === "parked";
  return s === bucket;
}

export function countRows(rows: DemoRow[]): Record<StatusBucket, number> {
  const out: Record<StatusBucket, number> = {
    all: 0,
    needsYou: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    parked: 0,
    verifiedDone: 0,
    doneWarnings: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const r of rows) {
    const s = effectiveStatus(r);
    out.all += 1;
    out[s] += 1;
    if (s === "waiting" || s === "parked") out.needsYou += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top Bar
// ---------------------------------------------------------------------------

/**
 * The demo's top-level views. The first three are the switcher in the Top Bar
 * (the app, the specimen catalog, the kit); the rest are FULL-PAGE TAKEOVERS
 * reached from the gear — Settings, and the three pages Settings launches into.
 * A seven-entry segmented control in a 44px bar would be unreadable, and these
 * four are not places the operator toggles between while triaging.
 */
export type DemoShellView = "queue" | "catalog" | "kit" | "settings" | "archive" | "explorer" | "report";

const SWITCHER_VIEWS = ["queue", "catalog", "kit"] as const;

const SHELL_VIEW_LABEL: Record<(typeof SWITCHER_VIEWS)[number], string> = {
  queue: "Dashboard",
  catalog: "Row & panel catalog",
  kit: "Design system",
};

export function DemoTopBar({
  view,
  onView,
  day,
  onDay,
  onNavigate,
  tick,
  theme,
  onToggleTheme,
}: {
  view: DemoShellView;
  onView: (v: DemoShellView) => void;
  /** the day partition the whole app is reading */
  day: string;
  onDay: (day: string) => void;
  /** jump to a row from search or a notification link — panel + row + its day */
  onNavigate: DemoNavigateTo;
  tick: number;
  /** the demo's theme pair — see `ds/theme.ts` */
  theme: DemoTheme;
  onToggleTheme: () => void;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center border-b",
        dsSize.hTopbar,
        dsBorder.base,
        dsSurface.card,
        "gap-[var(--ds-space-cozy)] px-[var(--ds-space-cozy)]",
      )}
    >
      <span className="flex shrink-0 items-center gap-[var(--ds-space-base)]">
        <span
          aria-hidden
          className={cn("flex items-center justify-center", dsRadius.md, "size-[var(--ds-h-sm)] bg-[var(--ds-accent-quiet)]")}
        >
          <ShieldCheck className={cn(dsIcon.md, "text-[color:var(--ds-accent-mark)]")} />
        </span>
        <span className={cn(dsText.ui, "font-semibold text-[color:var(--ds-fg)]")}>HR Automation</span>
      </span>
      {/* A standing environment marker, not news. It has to be unmissable when
          you look at it and invisible when you are not — the loud tier belongs
          to `Waiting on you` and `Failed`, and nothing else may take it. */}
      <Badge tone="infoOutline" className={cn(dsRadius.pill, dsText.caps, "shrink-0")}>
        rebuild demo · synthetic data
      </Badge>

      <div
        className={cn(
          "inline-flex shrink-0 border p-[var(--ds-space-hair)]",
          dsRadius.md,
          dsBorder.base,
          "bg-[var(--ds-surface-2)]",
        )}
      >
        {SWITCHER_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={cn(
              "inline-flex cursor-pointer items-center px-[var(--ds-space-base)]",
              "h-[var(--ds-h-sm)]",
              dsRadius.sm,
              dsText.meta,
              dsFocus,
              dsMotion.fast,
              view === v
                ? "bg-[var(--ds-surface-3)] font-semibold text-[color:var(--ds-fg)]"
                : "font-medium text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
            )}
          >
            {SHELL_VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {/* Search, the date navigator and the bell are real surfaces — see
          `DemoTopBarSurfaces`. The date here IS the day the queue reads. */}
      <DemoSearchControl onNavigate={onNavigate} />

      <DemoDateNav day={day} onDay={onDay} />

      <span className="flex shrink-0 items-center gap-[var(--ds-space-hair)]">
        <DemoNotificationBell onNavigate={onNavigate} tick={tick} />
        {/* The keyboard legend lives HERE now, behind the control that used to
            do nothing — it was a permanent 36px strip across the top of the
            queue, which is a row the panels wanted more than the legend did. */}
        <DemoShortcutsPopover />
        {/* The theme pair. One control, and its LABEL names the destination
            ("Switch to Paper Ink"), because a lone sun/moon glyph never says
            which of the two states it is reporting. */}
        <IconButton
          size="sm"
          label={`Switch to ${DEMO_THEME_LABEL[theme === "dark" ? "light" : "dark"]}`}
          onClick={onToggleTheme}
          icon={
            theme === "dark" ? (
              <Sun aria-hidden className={dsIcon.md} />
            ) : (
              <Moon aria-hidden className={dsIcon.md} />
            )
          }
        />
        {/* The gear opens the real Settings surface (provenance, System URLs,
            budgets, doctor, storage health, version registry) and is the door
            to the Archive / Explorer / Activity report takeovers. */}
        <IconButton
          size="sm"
          label="Settings"
          aria-pressed={view === "settings"}
          onClick={() => onView("settings")}
          icon={<Settings aria-hidden className={dsIcon.md} />}
          className={cn(view === "settings" && "bg-[var(--ds-surface-3)] text-[color:var(--ds-fg)]")}
        />
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Workflow Panel (left rail)
// ---------------------------------------------------------------------------

/**
 * Per-entry copy the registry cannot carry. The rail ITSELF is not a hand list:
 * it is the workflow registry (`/api/workflow-definitions` in production)
 * grouped by each descriptor's own category, so a workflow the backend serves
 * can never be missing from the rail.
 */
const RAIL_NOTES: Partial<Record<string, string>> = {
  // Deliberately kept at zero. It has no callers today, but it is a real
  // workflow that can be run on its own, and an entry that disappears when idle
  // teaches the operator that the rail is not the whole system.
  "Person Match":
    "No runs today. Kept visible on purpose — a workflow that vanishes when idle is a workflow you stop trusting the rail about.",
};

const RAIL_GROUPS: { label: DemoWorkflowCategory; entries: { label: string; note?: string }[] }[] = (
  ["People", "Documents", "Data"] as DemoWorkflowCategory[]
).map((category) => ({
  label: category,
  entries: DEMO_WORKFLOW_LIST.filter((w) => w.category === category).map((w) => ({ label: w.label, note: RAIL_NOTES[w.label] })),
}));

/** label → the workflow's own 2-char code, the prefix of every one of its trace ids */
const WORKFLOW_CODE: Record<string, string> = Object.fromEntries(DEMO_WORKFLOW_LIST.map((w) => [w.label, w.code]));

/**
 * Where the Workflow Panel is, and how much of the window it costs.
 *
 * `floating` — a window over the panels. It costs no column, so the queue and
 * the detail panel get the full width; it is dismissable, and dismissing it
 * lands on `icon`.
 * `icon` — nothing is drawn over the content at all. The toggle in the action
 * bar is the launcher, and it keeps carrying the `Needs you` count so a
 * collapsed panel can never hide one.
 * `sidebar` — docked, 200px, always visible. For the operator who wants it.
 */
export type WorkflowPanelMode = "floating" | "icon" | "sidebar";

const PANEL_MODE_CYCLE: WorkflowPanelMode[] = ["floating", "icon", "sidebar"];

export const WORKFLOW_PANEL_MODE_LABEL: Record<WorkflowPanelMode, string> = {
  floating: "floating window",
  icon: "icon",
  sidebar: "sidebar",
};

const PANEL_MODE_STORAGE_KEY = "rebuild-demo.workflow-panel";
const WORKFLOW_PANEL_ID = "demo-workflow-panel";
const WORKFLOW_PANEL_TOGGLE_ID = "demo-workflow-panel-toggle";

function readStoredPanelMode(): WorkflowPanelMode {
  if (typeof window === "undefined") return "floating";
  try {
    const stored = window.localStorage.getItem(PANEL_MODE_STORAGE_KEY);
    return PANEL_MODE_CYCLE.find((m) => m === stored) ?? "floating";
  } catch {
    // A blocked localStorage (private mode, storage off) is a real browser
    // state, not a failure to read a mode: it means there is no stored
    // preference, which is the documented default.
    return "floating";
  }
}

/**
 * Owns the mode, its persistence, and one thing more: whether the OPERATOR has
 * moved it this session (`opened`).
 *
 * That flag is what keeps the window honest on first paint. A window that
 * animates in and grabs focus because it was the persisted default is animating
 * on page load and stealing the caret from the queue — both banned. Opened by a
 * press, the same window should do exactly that, because then it did come from
 * somewhere and the operator is looking at it.
 */
export function useWorkflowPanelMode(): {
  mode: WorkflowPanelMode;
  setMode: (mode: WorkflowPanelMode) => void;
  cycleMode: () => void;
  opened: boolean;
} {
  const [mode, setModeState] = useState<WorkflowPanelMode>(readStoredPanelMode);
  const [opened, setOpened] = useState(false);

  const setMode = useCallback((next: WorkflowPanelMode) => {
    setOpened(true);
    setModeState(next);
    try {
      window.localStorage.setItem(PANEL_MODE_STORAGE_KEY, next);
    } catch {
      // Same as above: an unwritable store loses the preference for next time,
      // which is not a reason to refuse the operator this one.
    }
  }, []);

  const cycleMode = useCallback(() => {
    setMode(PANEL_MODE_CYCLE[(PANEL_MODE_CYCLE.indexOf(mode) + 1) % PANEL_MODE_CYCLE.length]);
  }, [mode, setMode]);

  return { mode, setMode, cycleMode, opened };
}

interface PanelModeProps {
  mode: WorkflowPanelMode;
  onMode: (mode: WorkflowPanelMode) => void;
}

/**
 * The panel's own window controls. Every transition is one press from here or
 * from the toggle, and `w` cycles all three from anywhere — a state you can only
 * reach with the mouse is one a keyboard operator does not have.
 */
function WorkflowPanelControls({ mode, onMode }: PanelModeProps) {
  return (
    <span className="flex shrink-0 items-center gap-[var(--ds-space-hair)]">
      {mode === "sidebar" ? (
        <IconButton
          size="sm"
          label="Float the Workflow Panel"
          onClick={() => onMode("floating")}
          icon={<PictureInPicture2 aria-hidden className={dsIcon.md} />}
        />
      ) : (
        <IconButton
          size="sm"
          label="Dock the Workflow Panel as a sidebar"
          onClick={() => onMode("sidebar")}
          icon={<PanelLeft aria-hidden className={dsIcon.md} />}
        />
      )}
      <IconButton
        size="sm"
        label="Minimise the Workflow Panel to an icon"
        onClick={() => onMode("icon")}
        icon={<Minus aria-hidden className={dsIcon.md} />}
      />
    </span>
  );
}

/**
 * The launcher, and the one control present in all three modes.
 *
 * It carries the current workflow's 2-char code — the same code that prefixes
 * every one of its trace ids — so it is never an anonymous glyph, and the
 * day's whole `Needs you` count across EVERY panel, because the number you must
 * not be able to miss is the one in a panel you are not looking at.
 */
export function DemoWorkflowPanelToggle({
  mode,
  onMode,
  active,
  rows,
}: PanelModeProps & {
  active: string;
  /** the day's corpus — every panel's rows, not the active panel's */
  rows: DemoRow[];
}) {
  const needsYou = useMemo(() => countRows(rows).needsYou, [rows]);
  const showing = mode !== "icon";
  const code = WORKFLOW_CODE[active] ?? "";
  return (
    <button
      id={WORKFLOW_PANEL_TOGGLE_ID}
      type="button"
      aria-expanded={showing}
      aria-controls={mode === "floating" ? WORKFLOW_PANEL_ID : undefined}
      aria-label={`Workflow Panel — ${active}${showing ? `, ${WORKFLOW_PANEL_MODE_LABEL[mode]}` : ", minimised"}`}
      title={`Workflow Panel — ${active}\n${needsYou} row${needsYou === 1 ? "" : "s"} waiting on you across every panel\nw cycles floating · icon · sidebar`}
      onClick={() => onMode(showing ? "icon" : "floating")}
      className={cn(
        toolbarControl(),
        showing
          ? cn(dsBorder.loud, "bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]")
          : cn(dsBorder.base, dsSurface.card, "text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]"),
      )}
    >
      {showing ? (
        <PanelLeftClose aria-hidden className={dsIcon.sm} />
      ) : (
        <PanelLeftOpen aria-hidden className={dsIcon.sm} />
      )}
      <span className={dsText.nums}>{code}</span>
      {/* The loudest badge in the system, and the one place it is right: a
          `Waiting on you` count must survive the panel being closed. */}
      <CountBadge value={needsYou} tone="attention" zeroStyle="hide" />
    </button>
  );
}

function WorkflowEntryList({
  active,
  onActive,
  rows,
}: {
  active: string;
  onActive: (label: string) => void;
  /** the day's corpus — the SAME array the Status Bar and the queue read */
  rows: DemoRow[];
}) {
  // Same counting path as the Status Bar and the queue, over the same rows.
  // Not a second tally, and not a second corpus.
  const counts = useMemo(() => {
    const map = new Map<string, { total: number; queued: number }>();
    for (const g of RAIL_GROUPS) {
      for (const e of g.entries) {
        const c = countRows(rowsForWorkflow(rows, e.label));
        map.set(e.label, { total: c.all, queued: c.queued });
      }
    }
    return map;
  }, [rows]);

  /** Every rail entry is the same object; the label IS what it filters by. */
  const entry = (label: string, total: number, queued: number, on: boolean, note?: string) => (
    <button
      type="button"
      aria-current={on ? "page" : undefined}
      title={note}
      onClick={() => onActive(label)}
      className={cn(
        "group flex w-full cursor-pointer items-stretch text-left",
        "gap-[var(--ds-space-base)] pl-[var(--ds-space-tight)] pr-[var(--ds-space-base)]",
        dsSize.hRow,
        dsRadius.md,
        dsFocus,
        dsMotion.base,
        on ? "bg-[var(--ds-surface-selected)]" : "hover:bg-[var(--ds-surface-3)]",
      )}
    >
      {/* The 3px marker is the non-colour cue for "this is the panel you are
          in" — the fill alone is too quiet at this density. */}
      <span
        aria-hidden
        className={cn(
          "my-[var(--ds-space-snug)] w-[var(--ds-border-w-rail)] rounded-r-full",
          dsMotion.base,
          on ? "bg-[var(--ds-accent)]" : "bg-transparent group-hover:bg-[var(--ds-border-loud)]",
        )}
      />
      <span className="flex min-w-0 flex-1 items-center">
        <span
          className={cn(
            dsText.ui,
            "truncate",
            on ? "font-semibold text-[color:var(--ds-fg)]" : "font-medium text-[color:var(--ds-fg-secondary)]",
          )}
        >
          {label}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-[var(--ds-space-tight)]">
        {/* Queued wears its own hue here too — outline slate, never amber.
            Nothing has happened to these rows yet; they are not a warning. */}
        {queued > 0 && (
          <span
            title={`${queued} queued`}
            className={cn(
              "inline-flex items-center border px-[var(--ds-space-tight)]",
              "h-[var(--ds-h-xs)]",
              dsRadius.sm,
              dsText.micro,
              dsText.nums,
              "border-[color:var(--ds-status-queued-border)] text-[color:var(--ds-status-queued-fg)]",
            )}
          >
            {queued}
          </span>
        )}
        {/* A count that hits zero DIMS, it does not disappear — the eye must
            not have to re-scan the rail to find out a panel is idle. */}
        <span
          className={cn(
            dsText.meta,
            dsText.nums,
            "flex items-center justify-end",
            total === 0
              ? "text-[color:var(--ds-fg-faint)]"
              : on
                ? "font-semibold text-[color:var(--ds-fg)]"
                : "text-[color:var(--ds-fg-secondary)]",
          )}
        >
          {total}
        </span>
      </span>
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-[var(--ds-space-cozy)]">
      {RAIL_GROUPS.map((g) => (
        <div key={g.label} className="pb-[var(--ds-space-cozy)]">
          {/* More air above a group heading than below it — the label belongs to
              the list under it, not to the one it just left. */}
          <div className={cn(dsText.caps, "px-[var(--ds-space-cozy)] pb-[var(--ds-space-snug)] text-[color:var(--ds-fg-muted)]")}>
            {g.label}
          </div>
          <ul className="flex flex-col gap-px px-[var(--ds-space-snug)]">
            {g.entries.map((e) => {
              const c = counts.get(e.label);
              // Rows are deliberately icon-free — the workflow icons live on
              // Session Cards and the add-worker picker, not here.
              return <li key={e.label}>{entry(e.label, c?.total ?? 0, c?.queued ?? 0, active === e.label, e.note)}</li>;
            })}
          </ul>
        </div>
      ))}

      <p
        className={cn(
          dsText.micro,
          "mt-auto px-[var(--ds-space-loose)] pt-[var(--ds-space-cozy)] leading-relaxed text-[color:var(--ds-fg-muted)]",
        )}
      >
        Badges, Status Bar pills and the queue all go through one counting path — they cannot disagree.
      </p>
    </div>
  );
}

/** The header both presentations share: the surface's name, then its controls. */
function WorkflowPanelHeader({ mode, onMode }: PanelModeProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center border-b",
        dsSize.hBar,
        dsBorder.subtle,
        "gap-[var(--ds-space-base)] pl-[var(--ds-space-cozy)] pr-[var(--ds-space-snug)]",
      )}
    >
      <span className={cn(dsText.caps, "min-w-0 flex-1 truncate text-[color:var(--ds-fg-muted)]")}>Workflow Panel</span>
      <WorkflowPanelControls mode={mode} onMode={onMode} />
    </div>
  );
}

interface WorkflowPanelProps extends PanelModeProps {
  active: string;
  onActive: (label: string) => void;
  rows: DemoRow[];
}

/** `sidebar` — docked, consuming a 200px column, exactly as it always did. */
export function DemoWorkflowSidebar({ mode, onMode, active, onActive, rows }: WorkflowPanelProps) {
  return (
    <nav
      aria-label="Workflow Panel"
      className={cn("flex min-h-0 shrink-0 flex-col border-r", dsSize.wRail, dsBorder.base, dsSurface.card)}
    >
      <WorkflowPanelHeader mode={mode} onMode={onMode} />
      <WorkflowEntryList active={active} onActive={onActive} rows={rows} />
    </nav>
  );
}

/**
 * `floating` — the same panel as a window over the panel region.
 *
 * It is deliberately NOT built on `Popover`/`Dialog`. Both of those register
 * modal presence, which makes the toast viewport step aside and go inert for as
 * long as they are mounted, and this is the DEFAULT state — a demo that boots
 * with its toasts permanently inert would be reporting a bug, not a design. So
 * it composes the sanctioned floating tokens directly and owns the three things
 * Radix would have given it: Escape, outside-click, and focus.
 *
 * Focus is scoped, not seized. Tab cycles inside the window once the caret is
 * in it and Escape leaves — but the window never pulls focus off the queue just
 * because it happens to be the persisted mode on a fresh load.
 */
export function DemoWorkflowWindow({
  mode,
  onMode,
  active,
  onActive,
  rows,
  /** did the operator open this, or is it simply how the app booted? */
  opened,
}: WorkflowPanelProps & { opened: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(!opened);

  // It arrives from the toggle above it — so it is allowed to be animated, and
  // only when it actually arrived rather than was already there.
  useEffect(() => {
    if (entered) return;
    const id = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(id);
  }, [entered]);

  // Opened by a press: put the caret on the panel you are in, so the keyboard
  // route into the list is one press and not fourteen tabs.
  useEffect(() => {
    if (!opened) return;
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, [opened]);

  // Clicking anywhere else dismisses it. Capture phase, so the click that
  // dismisses the window still reaches the row it landed on — you never lose a
  // press to a panel you were finished with.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      const target = e.target as Node | null;
      if (!el || !target) return;
      if (el.contains(target)) return;
      // The toggle owns its own press; letting this fire too would minimise and
      // re-open in one click.
      if (document.getElementById(WORKFLOW_PANEL_TOGGLE_ID)?.contains(target)) return;
      onMode("icon");
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onMode]);

  /**
   * Hand focus back to the launcher — but ONLY when it was inside the window.
   * Stealing it from whatever the operator just clicked would be worse than not
   * returning it at all, which is why the outside-click path above does not
   * route through here.
   *
   * It runs BEFORE the state change, not in an unmount cleanup: a passive
   * cleanup fires after React has already detached the node, by which point the
   * caret is on `<body>` and there is nothing left to ask.
   */
  const leave = useCallback(
    (next: WorkflowPanelMode) => {
      if (ref.current?.contains(document.activeElement)) {
        document.getElementById(WORKFLOW_PANEL_TOGGLE_ID)?.focus();
      }
      onMode(next);
    },
    [onMode],
  );

  return (
    <div
      ref={ref}
      id={WORKFLOW_PANEL_ID}
      role="dialog"
      aria-label="Workflow Panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          leave("icon");
          return;
        }
        if (e.key !== "Tab") return;
        const focusable = Array.from(
          ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
        );
        if (focusable.length === 0) return;
        const edge = e.shiftKey ? focusable[0] : focusable[focusable.length - 1];
        if (document.activeElement !== edge) return;
        e.preventDefault();
        (e.shiftKey ? focusable[focusable.length - 1] : focusable[0]).focus();
      }}
      className={cn(
        "absolute left-[var(--ds-space-cozy)] flex flex-col overflow-hidden border",
        "inset-y-[var(--ds-space-cozy)]",
        dsSize.wRail,
        dsLayer.menu,
        dsRadius.lg,
        dsElev.high,
        dsMotion.enter,
        "origin-top-left border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)]",
        entered ? "translate-y-0 scale-100 opacity-100" : "-translate-y-1 scale-[0.985] opacity-0",
      )}
    >
      <WorkflowPanelHeader mode={mode} onMode={leave} />
      <WorkflowEntryList active={active} onActive={onActive} rows={rows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status Bar (count pills)
// ---------------------------------------------------------------------------

/**
 * One row: `All`, the composite `Needs you`, then every one of the eight
 * statuses. Nothing is hidden behind an overflow menu — a status you cannot
 * click is a status you cannot triage — and nothing is counted twice.
 */
const STATUS_PILL_ORDER: ProposedStatus[] = [
  "queued",
  "running",
  "waiting",
  "parked",
  "verifiedDone",
  "doneWarnings",
  "failed",
  "cancelled",
];

/**
 * The pill's icon tone. Read from the ONE status table rather than restated
 * here — this map used to say `queued: amber`, `cancelled: amber` and
 * `running: primary`, which put four of the eight pills in the same amber and
 * disagreed with the chip on the row each pill filters to.
 */
const statusPillTone = (s: ProposedStatus): string => DS_STATUS[s].soloTone;

export function DemoStatusBar({
  counts,
  active,
  onSelect,
}: {
  counts: Record<StatusBucket, number>;
  active: StatusBucket;
  onSelect: (b: StatusBucket) => void;
}) {
  const pill = (
    key: StatusBucket,
    label: string,
    Icon: ComponentType<SVGProps<SVGSVGElement>>,
    tone: string,
    title?: string,
    spin?: boolean,
  ) => {
    const on = active === key;
    const n = counts[key];
    return (
      <button
        key={key}
        type="button"
        aria-pressed={on}
        title={title}
        onClick={() => onSelect(on ? "all" : key)}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center border",
          "h-[var(--ds-h-sm)] gap-[var(--ds-space-snug)] px-[var(--ds-space-base)]",
          dsRadius.md,
          dsText.meta,
          dsFocus,
          dsMotion.fast,
          on
            ? cn(dsBorder.loud, "bg-[var(--ds-surface-selected)] font-semibold text-[color:var(--ds-fg)]")
            : cn(dsBorder.base, dsSurface.card, "text-[color:var(--ds-fg-muted)] hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]"),
          // A zero DIMS, it never disappears: a status you cannot see is a
          // status you cannot rule out.
          n === 0 && !on && "opacity-45",
        )}
      >
        <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0", tone, spin && n > 0 && "animate-spin motion-reduce:animate-none")} />
        {label}
        <span className={dsText.nums}>{n}</span>
      </button>
    );
  };

  return (
    // The pills never collapse into an overflow menu — a status you cannot
    // click is a status you cannot triage — so at a narrow window the row
    // scrolls. The right edge fades into the page so a clipped pill reads as
    // "there is more", not as a pill that happens to end there. Over empty
    // space the fade is the page colour and therefore invisible.
    <div className="relative shrink-0">
      <div
        role="group"
        aria-label="Status Bar"
        className={cn(
          "flex items-center overflow-x-auto border-b",
          dsSize.hBar,
          dsBorder.subtle,
          "gap-[var(--ds-space-tight)] px-[var(--ds-space-base)]",
        )}
      >
        {pill("all", "All", LayoutDashboard, "text-[color:var(--ds-fg-muted)]", "Every row in this view")}
        {pill(
          "needsYou",
          "Needs you",
          Eye,
          "text-[color:var(--ds-status-waiting-fg)]",
          "Waiting on you + Write parked — the two states that are stuck on a decision from you",
        )}
        {/* The two composites, then the eight. The rule is on the left of the
            statuses because it separates two KINDS of pill, not two statuses. */}
        <span aria-hidden className={cn("mx-[var(--ds-space-hair)] h-4 w-px shrink-0", "bg-[var(--ds-border)]")} />
        {STATUS_PILL_ORDER.map((s) =>
          pill(s, PROPOSED_STATUS[s].label, PROPOSED_STATUS[s].icon, statusPillTone(s), PROPOSED_STATUS[s].meaning, s === "running"),
        )}
      </div>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-[var(--ds-space-section)] bg-gradient-to-l from-[var(--ds-surface-page)] to-transparent"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Panel (bottom drawer)
// ---------------------------------------------------------------------------

/** `unknown` = never probed. It must NOT read as healthy — that is a live bug today. */
type BrowserHealth = "healthy" | "refreshing" | "unhealthy" | "failed" | "paused" | "unknown";
type SessionPhase = "authenticating" | "running" | "idle" | "keepalive" | "complete" | "failed";

interface DemoBrowser {
  id: string;
  label: string;
  health: BrowserHealth;
  url: string;
}

/**
 * One system's lease budget as this executor sees it (doc 05's BudgetSnapshot).
 * `cap` is a property of the SYSTEM — UCPath invalidates the older session when
 * a second one authenticates, so its cap of 1 is not a tuning choice.
 */
interface DemoBudgetSlot {
  system: string;
  inUse: number;
  cap: number;
}

/**
 * Why this executor is not progressing. This is the single most valuable thing
 * the Session Panel can say: a card that shows a healthy browser and a spinning
 * status while six items sit queued teaches the operator that the panel is
 * decorative. Naming the lease AND its holder turns "nothing is happening" into
 * "Separations has the one UCPath session, and it has had it for 18 minutes".
 */
interface DemoLeaseWait {
  system: string;
  sinceSec: number;
  heldByWorkflow: string;
  heldByTrace: string;
}

interface DemoSession {
  id: string;
  workflow: string;
  phase: SessionPhase;
  /** shown only while an item is in flight — a retained trace id on an idle card reads as stale */
  traceId?: string;
  step?: string;
  subline: string;
  elapsedSec: number;
  browsers: DemoBrowser[];
  /** items waiting in the shared queue for this workflow */
  queued?: number;
  /** micro pipeline — one dot per step of the item in flight */
  steps?: { label: string; state: "done" | "current" | "pending" }[];
  crashed?: boolean;
  /** items this executor may hold in flight at once */
  lanes?: { inUse: number; cap: number };
  /** the system leases it holds, and what each system allows */
  budgets?: DemoBudgetSlot[];
  /** present when the executor is alive and NOT progressing */
  waiting?: DemoLeaseWait;
  /** a deliberate pause between tasks — a rate guard, not idleness */
  sleepPerTaskSec?: number;
}

const DEMO_SESSIONS: DemoSession[] = [
  {
    id: "s-sep",
    workflow: "Separations",
    phase: "running",
    traceId: "se-140211-9f3a",
    step: "UCPath transaction",
    subline: "se-140211-9f3a",
    elapsedSec: 1112,
    queued: 2,
    steps: [
      { label: "Kuali extraction", state: "done" },
      { label: "Identity check", state: "done" },
      { label: "Job summary", state: "done" },
      { label: "Kronos search", state: "done" },
      { label: "UCPath transaction", state: "current" },
      { label: "Kuali finalization", state: "pending" },
    ],
    lanes: { inUse: 1, cap: 1 },
    budgets: [
      { system: "ucpath", inUse: 1, cap: 1 },
      { system: "kuali", inUse: 1, cap: 2 },
      { system: "kronos", inUse: 1, cap: 2 },
    ],
    browsers: [
      { id: "b1", label: "kuali", health: "healthy", url: "kuali.ucsd.edu/space/HR" },
      { id: "b2", label: "ucpath", health: "healthy", url: "ucpath.universityofcalifornia.edu" },
      { id: "b3", label: "kronos", health: "refreshing", url: "kronos.ucsd.edu/timekeeping" },
    ],
  },
  {
    // The card the whole upgrade exists for. Alive, healthy, "running", six
    // items queued — and not moving, because Separations holds the one UCPath
    // session. Without the waiting note this card is a lie told with a spinner.
    id: "s-i9",
    workflow: "I-9 Check",
    phase: "running",
    traceId: "ic-134001-m31",
    step: "Person lookup",
    subline: "ic-134001-m31",
    elapsedSec: 2410,
    queued: 6,
    steps: [
      { label: "Person match", state: "done" },
      { label: "Person lookup", state: "current" },
      { label: "Roster match", state: "pending" },
    ],
    lanes: { inUse: 1, cap: 2 },
    budgets: [
      { system: "ucpath", inUse: 0, cap: 1 },
      { system: "i9", inUse: 1, cap: 1 },
    ],
    waiting: { system: "ucpath", sinceSec: 264, heldByWorkflow: "Separations", heldByTrace: "se-140211-9f3a" },
    sleepPerTaskSec: 12,
    browsers: [{ id: "b4", label: "ucpath", health: "unknown", url: "ucpath…/PersonSearch" }],
  },
  {
    id: "s-ocr",
    workflow: "OCR",
    phase: "idle",
    subline: "idle — waiting for work",
    elapsedSec: 384,
    lanes: { inUse: 0, cap: 3 },
    budgets: [{ system: "i9", inUse: 0, cap: 1 }],
    browsers: [{ id: "b5", label: "i9", health: "healthy", url: "i9.ucsd.edu" }],
  },
  {
    id: "s-oath",
    workflow: "Oath Signature",
    phase: "authenticating",
    subline: "Authenticating 1/2",
    elapsedSec: 41,
    lanes: { inUse: 1, cap: 2 },
    budgets: [
      { system: "crm", inUse: 1, cap: 2 },
      { system: "ucpath", inUse: 0, cap: 1 },
    ],
    browsers: [
      { id: "b6", label: "crm", health: "unhealthy", url: "stuck on the SSO login page" },
      { id: "b7", label: "ucpath", health: "paused", url: "auto-recovery paused by you" },
    ],
  },
  {
    id: "s-crm",
    workflow: "CRM Doc Download",
    phase: "failed",
    subline: "Check the queue row for details",
    elapsedSec: 0,
    crashed: true,
    browsers: [{ id: "b8", label: "crm", health: "failed", url: "about:blank" }],
  },
];

/**
 * A worker's phase. Same hue ramp as everything else in the demo, so "this
 * daemon is alive" and "this row is running" are not two unrelated blues.
 */
const PHASE_TONE: Record<SessionPhase, { dot: string; label: string; text: string }> = {
  running: { dot: "bg-[var(--ds-success-fg)]", label: "Running", text: "text-[color:var(--ds-success-fg)]" },
  authenticating: {
    dot: "bg-[var(--ds-status-waiting-fg)] animate-pulse motion-reduce:animate-none",
    label: "Authenticating",
    text: "text-[color:var(--ds-status-waiting-fg)]",
  },
  idle: { dot: "bg-[var(--ds-fg-faint)]", label: "Idle", text: "text-[color:var(--ds-fg-muted)]" },
  keepalive: { dot: "bg-[var(--ds-info-fg)]", label: "Keep-alive", text: "text-[color:var(--ds-info-fg)]" },
  complete: { dot: "bg-[var(--ds-success-fg)] opacity-60", label: "Complete", text: "text-[color:var(--ds-fg-muted)]" },
  failed: { dot: "bg-[var(--ds-danger)]", label: "Failed", text: "text-[color:var(--ds-danger)]" },
};

/**
 * A browser's health. `unknown` is deliberately NOT styled like `healthy` — a
 * session that was never probed must not read as one that passed. It is the
 * only tile with no fill at all, which is the same "nothing has happened yet"
 * cue the Queued status uses.
 */
const HEALTH_TONE: Record<BrowserHealth, { cls: string; icon: typeof Activity; label: string }> = {
  healthy: {
    cls: "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
    icon: CheckCircle2,
    label: "Ready",
  },
  unknown: {
    cls: "border-[color:var(--ds-border-subtle)] bg-transparent text-[color:var(--ds-fg-faint)]",
    icon: CircleHelp,
    label: "Not checked",
  },
  refreshing: {
    cls: "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)] text-[color:var(--ds-info-fg)]",
    icon: RotateCw,
    label: "Refreshing",
  },
  unhealthy: {
    cls: "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]",
    icon: AlertTriangle,
    label: "Unhealthy",
  },
  failed: {
    cls: "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)] text-[color:var(--ds-danger)]",
    icon: AlertTriangle,
    label: "Failed",
  },
  paused: {
    cls: "border-[color:var(--ds-status-parked-border)] bg-[var(--ds-status-parked-bg)] text-[color:var(--ds-status-parked-fg)]",
    icon: Pause,
    label: "Paused",
  },
};

/**
 * `span` fills the second column when a card holds an ODD number of browsers.
 * A lone half-width tile beside dead space reads as a tile that failed to
 * render, which is exactly the wrong thing for a panel about health.
 */
function BrowserTile({ b, span }: { b: DemoBrowser; span?: boolean }) {
  const tone = HEALTH_TONE[b.health];
  const Icon = tone.icon;
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("relative", span && "col-span-2")}>
      {/* Zero chrome at rest — the state word owns the full tile width. An
          earlier design crammed six hover glyphs in here and crushed
          "Refreshing" to "R". Actions live behind a right-click menu. */}
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${b.label} — ${tone.label} · ${b.url}\nRight-click (two-finger click) for browser actions`}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className={cn(
          "flex w-full min-w-0 cursor-pointer flex-col border",
          "gap-[var(--ds-space-hair)] px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
          dsRadius.md,
          dsFocus,
          dsMotion.base,
          tone.cls,
          open && "border-[color:var(--ds-border-loud)]",
        )}
      >
        <span className={cn(dsText.caps, "flex items-center gap-[var(--ds-space-tight)]")}>
          <Icon aria-hidden className={cn(dsIcon.sm, "shrink-0", b.health === "refreshing" && "animate-spin motion-reduce:animate-none")} />
          {b.label}
        </span>
        <span className={cn(dsText.micro, "truncate opacity-80")}>{tone.label}</span>
      </div>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute bottom-full left-0 mb-[var(--ds-space-tight)] w-44 overflow-hidden border py-[var(--ds-space-tight)]",
            dsLayer.menu,
            dsRadius.md,
            dsBorder.base,
            "bg-[var(--ds-surface-overlay)]",
            dsElev.mid,
          )}
        >
          {["Peek (live screenshot)", "Check now", "Bring to front", "Refresh page", "Reopen tab", b.health === "paused" ? "Resume auto-recovery" : "Pause auto-recovery"].map(
            (item, i) => (
              <button
                key={item}
                type="button"
                role="menuitem"
                onClick={() => setOpen(false)}
                className={cn(
                  "flex w-full cursor-pointer items-center text-left",
                  "gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-tight)]",
                  dsText.body,
                  dsMotion.fast,
                  "text-[color:var(--ds-fg-secondary)] outline-none",
                  "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)] focus-visible:bg-[var(--ds-surface-3)]",
                  (i === 1 || i === 5) && cn("border-t", dsBorder.subtle),
                )}
              >
                {i === 0 && <Camera aria-hidden className={dsIcon.sm} />}
                {item}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** at cap = this worker cannot take another item; that is the number that
    explains a queue that is not moving, so it is the one that goes amber */
const atCap = (slot: { inUse: number; cap: number }): boolean => slot.inUse >= slot.cap;

/**
 * One capacity chip shape for lanes AND for every system budget. They were two
 * near-identical hand-rolled spans at 9.5px, which is below the type floor and
 * made the row wrap ragged whenever a card carried three systems.
 */
const capacityChip = (full: boolean): string =>
  cn(
    "inline-flex shrink-0 items-center border",
    "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
    dsRadius.sm,
    dsText.micro,
    full
      ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]"
      : "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
  );

function SessionCard({ s, tick }: { s: DemoSession; tick: number }) {
  const tone = PHASE_TONE[s.phase];
  const inFlight = s.phase === "running";

  // A daemon that died before its browser opened is a different object: no
  // tiles, no timer, nothing to stop. Keep it visible so the failure is learned.
  if (s.crashed) {
    return (
      <article
        className={cn(
          "flex shrink-0 flex-col border",
          "w-[var(--ds-w-session-card)] gap-[var(--ds-space-tight)] p-[var(--ds-space-base)]",
          dsRadius.lg,
          "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)]",
        )}
      >
        <div className="flex items-center gap-[var(--ds-space-base)]">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-[var(--ds-danger)]" />
          <span className={cn(dsText.ui, "min-w-0 flex-1 truncate font-semibold text-[color:var(--ds-fg)]")}>{s.workflow}</span>
          <span className={cn(dsText.caps, "shrink-0 text-[color:var(--ds-danger)]")}>Launch failed</span>
        </div>
        <p className={cn(dsText.meta, "text-[color:var(--ds-danger)] opacity-85")}>{s.subline}</p>
      </article>
    );
  }

  return (
    <article
      className={cn(
        "flex shrink-0 flex-col border",
        "w-[var(--ds-w-session-card)] gap-[var(--ds-space-snug)] p-[var(--ds-space-base)]",
        dsRadius.lg,
        dsSurface.card,
        s.phase === "failed" ? "border-[color:var(--ds-danger-border)]" : dsBorder.base,
      )}
    >
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
        {/* the trailing instance ordinal is always stripped from the title */}
        <span className={cn(dsText.ui, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>{s.workflow}</span>
        {s.queued ? (
          <span
            className={cn(
              "inline-flex shrink-0 items-center border px-[var(--ds-space-tight)]",
              "h-[var(--ds-h-xs)] gap-[var(--ds-space-hair)]",
              dsRadius.sm,
              dsText.micro,
              "border-[color:var(--ds-status-queued-border)] text-[color:var(--ds-status-queued-fg)]",
            )}
          >
            <span className={dsText.nums}>{s.queued}</span> queued
          </span>
        ) : null}
        <span className={cn(dsText.caps, "ml-auto shrink-0", tone.text)}>{tone.label}</span>
      </div>
      <span className={cn(dsText.meta, "-mt-[var(--ds-space-tight)] truncate text-[color:var(--ds-fg-muted)]", inFlight && dsText.nums)}>
        {s.subline}
      </span>

      {/* Capacity, before the browsers. "1/1 lanes · ucpath 1/1" is the answer
          to "can this worker take another item", and it has to be readable
          without opening anything. A slot at its cap is amber — that is the
          number that explains a stalled queue. */}
      {(s.lanes || s.budgets) && (
        <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
          {s.lanes && (
            <span title={`${s.lanes.inUse} of ${s.lanes.cap} lanes in use — a lane is one item in flight`} className={capacityChip(atCap(s.lanes))}>
              <Gauge aria-hidden className="size-2.5 shrink-0" />
              <span className={dsText.nums}>
                {s.lanes.inUse}/{s.lanes.cap}
              </span>
              lanes
            </span>
          )}
          {s.budgets?.map((b) => (
            <span
              key={b.system}
              title={`${b.system}: ${b.inUse} of ${b.cap} concurrent sessions in use by this worker`}
              className={capacityChip(atCap(b))}
            >
              {b.system}
              <span className={dsText.nums}>
                {b.inUse}/{b.cap}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* WHY nothing is progressing. Named lease, named holder, ticking age —
          an executor that is alive, healthy and stuck must say so, or the panel
          is decorative. */}
      {s.waiting && (
        <div
          className={cn(
            "flex items-start border",
            "gap-[var(--ds-space-snug)] px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
            dsRadius.md,
            "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
          )}
        >
          <Hourglass aria-hidden className={cn(dsIcon.sm, "mt-px shrink-0 text-[color:var(--ds-status-waiting-fg)]")} />
          <span className={cn(dsText.meta, "min-w-0 text-[color:var(--ds-status-waiting-fg)]")}>
            Waiting <span className={dsText.nums}>{fmtElapsed(s.waiting.sinceSec + tick)}</span> for the{" "}
            <span className="font-semibold">{s.waiting.system}</span> lease — held by {s.waiting.heldByWorkflow}{" "}
            <span className={dsText.nums}>{s.waiting.heldByTrace}</span>
          </span>
        </div>
      )}

      {/* An odd last tile spans both columns: a lone half-width tile beside
          dead space reads as one that failed to render. */}
      <div className="grid grid-cols-2 gap-[var(--ds-space-tight)]">
        {s.browsers.map((b, i) => (
          <BrowserTile key={b.id} b={b} span={s.browsers.length % 2 === 1 && i === s.browsers.length - 1} />
        ))}
      </div>

      {/* micro pipeline — where the in-flight item is, without opening anything */}
      {s.steps && s.steps.length >= 2 && (
        <div aria-hidden className="flex items-center" title={s.steps.map((st) => st.label).join(" · ")}>
          {s.steps.map((st, i) => (
            <span key={st.label} className="flex flex-1 items-center last:flex-none">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  st.state === "done" && "bg-[var(--ds-success-fg)] opacity-85",
                  st.state === "current" && "bg-[var(--ds-accent)] ring-2 ring-[color:var(--ds-accent-quiet)]",
                  st.state === "pending" && cn("border bg-[var(--ds-surface-2)]", dsBorder.base),
                )}
              />
              {i < s.steps!.length - 1 && (
                <span
                  className={cn(
                    "h-px min-w-[3px] flex-1",
                    st.state === "done" ? "bg-[var(--ds-success-fg)] opacity-30" : "bg-[var(--ds-border)]",
                  )}
                />
              )}
            </span>
          ))}
        </div>
      )}

      <div
        className={cn(
          dsText.meta,
          "flex items-center border-t text-[color:var(--ds-fg-muted)]",
          dsBorder.subtle,
          "gap-[var(--ds-space-snug)] pt-[var(--ds-space-snug)]",
        )}
      >
        <span className={dsText.nums}>{s.elapsedSec > 0 ? fmtElapsed(s.elapsedSec + tick) : "—"}</span>
        <span className="min-w-0 flex-1 truncate" title={s.sleepPerTaskSec ? `Sleeps ${s.sleepPerTaskSec}s between tasks` : undefined}>
          {s.sleepPerTaskSec ? `${s.step ?? ""} · ${s.sleepPerTaskSec}s/task sleep` : (s.step ?? "")}
        </span>
        <Button size="sm" variant="outline" onClick={NOOP} className="shrink-0">
          Stop
        </Button>
      </div>
    </article>
  );
}

export function DemoSessionPanel({ tick }: { tick: number }) {
  const [open, setOpen] = useState(false);
  const running = DEMO_SESSIONS.filter((s) => s.phase === "running").length;
  const auth = DEMO_SESSIONS.filter((s) => s.phase === "authenticating").length;
  const idle = DEMO_SESSIONS.filter((s) => s.phase === "idle" || s.phase === "keepalive").length;
  const failed = DEMO_SESSIONS.filter((s) => s.phase === "failed").length;
  const sickBrowsers = DEMO_SESSIONS.flatMap((s) => s.browsers).filter((b) => b.health !== "healthy").length;
  // Capacity at a glance. `blocked` is the headline the operator actually needs:
  // three cards can say "Running" while the queue does not move.
  const lanesInUse = DEMO_SESSIONS.reduce((n, s) => n + (s.lanes?.inUse ?? 0), 0);
  const lanesCap = DEMO_SESSIONS.reduce((n, s) => n + (s.lanes?.cap ?? 0), 0);
  const blocked = DEMO_SESSIONS.filter((s) => s.waiting);

  /** the summary chips on the collapsed bar — one shape, two loudness levels */
  const barChip = (warn: boolean): string =>
    cn(
      "inline-flex shrink-0 items-center border",
      "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-snug)]",
      dsRadius.sm,
      dsText.micro,
      warn
        ? "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)] text-[color:var(--ds-status-waiting-fg)]"
        : "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
    );

  return (
    <section aria-label="Session Panel" className={cn("shrink-0 border-t", dsBorder.base, dsSurface.card)}>
      <div className={cn("flex items-center", dsSize.hBar, "gap-[var(--ds-space-base)] px-[var(--ds-space-cozy)]")}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center overflow-hidden text-left",
            "h-[var(--ds-h-md)] gap-[var(--ds-space-cozy)] px-[var(--ds-space-tight)]",
            dsRadius.md,
            dsFocus,
            dsMotion.fast,
            "hover:bg-[var(--ds-surface-3)]",
          )}
        >
          {open ? (
            <ChevronDown aria-hidden className={cn(dsIcon.md, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
          ) : (
            <ChevronUp aria-hidden className={cn(dsIcon.md, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
          )}
          <span className={cn(dsText.ui, "shrink-0 font-semibold text-[color:var(--ds-fg)]")}>Sessions</span>
          {/* 3-way split — a daemon that is alive but has not reported a phase is
              still AUTHENTICATING, never idle. Calling it idle misreads capacity. */}
          <span className={cn(dsText.meta, "flex shrink-0 items-center gap-[var(--ds-space-cozy)] text-[color:var(--ds-fg-muted)]")}>
            <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
              <span aria-hidden className="size-1.5 rounded-full bg-[var(--ds-success-fg)]" />
              {running} running
            </span>
            <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
              <span
                aria-hidden
                className="size-1.5 rounded-full bg-[var(--ds-status-waiting-fg)] animate-pulse motion-reduce:animate-none"
              />
              {auth} authenticating
            </span>
            <span className="inline-flex items-center gap-[var(--ds-space-tight)]">
              <span aria-hidden className="size-1.5 rounded-full bg-[var(--ds-fg-faint)]" />
              {idle} idle
            </span>
            {failed > 0 && (
              <span className="inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-danger)]">
                <span aria-hidden className="size-1.5 rounded-full bg-[var(--ds-danger)]" />
                {failed} failed
              </span>
            )}
          </span>
          <span title={`${lanesInUse} of ${lanesCap} lanes in use across every worker`} className={barChip(false)}>
            <Gauge aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
            <span className={dsText.nums}>
              {lanesInUse}/{lanesCap}
            </span>
            lanes
          </span>
          {blocked.length > 0 && (
            <span
              title={blocked.map((s) => `${s.workflow} is waiting on the ${s.waiting?.system} lease`).join(" · ")}
              className={barChip(true)}
            >
              <Hourglass aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
              {blocked.length} waiting on a lease
            </span>
          )}
          {sickBrowsers > 0 && (
            <span className={barChip(true)}>
              <AlertTriangle aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
              {sickBrowsers} browsers need attention
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center gap-[var(--ds-space-snug)]">
          <IconButton size="sm" label="Add a worker" onClick={NOOP} icon={<Plus aria-hidden className={dsIcon.md} />} />
          <span className={cn(dsText.meta, "inline-flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-success-fg)]")}>
            <span aria-hidden className="size-1.5 rounded-full bg-[var(--ds-success-fg)] animate-pulse motion-reduce:animate-none" />
            Live
          </span>
        </span>
      </div>

      {open && (
        <div
          className={cn(
            // items-start, not stretch: a card is as tall as what it knows.
            // The crashed worker has two lines to say, and stretching it into a
            // full-height red block overstates it and looks unfinished.
            "flex items-start overflow-x-auto border-t",
            dsBorder.subtle,
            "gap-[var(--ds-space-base)] px-[var(--ds-space-cozy)] py-[var(--ds-space-cozy)]",
          )}
        >
          {DEMO_SESSIONS.map((s) => (
            <SessionCard key={s.id} s={s} tick={tick} />
          ))}
        </div>
      )}
    </section>
  );
}
