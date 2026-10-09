import { useEffect, useRef, useState } from "react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  Check,
  X,
  KeyRound,
  Loader2,
  Hourglass,
  RotateCw,
  Crosshair,
  AlertTriangle,
  ExternalLink,
  Activity,
  Pause,
  Play,
  PauseCircle,
  Camera,
  CircleHelp,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import type { AuthState, BrowserHealth, WorkflowInstanceState } from "@/components/shared/types";
import { useConfirm } from "@/components/shared/useConfirm";
import { formatStepName } from "@/components/shared/types";
import { useElapsed } from "@/components/hooks/useElapsed";
import { useTerminalDrawer } from "@/components/hooks/useTerminalDrawer";
import { useNow } from "@/components/hooks/useNow";
import { useWorkflow } from "@/lib/workflows-context";
import { getWorkflowIcon } from "@/lib/workflow-icons";
import {
  idleRefreshCadence,
  isIdleRefreshSystem,
  DEFAULT_IDLE_REFRESH_CADENCE,
} from "../../../domain/idle-refresh.js";

/* ----------------------------------------------------------------------
 * Auth-state visual tokens. Single source of truth for every system tile
 * so colors, icons, and labels never drift between surfaces.
 * -------------------------------------------------------------------- */
const authColor: Record<AuthState, string> = {
  idle: "text-muted-foreground",
  authenticating: "text-info",
  authed: "text-[#4ade80]",
  duo_waiting: "text-[#fbbf24]",
  failed: "text-destructive",
};

const authBg: Record<AuthState, string> = {
  idle: "bg-muted/20 border-border/60",
  authenticating: "bg-info/10 border-info/30",
  authed: "bg-success/10 border-success/30",
  duo_waiting: "bg-warning/10 border-warning/40 motion-safe:animate-pulse",
  failed: "bg-destructive/10 border-destructive/40",
};

const authLabel: Record<AuthState, string> = {
  idle: "Pending",
  authenticating: "Authing",
  authed: "Ready",
  duo_waiting: "Duo",
  failed: "Failed",
};

// Health is orthogonal to auth and OVERRIDES the tile look when non-healthy
// (a failed browser reads red regardless of its auth state). `healthy` is no
// override — the auth maps drive the tile.
const healthTone: Record<Exclude<BrowserHealth, "healthy">, string> = {
  refreshing: "bg-info/10 border-info/40",
  unhealthy: "bg-warning/10 border-warning/40",
  failed: "bg-destructive/10 border-destructive/50",
};

const healthColor: Record<Exclude<BrowserHealth, "healthy">, string> = {
  refreshing: "text-info",
  unhealthy: "text-warning",
  failed: "text-destructive",
};

const healthLabel: Record<Exclude<BrowserHealth, "healthy">, string> = {
  refreshing: "Refreshing",
  unhealthy: "Unhealthy",
  failed: "Failed",
};

function HealthIcon({ health, className }: { health: Exclude<BrowserHealth, "healthy">; className?: string }) {
  if (health === "refreshing") {
    return <Loader2 className={cn("animate-spin motion-reduce:animate-none", className)} />;
  }
  return <AlertTriangle className={className} />;
}

/**
 * Operator-facing daemon label. The instance identity stays numbered
 * ("Oath Upload 1", "Oath Upload 2") internally for stable start/end pairing,
 * but the card title shows just the bare workflow name — the trailing session
 * ordinal is always dropped, for every workflow and every instance. Cards are
 * disambiguated by their subtitle (the running run's trace id) + the live
 * elapsed timer, not by a title number. The full numbered identity stays in
 * the hover `title`.
 */
function displayInstance(instance: string): string {
  return instance.replace(/\s\d+$/, "");
}

function AuthIcon({ state, className }: { state: AuthState; className?: string }) {
  const cls = cn("w-3 h-3", className);
  switch (state) {
    case "authed":
      return <Check className={cls} strokeWidth={3} />;
    case "authenticating":
      return <Loader2 className={cn(cls, "animate-spin motion-reduce:animate-none")} />;
    case "duo_waiting":
      return <KeyRound className={cls} />;
    case "failed":
      return <X className={cls} strokeWidth={3} />;
    default:
      return <Hourglass className={cls} />;
  }
}

