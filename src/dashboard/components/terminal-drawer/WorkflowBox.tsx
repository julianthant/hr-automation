import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Check,
  X,
  KeyRound,
  Loader2,
  Hourglass,
} from "lucide-react";
import type { AuthState, WorkflowInstanceState } from "@/components/shared/types";
import { formatStepName } from "@/components/shared/types";
import { useElapsed } from "@/components/hooks/useElapsed";
import { useTerminalDrawer } from "@/components/hooks/useTerminalDrawer";
import { useQueueDepth } from "@/components/hooks/useQueueDepth";
import { useDaemons } from "@/components/hooks/useDaemons";
import { useNow } from "@/components/hooks/useNow";
import { useWorkflow } from "@/lib/workflows-context";
import { getWorkflowIcon } from "@/lib/workflow-icons";

/** Mirrors `DEFAULT_UCPATH_IDLE_THRESHOLD_MS` in `src/core/kernel/session.ts`. */
const UCPATH_IDLE_REFRESH_MS = 5 * 60 * 1000;

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

function UcpathIdleCountdownRing({
  lastTouchAt,
  refreshing,
  cycling,
}: {
  lastTouchAt: string;
  refreshing: boolean;
  cycling: boolean;
}) {
  const now = useNow();
  if (refreshing) {
    return (
      <Loader2
        className="w-[13px] h-[13px] shrink-0 animate-spin motion-reduce:animate-none text-foreground/85"
        aria-label="UCPath idle refresh in progress"
      />
    );
  }
  const startMs = Date.parse(lastTouchAt);
  if (!Number.isFinite(startMs)) return null;

  const elapsedMs = Math.max(0, now - startMs);
  const cycleElapsedMs =
    cycling && elapsedMs >= UCPATH_IDLE_REFRESH_MS
      ? elapsedMs % UCPATH_IDLE_REFRESH_MS
      : elapsedMs;
  const overdue = !cycling && elapsedMs >= UCPATH_IDLE_REFRESH_MS;
  /** 1 → just touched, 0 → idle reload due. */
  const remainingRatio = overdue
    ? 0
    : Math.max(0, Math.min(1, 1 - cycleElapsedMs / UCPATH_IDLE_REFRESH_MS));
  const remainingMs = Math.max(0, UCPATH_IDLE_REFRESH_MS - cycleElapsedMs);

  const size = 13;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dashOffset = c * (1 - remainingRatio);
  const secsLeft = Math.ceil(remainingMs / 1000);
  const aria = overdue
    ? "UCPath idle interval complete; page refresh pending"
    : `UCPath idle: ${secsLeft}s until 5-minute page refresh`;
  const title = overdue
    ? "5 min idle window complete — refresh pending"
    : `Elapsed toward 5 min UCPath refresh · ${secsLeft}s left`;
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
  currentItemId: string | null;
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
    currentItemId,
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
    const sub = currentItemId ?? (currentStep ? formatStepName(currentStep) : "processing…");
    const foot = currentStep ? formatStepName(currentStep) : currentItemId ?? "running…";
    return { subline: sub, footerStep: foot };
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
 * Mono-pill stop button. Matches the elapsed-time pill family (same
 * height, mono font, same border radius) so the right-stack reads as one
 * visual unit. A click sends force-stop semantics immediately so stopped
 * daemons, browser processes, stale sessions, and queued rows clear in one
 * action.
 */
function StopPill({
  workflow,
  instance,
  totalDaemonCount,
}: {
  workflow: string;
  instance: string;
  /** Total alive daemons for this workflow (across all instance cards).
   * When >1, the stop click tears down EVERY daemon — the label and confirm
   * dialog reflect that blast radius truthfully so the operator can't
   * accidentally over-stop. */
  totalDaemonCount: number;
}) {
  const [sending, setSending] = useState(false);

  const postStop = async () => {
    if (totalDaemonCount > 1) {
      const ok = window.confirm(
        `Stop ALL ${totalDaemonCount} ${workflow} daemons?\n\n` +
          `The /api/daemon/stop endpoint is workflow-scoped, not per-card. ` +
          `Clicking the stop button on this single card will tear down every ` +
          `${workflow} daemon currently alive — including any in-flight items.`,
      );
      if (!ok) return;
    }
    setSending(true);
    const toastId = toast.loading(`Stopping ${workflow}…`);
    try {
      const res = await fetch("/api/daemon/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, force: true }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        stopped?: number;
        daemonsStopped?: number;
        processesKilled?: number;
        browsersKilled?: number;
        queuedCancelled?: number;
        phantomsCleared?: number;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        toast.error(`Couldn't stop ${workflow}`, { id: toastId, description: json.error ?? `HTTP ${res.status}` });
        return;
      }
      const daemons = json.daemonsStopped ?? 0;
      const procs = json.processesKilled ?? 0;
      const browsers = json.browsersKilled ?? 0;
      const queued = json.queuedCancelled ?? 0;
      const phantoms = json.phantomsCleared ?? 0;
      const total = json.stopped ?? daemons + procs;
      const parts: string[] = [];
      if (daemons > 0) parts.push(`${daemons} session${daemons === 1 ? "" : "s"}`);
      if (procs > 0) parts.push(`${procs} process${procs === 1 ? "" : "es"}`);
      if (browsers > 0) parts.push(`${browsers} browser${browsers === 1 ? "" : "s"}`);
      if (queued > 0) parts.push(`${queued} queued item${queued === 1 ? "" : "s"}`);
      if (phantoms > 0) parts.push(`${phantoms} stale session${phantoms === 1 ? "" : "s"}`);
      const detail = parts.length > 0 ? parts.join(" + ") : "nothing alive";
      if (total === 0 && queued === 0 && browsers === 0 && phantoms === 0) {
        toast.warning(`Nothing to stop — no active ${workflow} sessions, processes, browsers, or queued items`, { id: toastId });
      } else if (total === 0 && queued === 0 && browsers === 0 && phantoms > 0) {
        toast.success(
          `Cleared ${phantoms} stale ${workflow} session${phantoms === 1 ? "" : "s"} from the panel`,
          { id: toastId },
        );
      } else {
        toast.success(`Stop sent — ${detail} cleared`, { id: toastId });
      }
    } catch (err) {
      toast.error(`Couldn't stop ${workflow}`, { id: toastId, description: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const title = totalDaemonCount > 1
    ? `Stop ALL ${totalDaemonCount} ${workflow} daemons (workflow-scoped)`
    : `Stop the ${workflow} daemon now`;

  return (
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
      {totalDaemonCount > 1 ? `stop all ${totalDaemonCount}` : "stop"}
    </button>
  );
}

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
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
export function WorkflowBox({ workflow }: WorkflowBoxProps) {
  const {
    instance,
    workflow: workflowName,
    startedAt,
    active,
    pidAlive,
    currentItemId,
    currentTraceId,
    itemInFlight,
    currentStep,
    finalStatus,
    sessions,
    daemonPhase,
    ucpathIdle,
  } = workflow;
  const { focusedInstance, setFocusedInstance } = useTerminalDrawer();
  const meta = useWorkflow(workflowName ?? "");
  const queueDepth = useQueueDepth();
  const daemons = useDaemons();
  const elapsed = useElapsed(startedAt ?? null);
  const isFocused = focusedInstance === instance;
  // Total daemons currently alive for this card's workflow. Driven by
  // /api/daemons polling. Used by StopPill to make blast radius explicit
  // when multiple daemons share the workflow — the stop button hits
  // /api/daemon/stop which is workflow-scoped, not per-card. With a fresh
  // daemon name allocator (generateInstanceName) and the lockfile
  // self-heal in place, multi-daemon scenarios should each render as
  // their own WorkflowBox via the SSE sessions topic; this count guards
  // against the rare case where two daemons race the instance allocator
  // and aggregate visually.
  const totalDaemonsForWorkflow = workflowName
    ? daemons.filter((d) => d.workflow === workflowName).length
    : 0;

  const queued = workflowName ? queueDepth[workflowName] ?? 0 : 0;

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

  const browsers = sessions.flatMap((s) => s.browsers);
  const totalBrowsers = browsers.length;
  const authedBrowsers = browsers.filter((b) => b.authState === "authed").length;
  const { subline, footerStep } = deriveSessionCardCopy({
    active: !!active,
    finalStatus: finalStatus ?? null,
    itemInFlight: !!itemInFlight,
    currentItemId: currentItemId ?? null,
    currentStep: currentStep ?? null,
    authedBrowsers,
    totalBrowsers,
    daemonPhase,
    queued,
  });

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
      <div className="px-2.5 pt-2 pb-2.5 flex flex-col gap-2">
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
            {/* Subtitle: the running run's trace id (same id its queue row
                shows). Kept after the item completes; falls back to the phase
                subline for a daemon that's authenticating/idle with no run. */}
            <div
              className="mt-0.5 text-[10.5px] font-mono text-muted-foreground truncate leading-tight"
              title={currentTraceId ?? subline}
            >
              {currentTraceId ?? subline}
            </div>
          </div>

          {/* Right-stack: × stop on top, elapsed below. Both share width
              via min-w on the column so they read as one anchored unit. */}
          <div className="flex flex-col gap-1 items-stretch shrink-0 min-w-[64px]">
            {active && pidAlive && workflowName ? (
              <StopPill
                workflow={workflowName}
                instance={instance}
                totalDaemonCount={totalDaemonsForWorkflow}
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
                <div
                  key={b.browserId}
                  className={cn(
                    "rounded-md border px-1.5 py-1 min-w-0 transition-colors",
                    authBg[b.authState],
                  )}
                  title={
                    b.system === "ucpath" && b.authState === "authed" && ucpathIdle?.lastTouchAt
                      ? `${b.system} · ${authLabel[b.authState]} · idle page reload timer`
                      : `${b.system} · ${authLabel[b.authState]}`
                  }
                >
                  <div className="flex items-center gap-1 min-w-0 justify-between">
                    <div className="flex items-center gap-1 min-w-0">
                      <AuthIcon
                        state={b.authState}
                        className={cn("w-3 h-3 shrink-0", authColor[b.authState])}
                      />
                      <span className="text-[11px] font-mono text-foreground truncate leading-none">
                        {b.system}
                      </span>
                    </div>
                    {b.system === "ucpath" &&
                      b.authState === "authed" &&
                      !itemInFlight &&
                      ucpathIdle?.lastTouchAt != null &&
                      ucpathIdle.lastTouchAt.length > 0 && (
                        <UcpathIdleCountdownRing
                          lastTouchAt={ucpathIdle.lastTouchAt}
                          refreshing={!!ucpathIdle.refreshing}
                          cycling={active && !itemInFlight}
                        />
                      )}
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 text-[9.5px] uppercase tracking-wider font-semibold leading-none",
                      authColor[b.authState],
                    )}
                  >
                    {authLabel[b.authState]}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

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
    </div>
  );
}