function IdleCountdownRing({
  systemId,
  lastTouchAt,
  refreshing,
  cycling,
}: {
  systemId: string;
  lastTouchAt: string;
  refreshing: boolean;
  cycling: boolean;
}) {
  const now = useNow();
  const refreshMs =
    idleRefreshCadence(systemId)?.thresholdMs ?? DEFAULT_IDLE_REFRESH_CADENCE.thresholdMs;
  const refreshMins = Math.round(refreshMs / 60_000);
  if (refreshing) {
    return (
      <Loader2
        className="w-[13px] h-[13px] shrink-0 animate-spin motion-reduce:animate-none text-foreground/85"
        aria-label={`${systemId} idle refresh in progress`}
      />
    );
  }
  const startMs = Date.parse(lastTouchAt);
  if (!Number.isFinite(startMs)) return null;

  const elapsedMs = Math.max(0, now - startMs);
  const cycleElapsedMs =
    cycling && elapsedMs >= refreshMs ? elapsedMs % refreshMs : elapsedMs;
  const overdue = !cycling && elapsedMs >= refreshMs;
  /** 1 → just touched, 0 → idle reload due. */
  const remainingRatio = overdue
    ? 0
    : Math.max(0, Math.min(1, 1 - cycleElapsedMs / refreshMs));
  const remainingMs = Math.max(0, refreshMs - cycleElapsedMs);

  const size = 13;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - remainingRatio);
  const secsLeft = Math.ceil(remainingMs / 1000);
  const aria = overdue
    ? `${systemId} idle interval complete; page refresh pending`
    : `${systemId} idle: ${secsLeft}s until ${refreshMins}-minute page refresh`;
  const title = overdue
    ? `${refreshMins} min idle window complete — refresh pending`
    : `Elapsed toward ${refreshMins} min ${systemId} refresh · ${secsLeft}s left`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0 -rotate-90"
      aria-label={aria}
      role="img"
    >
      <title>{title}</title>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-muted-foreground/30"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        className={cn(
          "transition-[stroke-dashoffset,stroke] duration-300",
          overdue ? "stroke-[#fbbf24]/80" : "stroke-foreground/90",
        )}
        strokeDasharray={c}
        strokeDashoffset={dashOffset}
      />
    </svg>
  );
}

function deriveSessionCardCopy(args: {
  active: boolean;
  finalStatus: "done" | "failed" | null;
  itemInFlight: boolean;
  currentStep: string | null;
  authedBrowsers: number;
  totalBrowsers: number;
  daemonPhase?: "idle" | "keepalive";
  queued: number;
}): { subline: string; footerStep: string } {
  const {
    active,
    finalStatus,
    itemInFlight,
    currentStep,
    authedBrowsers,
    totalBrowsers,
    daemonPhase,
    queued,
  } = args;

  if (!active) {
    const sub =
      finalStatus === "failed"
        ? "Run failed"
        : finalStatus === "done"
          ? "Run complete"
          : "Daemon ended";
    const foot =
      finalStatus === "done" ? "complete" : finalStatus === "failed" ? "failed" : "ended";
    return { subline: sub, footerStep: foot };
  }

  if (itemInFlight) {
    // The footer is "what step is it in" — never a raw item id. With
    // `step_change` events now flowing to session state (see emitStepChange),
    // `currentStep` is populated for the run; the fallback only covers the
    // brief window before the first step fires.
    const stepLabel = currentStep ? formatStepName(currentStep) : null;
    return { subline: stepLabel ?? "processing…", footerStep: stepLabel ?? "running…" };
  }

  if (daemonPhase === "keepalive") {
    return {
      subline: "keepalive — checking browsers",
      footerStep: "keepalive — checking browsers",
    };
  }

  if (daemonPhase === "idle") {
    if (queued > 0) {
      const q = `${queued} queued — ready`;
      return { subline: q, footerStep: q };
    }
    const idle = "idle — waiting for work";
    return { subline: idle, footerStep: idle };
  }

  if (authedBrowsers !== totalBrowsers || totalBrowsers === 0) {
    return {
      subline: `Authenticating ${authedBrowsers}/${totalBrowsers}`,
      footerStep: "authenticating",
    };
  }

  if (queued > 0) {
    const q = `${queued} queued — waiting for next item`;
    return { subline: q, footerStep: q };
  }

  const wait = "waiting for next item";
  return { subline: wait, footerStep: "idle" };
}

/**
 * Mono-pill stop button. Matches the elapsed-time pill family (same height,
 * mono font, same border radius) so the right-stack reads as one visual unit.
 *
 * A click stops THIS daemon only (per-instance) via `/api/daemon/stop-instance`
 * — the workflow's other daemons keep running. The daemon hands its in-flight
 * item to a surviving peer when one exists, or fails it when this is the last
 * daemon. (The workflow-scoped "stop every daemon" action lives on the queue
 * toolbar's StopAllButton, not here.)
 */
function StopPill({
  workflow,
  instance,
  itemInFlight,
  reassignable,
}: {
  workflow: string;
  instance: string;
  itemInFlight: boolean;
  reassignable: boolean;
}) {
  const [sending, setSending] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const postStop = async () => {
    if (itemInFlight && !reassignable) {
      const ok = await confirm({
        tone: "destructive",
        title: `Stop last ${workflow} daemon?`,
        description:
          "This daemon is running an item. With no peer daemon available, stopping it will fail the live work.",
        confirmLabel: "Stop and fail item",
      });
      if (!ok) return;
    }

    setSending(true);
    const toastId = toast.loading(`Stopping ${displayInstance(instance)}…`);
    try {
      const res = await fetch("/api/daemon/stop-instance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, instance }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        daemonStopped?: boolean;
        browsersKilled?: number;
        reassignable?: boolean;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        toast.error(`Couldn't stop this ${workflow} daemon`, {
          id: toastId,
          description: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      if (!json.daemonStopped) {
        toast.warning(`No live ${workflow} daemon found for this card`, { id: toastId });
      } else if (json.reassignable) {
        toast.success(`Stopped — any in-flight item moves to another ${workflow} daemon`, {
          id: toastId,
        });
      } else {
        toast.success(`Stopped — this was the last ${workflow} daemon`, { id: toastId });
      }
    } catch (err) {
      toast.error(`Couldn't stop this ${workflow} daemon`, {
        id: toastId,
        description: (err as Error).message,
      });
    } finally {
      setSending(false);
    }
  };

  const title = `Stop this ${workflow} daemon (other ${workflow} daemons keep running)`;

  return (
    <>
      <button
        type="button"
        disabled={sending}
        onClick={(e) => {
          e.stopPropagation();
          void postStop();
        }}
        title={title}
        aria-label={title}
        className={cn(
          "font-mono text-[10px] leading-[1.3] px-[7px] py-[2px]",
          "rounded-md border inline-flex items-center justify-center gap-[3px]",
          "tracking-tight cursor-pointer select-none",
          "transition-colors",
          // Default: hairline destructive outline, no fill
          "border-[hsl(0_84%_60%/0.30)] text-[hsl(0_84%_70%/0.85)] bg-transparent",
          "hover:bg-[hsl(0_84%_60%/0.12)] hover:text-[hsl(0_84%_75%)] hover:border-[hsl(0_84%_60%/0.55)]",
          sending && "opacity-60 cursor-wait",
        )}
      >
        {sending ? (
          <Loader2 className="w-2.5 h-2.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <span aria-hidden className="text-[11px] leading-none opacity-90">×</span>
        )}
        stop
      </button>
      {confirmDialog}
    </>
  );
}

type BrowserAction = "check" | "focus" | "refresh" | "reopen";

const BROWSER_ACTIONS: ReadonlyArray<{
  action: BrowserAction;
  Icon: typeof Crosshair;
  /** Short label for the overflow menu row. */
  menuLabel: string;
  verb: (system: string) => string;
  success: (system: string) => string;
}> = [
  { action: "check", Icon: Activity, menuLabel: "Check now", verb: (s) => `Check ${s} now`, success: (s) => `Checking the ${s} browser` },
  { action: "focus", Icon: Crosshair, menuLabel: "Bring to front", verb: (s) => `Bring the ${s} window to front`, success: (s) => `Bringing the ${s} window to front` },
  { action: "refresh", Icon: RotateCw, menuLabel: "Refresh page", verb: (s) => `Refresh (reload) the ${s} page`, success: (s) => `Reloading the ${s} page` },
  { action: "reopen", Icon: ExternalLink, menuLabel: "Reopen tab", verb: (s) => `Reopen ${s} on a fresh tab (same login)`, success: (s) => `Reopening ${s} on a fresh tab` },
];

type BrowserView = WorkflowInstanceState["sessions"][number]["browsers"][number];

/**
 * One per-browser tile. The tile shows status at rest (clean — no buttons); a
 * **right-click / two-finger click** (context menu) on the tile opens a recovery
 * menu targeting THIS browser by `(workflow, instance, systemId)`:
 *   - Peek    — live screenshot of the browser.
 *   - Check   — probe health now (`/api/browser/check`).
 *   - Focus   — bring the Chromium window to front ("which browser is this?").
 *   - Refresh — reload the page (rung 1 recovery).
 *   - Reopen  — fresh tab on the same authenticated context (rung 2, no Duo).
 *   - Pause/Resume auto-recovery.
 * The tile IS the `ContextMenu` trigger (Radix `asChild`), so the menu opens at
 * the cursor on secondary-click — keeping the resting tile uncluttered and the
 * state label full-width.
 */
function BrowserTile({
  b,
  workflow,
  instance,
  active,
  pidAlive,
  itemInFlight,
  idleBySystem,
  onPeek,
}: {
  b: BrowserView;
  workflow: string | null | undefined;
  instance: string;
  active: boolean;
  pidAlive: boolean;
  itemInFlight: boolean;
  idleBySystem: WorkflowInstanceState["idleBySystem"];
  /** Open the live "peek" screenshot modal for this browser. */
  onPeek: () => void;
}) {
  const systemId = b.system;
  const paused = !!b.autoRecoveryPaused;
  const [busy, setBusy] = useState<null | BrowserAction | "pause">(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const canControl = active && pidAlive && !!workflow;

  const post = async (spec: (typeof BROWSER_ACTIONS)[number]) => {
    if (!workflow) return;
    setBusy(spec.action);
    const toastId = toast.loading(`${spec.verb(systemId)}…`);
    try {
      const res = await fetch(`/api/browser/${spec.action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, instance, systemId }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        toast.error(`Couldn't ${spec.action} the ${systemId} browser`, {
          id: toastId,
          description: json.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      toast.success(spec.success(systemId), { id: toastId });
    } catch (err) {
      toast.error(`Couldn't ${spec.action} the ${systemId} browser`, {
        id: toastId,
        description: (err as Error).message,
      });
    } finally {
      setBusy(null);
    }
  };

  // Pause/resume auto-recovery (toggle — icon + verb flip on `paused`).
  const toggleAutoRecovery = async () => {
    if (!workflow) return;
    const next = !paused;
    setBusy("pause");
    const toastId = toast.loading(`${next ? "Pausing" : "Resuming"} ${systemId} auto-recovery…`);
    try {
      const res = await fetch(`/api/browser/auto-recovery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, instance, systemId, paused: next }),
      });
      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !json.ok) {
        toast.error(`Couldn't update ${systemId} auto-recovery`, { id: toastId, description: json.error ?? `HTTP ${res.status}` });
        return;
      }
      toast.success(next ? `Auto-recovery paused for ${systemId}` : `Auto-recovery resumed for ${systemId}`, { id: toastId });
    } catch (err) {
      toast.error(`Couldn't update ${systemId} auto-recovery`, { id: toastId, description: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  // Health overrides the tile look when non-healthy; otherwise the auth state
  // drives it. Both are bound to THIS browser by id.
  const badHealth = b.health && b.health !== "healthy" ? b.health : undefined;
  // `b.health` is undefined until the first `browser_health` probe lands (the
  // monitor ticks every ~30s and skips while auth/a step owns the page) — that
  // is a genuinely valid "not yet checked" window, not a confirmed-healthy one.
  // Don't let it read identically to a probed-and-healthy browser: the idle
  // countdown ring specifically claims "confirmed healthy AND being cycled",
  // so it's gated on an ACTUAL healthy probe, not merely the absence of a bad
  // one — otherwise a stalled/dead health monitor would look forever fine.
  const healthUnknown = b.authState === "authed" && !badHealth && b.health !== "healthy";
  const tone = badHealth ? healthTone[badHealth] : authBg[b.authState];
  const labelColor = badHealth ? healthColor[badHealth] : authColor[b.authState];
  const stateLabel = badHealth ? healthLabel[badHealth] : authLabel[b.authState];
  const tipBase = badHealth
    ? `${systemId} · ${healthLabel[badHealth]}${b.lastError ? ` — ${b.lastError}` : ""}`
    : isIdleRefreshSystem(systemId) &&
        b.authState === "authed" &&
        idleBySystem?.[systemId]?.lastTouchAt
      ? `${systemId} · ${authLabel[b.authState]} · idle page reload timer`
      : healthUnknown
        ? `${systemId} · ${authLabel[b.authState]} · health not yet checked`
        : `${systemId} · ${authLabel[b.authState]}`;
  // Append the browser's current url + a recovery trail so hovering a tile
  // (esp. a failed/flapping one) shows where it actually is and how it got there.
  const trail =
    b.healthHistory && b.healthHistory.length >= 2
      ? `\nrecovery: ${b.healthHistory.map((h) => h.status).join(" → ")}`
      : "";
  const tip = `${tipBase}${b.url ? `\n${b.url}` : ""}${trail}`;

  const tileClass = cn(
    "relative rounded-md border px-1.5 py-1 min-w-0 transition-colors",
    tone,
    canControl && "cursor-context-menu select-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
    menuOpen && "ring-1 ring-ring/60",
  );

  const pauseTitle = paused
    ? `Resume auto-recovery for the ${systemId} browser`
    : `Pause auto-recovery for the ${systemId} browser (so you can inspect it)`;
  const menuBusy = busy !== null;

  const tileBody = (
    <>
      <div className="flex items-center gap-1 min-w-0 justify-between">
        <div className="flex items-center gap-1 min-w-0">
          <AuthIcon state={b.authState} className={cn("w-3 h-3 shrink-0", authColor[b.authState])} />
          <span className="text-[11px] font-mono text-foreground truncate leading-none">
            {systemId}
          </span>
        </div>
        {/* Idle ring shows only when CONFIRMED healthy + idle-refresh; a
            non-healthy tile shows its health icon, and an unprobed tile shows
            a neutral "not yet checked" glyph instead of implying it's fine. */}
        {b.health === "healthy" &&
          isIdleRefreshSystem(systemId) &&
          b.authState === "authed" &&
          !itemInFlight &&
          idleBySystem?.[systemId]?.lastTouchAt != null &&
          idleBySystem[systemId].lastTouchAt.length > 0 && (
            <IdleCountdownRing
              systemId={systemId}
              lastTouchAt={idleBySystem[systemId].lastTouchAt}
              refreshing={!!idleBySystem[systemId].refreshing}
              cycling={active && !itemInFlight}
            />
          )}
        {badHealth && (
          <HealthIcon health={badHealth} className={cn("w-3 h-3 shrink-0", healthColor[badHealth])} />
        )}
        {healthUnknown && (
          <CircleHelp
            aria-label={`${systemId} health not yet checked`}
            className="w-3 h-3 shrink-0 text-muted-foreground"
          />
        )}
        {/* Always-visible cue that auto-recovery is paused for this browser. */}
        {paused && (
          <PauseCircle aria-label="auto-recovery paused" className="w-3 h-3 shrink-0 text-warning" />
        )}
      </div>
      {/* State word gets the FULL tile width so the longest labels
          ("Refreshing"/"Unhealthy") never truncate. */}
      <div className="mt-0.5 min-w-0 min-h-[14px]">
        <span
          className={cn(
            "block text-[9.5px] uppercase tracking-wider font-semibold leading-none truncate",
            labelColor,
          )}
        >
          {stateLabel}
        </span>
      </div>
    </>
  );

  // No live daemon to target → a plain, non-interactive status tile.
  if (!canControl) {
    return (
      <div className={tileClass} title={tip}>
        {tileBody}
      </div>
    );
  }

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild>
        <div
          className={tileClass}
          title={`${tip}\n\nRight-click (two-finger click) for browser actions`}
          tabIndex={0}
          aria-haspopup="menu"
          aria-label={`${systemId} browser — right-click for actions`}
        >
          {tileBody}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[11rem]">
        <ContextMenuItem
          aria-label={`Peek at the ${systemId} browser (live screenshot)`}
          className="gap-2.5"
          onSelect={() => onPeek()}
        >
          <Camera className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span>Peek (live screenshot)</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {BROWSER_ACTIONS.map((spec) => (
          <ContextMenuItem
            key={spec.action}
            disabled={menuBusy}
            aria-label={spec.verb(systemId)}
            className="gap-2.5"
            onSelect={(e) => {
              e.preventDefault();
              void post(spec);
            }}
          >
            {busy === spec.action ? (
              <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground" />
            ) : (
              <spec.Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            )}
            <span>{spec.menuLabel}</span>
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          disabled={menuBusy}
          aria-label={pauseTitle}
          className={cn("gap-2.5", paused && "text-warning focus:text-warning")}
          onSelect={(e) => {
            e.preventDefault();
            void toggleAutoRecovery();
          }}
        >
          {busy === "pause" ? (
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          ) : paused ? (
            <Play className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <Pause className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          )}
          <span>{paused ? "Resume auto-recovery" : "Pause auto-recovery"}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * Live "peek" modal — fetches a synchronous viewport screenshot of one browser
 * (`GET /api/browser/screenshot`) so the operator can SEE what's wrong without
 * hunting for the physical Chromium window. Esc / click-outside / × to close.
 */
function BrowserPeekModal({
  workflow,
  instance,
  systemId,
  onClose,
}: {
  workflow: string;
  instance: string;
  systemId: string;
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const src =
    `/api/browser/screenshot?workflow=${encodeURIComponent(workflow)}` +
    `&instance=${encodeURIComponent(instance)}&systemId=${encodeURIComponent(systemId)}`;

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        size="full"
        className="w-auto p-2"
        aria-label={`${systemId} browser live screenshot`}
      >
        <div className="flex items-center justify-between gap-3 px-1 pb-2 pr-8">
          <span className="text-[12px] font-mono text-muted-foreground">{systemId} · live screenshot</span>
        </div>
        {errored ? (
          <div className="flex h-[160px] w-[60vw] max-w-[700px] items-center justify-center px-4 text-center text-[12px] text-destructive">
            Couldn't capture this browser — no live page, or the daemon isn't reachable.
          </div>
        ) : (
          <img
            src={src}
            srcSet={src}
            sizes="92vw"
            loading="eager"
            alt={`${systemId} browser current view`}
            className={cn("max-h-[80vh] max-w-[88vw] rounded object-contain", !loaded && "opacity-0")}
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
          />
        )}
        {!loaded && !errored && (
          <div className="absolute inset-0 flex items-center justify-center" aria-live="polite">
            <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none text-muted-foreground" />
            <span className="sr-only">Capturing {systemId} screenshot…</span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
  reassignable?: boolean;
  /**
   * Collapsed top-level QUEUED surface count for this card's workflow (backend
   * `wfQueuedCounts`, threaded from `TerminalDrawer`). The SAME collapse model
   * as the rail total, so the footer "N queued" chip never shows the inflated
   * raw delegated-member count the old `useQueueDepth` read produced (ISS-002).
   */
  queued: number;
}

/**
 * Horizontal session card rendered inside `TerminalDrawer`. The visual
 * contract mirrors the production `WorkflowBox` (rounded-xl, title,
 * mono subline, 2×2 browser tile grid) so the read carries over from the
 * old vertical right-rail. Additions in this iteration:
 *
 *   - Workflow icon next to the title (lucide; matches workflow type).
 *   - Right-stack: always-visible mono `× stop` pill above the live
 *     elapsed timer, both right-aligned and width-aligned.
 *   - Footer row: queued-depth chip + the formatted current step text
 *     replaces the prior pid display.
 *   - Click → focused-card ring (state on `useTerminalDrawer`). The
 *     receiving panels haven't wired focus consumption yet — visual only
 *     for now.
 *   - Cyan border tint when an item is in-flight (distinct from the
 *     amber duo-glow on individual browser tiles).
 */
export function WorkflowBox({ workflow, reassignable = false, queued }: WorkflowBoxProps) {
  const {
    instance,
    workflow: workflowName,
    startedAt,
    active,
    pidAlive,
    currentTraceId,
    itemInFlight,
    currentStep,
    finalStatus,
    sessions,
    daemonPhase,
    idleBySystem,
  } = workflow;
  const { focusedInstance, setFocusedInstance } = useTerminalDrawer();
  const meta = useWorkflow(workflowName ?? "");
  const elapsed = useElapsed(startedAt ?? null);
  const isFocused = focusedInstance === instance;

  const browsers = sessions.flatMap((s) => s.browsers);
  const totalBrowsers = browsers.length;
  const authedBrowsers = browsers.filter((b) => b.authState === "authed").length;

  // Notify ONCE per browser that transitions to `failed` (a hard fault a refresh
  // can't heal). Keyed by browserId so re-renders (the 1s elapsed tick) don't
  // re-fire; a recovery clears the key so a later failure notifies again. The
  // health signature is the only reactive dep — `browsersRef` feeds the latest
  // data without making the array identity a dep.
  const browsersRef = useRef(browsers);
  browsersRef.current = browsers;
  const notifiedFailuresRef = useRef<Set<string>>(new Set());
  // The system whose live "peek" screenshot modal is open (null = closed).
  const [peekSystem, setPeekSystem] = useState<string | null>(null);
  const healthSig = browsers.map((b) => `${b.browserId}:${b.health ?? ""}`).join("|");
  useEffect(() => {
    const seen = notifiedFailuresRef.current;
    for (const b of browsersRef.current) {
      if (b.health === "failed") {
        if (!seen.has(b.browserId)) {
          seen.add(b.browserId);
          toast.error(`${b.system} browser failed`, {
            description: b.lastError ?? "The browser stopped responding.",
          });
        }
      } else if (b.health === "healthy") {
        seen.delete(b.browserId);
      }
    }
  }, [healthSig]);

  // A daemon that crashed on launch has no live session to render. Bail out
  // AFTER all hooks are declared so hook order stays identical across renders
  // (Rules of Hooks) — a crashed daemon carries an empty `sessions` array, so
  // the hooks above are harmless no-ops in that case.
  if (workflow.crashedOnLaunch) {
    return (
      <button
        type="button"
        className={cn(
          "shrink-0 w-[290px] rounded-xl border border-destructive/30 bg-destructive/5 p-2.5",
          "flex flex-col cursor-pointer transition-colors text-left",
          isFocused && "ring-1 ring-primary",
        )}
        onClick={() => setFocusedInstance(instance)}
      >
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0 bg-destructive" />
          <span className="text-[14px] font-semibold text-foreground truncate flex-1" title={instance}>{displayInstance(instance)}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
            Launch failed
          </span>
        </div>
        <p className="mt-1 text-[10.5px] text-destructive/80 leading-tight">
          Check Queue row for details
        </p>
      </button>
    );
  }
  const { subline, footerStep } = deriveSessionCardCopy({
    active: !!active,
    finalStatus: finalStatus ?? null,
    itemInFlight: !!itemInFlight,
    currentStep: currentStep ?? null,
    authedBrowsers,
    totalBrowsers,
    daemonPhase,
    queued,
  });

  // Subtitle: the running run's trace id WHILE in flight (correlates the live
  // card with its queue row/logs); once the item finishes, fall back to the
  // phase subline rather than leaving a stale trace id in the description.
  const subtitle = itemInFlight && currentTraceId ? currentTraceId : subline;

  // Card border tint reflects "current state" — in-flight cards get a
  // subtle cyan ring so an operator can pick out the working session
  // among many at a glance. Focused trumps in-flight (primary ring).
  const borderClass = isFocused
    ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.6),0_0_14px_hsl(var(--primary)/0.18)]"
    : itemInFlight && active
      ? "border-log-cyan/30 shadow-[0_0_0_1px_color-mix(in_srgb,var(--log-cyan)_10%,transparent)]"
      : "border-border";

  // Footer right slot — lifecycle descriptor (matches header subline semantics).
  const stepLabel = footerStep;

  const stepClass = !active
    ? "text-muted-foreground"
    : itemInFlight
      ? "text-log-cyan"
      : daemonPhase === "keepalive" || daemonPhase === "idle"
        ? "text-muted-foreground"
        : currentStep && /auth/i.test(currentStep)
          ? "text-info"
          : authedBrowsers === totalBrowsers && totalBrowsers > 0
            ? "text-muted-foreground"
            : "text-info";

  // Workflow icon — resolved from the registry's `iconName` declaration,
  // with a generic `Workflow` fallback + console.warn for missing entries.
  const Icon = getWorkflowIcon(meta?.iconName);

  // Step list for micro pipeline — pulled from registry. Cap at ~10 dots
  // so wide step lists don't blow out the card. Highlight current step.
  const steps = meta?.steps ?? [];
  const currentIdx = currentStep ? steps.findIndex((s) => s === currentStep) : -1;

  return (
    <div
      className={cn(
        "shrink-0 w-[290px] rounded-xl border bg-card/60 transition-[border-color,box-shadow,opacity]",
        // h-full + parent items-stretch makes every card fill the tallest
        // card's height instead of hugging its own content.
        "h-full flex flex-col cursor-pointer",
        active ? "" : "opacity-55",
        borderClass,
      )}
      onClick={() => setFocusedInstance(isFocused ? null : instance)}
      role="article"
      aria-label={`${instance} session`}
    >
      <div className="px-2.5 pt-2 pb-2.5 flex flex-col gap-2 flex-1">
        {/* Header: (icon + title + subline) + right-stack */}
        <div className="flex items-start gap-2 min-w-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon
                aria-hidden
                className="w-3 h-3 shrink-0 text-muted-foreground"
                strokeWidth={2}
              />
              <span
                className="text-[14px] font-semibold text-foreground leading-tight truncate"
                title={instance}
              >
                {displayInstance(instance)}
              </span>
            </div>
            {/* Subtitle: trace id while in flight, else the phase subline
                (idle/complete/authenticating) — see `subtitle` above. */}
            <div
              className="mt-0.5 text-[10.5px] font-mono text-muted-foreground truncate leading-tight"
              title={subtitle}
            >
              {subtitle}
            </div>
          </div>

          {/* Right-stack: × stop on top, elapsed below. Both share width
              via min-w on the column so they read as one anchored unit. */}
          <div className="flex flex-col gap-1 items-stretch shrink-0 min-w-[64px]">
            {active && pidAlive && workflowName ? (
              <StopPill
                workflow={workflowName}
                instance={instance}
                itemInFlight={!!itemInFlight}
                reassignable={reassignable}
              />
            ) : (
              <span className="h-[20px]" aria-hidden />
            )}
            <span
              className={cn(
                "font-mono text-[10px] leading-[1.3] tabular-nums text-center px-[7px] py-[2px] rounded-md",
                "border border-transparent bg-muted text-muted-foreground tracking-tight",
                // Highlight when duo has been pending long enough that the
                // operator should look at their phone — uses the same amber
                // family as the duo tile glow.
                /duo|auth/i.test(currentStep ?? "") &&
                  /^([1-9]\d*|0)m \d{2}s$/.test(elapsed) &&
                  parseInt(elapsed.split("m")[0] || "0", 10) >= 1 &&
                  active &&
                  "text-[#fbbf24] bg-[#fbbf24]/10",
              )}
              aria-label="Elapsed since session started"
            >
              {elapsed || "—"}
            </span>
          </div>
        </div>

        {/* System lane: keep its height even before a workflow has browser
            sessions so the micro pipeline lines up across all cards. */}
        <div className="min-h-[43px]">
          {browsers.length > 0 && (
            <div className="grid grid-cols-2 gap-1">
              {browsers.map((b) => (
                <BrowserTile
                  key={b.browserId}
                  b={b}
                  workflow={workflowName}
                  instance={instance}
                  active={!!active}
                  pidAlive={!!pidAlive}
                  itemInFlight={!!itemInFlight}
                  idleBySystem={idleBySystem}
                  onPeek={() => setPeekSystem(b.system)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Spacer — pushes the lower block (step pipeline + footer) to the
            BOTTOM of the card so it aligns across cards regardless of how many
            browser rows each has (1-row Person Lookup vs 2-row Separation). */}
        <div aria-hidden className="flex-1 min-h-0" />

        {/* Micro step pipeline — small dots showing lifecycle position
            for the instance's current step. Only renders when we have
            both a registered step list and at least 2 steps. */}
        {steps.length >= 2 && (
          <div className="flex items-center gap-0 pt-1" data-session-step-pipeline aria-hidden>
            {steps.map((s, i) => {
              const done = currentIdx > i;
              const running = currentIdx === i;
              const link = i < steps.length - 1 ? (
                <span
                  key={`l-${s}`}
                  className={cn(
                    "flex-1 h-px min-w-[3px]",
                    done ? "bg-[#4ade80]/30" : "bg-border",
                  )}
                />
              ) : null;
              return (
                <span key={s} className="flex items-center flex-1 last:flex-none">
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full shrink-0",
                      done && "bg-[#4ade80]/85",
                      running && "bg-primary shadow-[0_0_0_2px_color-mix(in_srgb,var(--primary)_18%,transparent)]",
                      !done && !running && "bg-muted border border-border",
                    )}
                    title={formatStepName(s)}
                  />
                  {link}
                </span>
              );
            })}
          </div>
        )}

        {/* Footer: queued chip + spacer + current-step descriptor. */}
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground min-h-[16px]">
          {queued > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-[2px] rounded bg-primary/10 text-primary leading-none">
              <span className="font-medium">{queued}</span> queued
            </span>
          )}
          <span className="flex-1" />
          <span
            className={cn(
              "font-mono text-[10.5px] font-medium tracking-tight max-w-[140px] truncate",
              stepClass,
            )}
            title={stepLabel}
          >
            {stepLabel}
          </span>
        </div>
      </div>
      {peekSystem && workflowName && (
        <BrowserPeekModal
          workflow={workflowName}
          instance={instance}
          systemId={peekSystem}
          onClose={() => setPeekSystem(null)}
        />
      )}
    </div>
  );
}
