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
import type { AuthState, WorkflowInstanceState } from "./types";
import { formatStepName } from "./types";
import { useElapsed } from "./hooks/useElapsed";
import { useTerminalDrawer } from "./hooks/useTerminalDrawer";
import { useQueueDepth } from "./hooks/useQueueDepth";
import { useWorkflow } from "../workflows-context";
import { getWorkflowIcon } from "@/lib/workflow-icons";

/* ----------------------------------------------------------------------
 * Auth-state visual tokens. Single source of truth for every system tile
 * so colors, icons, and labels never drift between surfaces.
 * -------------------------------------------------------------------- */
const authColor: Record<AuthState, string> = {
  idle: "text-muted-foreground",
  authenticating: "text-[#60a5fa]",
  authed: "text-[#4ade80]",
  duo_waiting: "text-[#fbbf24]",
  failed: "text-[#f87171]",
};

const authBg: Record<AuthState, string> = {
  idle: "bg-muted/20 border-border/60",
  authenticating: "bg-[#2563eb]/10 border-[#2563eb]/30",
  authed: "bg-[#16a34a]/10 border-[#16a34a]/30",
  duo_waiting: "bg-[#eab308]/10 border-[#eab308]/40 animate-duo-glow",
  failed: "bg-[#ef4444]/10 border-[#ef4444]/40",
};

const authLabel: Record<AuthState, string> = {
  idle: "Pending",
  authenticating: "Authing",
  authed: "Ready",
  duo_waiting: "Duo",
  failed: "Failed",
};

function AuthIcon({ state, className }: { state: AuthState; className?: string }) {
  const cls = cn("w-3 h-3", className);
  switch (state) {
    case "authed":
      return <Check className={cls} strokeWidth={3} />;
    case "authenticating":
      return <Loader2 className={cn(cls, "animate-spin")} />;
    case "duo_waiting":
      return <KeyRound className={cls} />;
    case "failed":
      return <X className={cls} strokeWidth={3} />;
    default:
      return <Hourglass className={cls} />;
  }
}

/**
 * Mono-pill stop button. Matches the elapsed-time pill family (same
 * height, mono font, same border radius) so the right-stack reads as one
 * visual unit. Two-click confirm: first click → soft-stop POST, second
 * click within 4s → force-stop POST. Mirrors the legacy EndDaemonButton's
 * server contract (`/api/daemon/stop`) so any wiring outside this
 * component keeps working.
 */
function StopPill({ workflow, instance }: { workflow: string; instance: string }) {
  const [sending, setSending] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);

  const postStop = async (force: boolean) => {
    setSending(true);
    const toastId = toast.loading(
      force ? `Force-stopping ${workflow}…` : `Stopping ${workflow}…`,
    );
    try {
      const res = await fetch("/api/daemon/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, force }),
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
      if (daemons > 0) parts.push(`${daemons} worker${daemons === 1 ? "" : "s"}`);
      if (procs > 0) parts.push(`${procs} process${procs === 1 ? "" : "es"}`);
      if (browsers > 0) parts.push(`${browsers} browser${browsers === 1 ? "" : "s"}`);
      if (queued > 0) parts.push(`${queued} queued item${queued === 1 ? "" : "s"}`);
      if (phantoms > 0) parts.push(`${phantoms} stale session${phantoms === 1 ? "" : "s"}`);
      const detail = parts.length > 0 ? parts.join(" + ") : "nothing alive";
      if (total === 0 && queued === 0 && browsers === 0 && phantoms === 0) {
        toast.warning(`Nothing to stop — no active ${workflow} workers, processes, browsers, or queued items`, { id: toastId });
      } else if (total === 0 && queued === 0 && browsers === 0 && phantoms > 0) {
        toast.success(
          `Cleared ${phantoms} stale ${workflow} session${phantoms === 1 ? "" : "s"} from the panel`,
          { id: toastId },
        );
      } else {
        toast.success(
          force
            ? `Force-stop sent — ${detail} cleared`
            : `Soft-stop sent — ${detail} will drain and exit`,
          { id: toastId },
        );
      }
      if (!force) {
        setConfirmForce(true);
        setTimeout(() => setConfirmForce(false), 4_000);
      } else {
        setConfirmForce(false);
      }
    } catch (err) {
      toast.error(`Couldn't stop ${workflow}`, { id: toastId, description: (err as Error).message });
    } finally {
      setSending(false);
    }
  };

  const label = confirmForce ? "kill" : "stop";
  const title = confirmForce
    ? `Click again to hard-kill the ${workflow} daemon (abandons in-flight work)`
    : `Soft-stop the ${workflow} daemon (drain in-flight then exit)`;

  return (
    <button
      type="button"
      disabled={sending}
      onClick={(e) => {
        e.stopPropagation();
        void postStop(confirmForce);
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
        // Confirm-force state: filled + ring pulse
        confirmForce &&
          "bg-[hsl(0_84%_60%/0.12)] text-[hsl(0_84%_78%)] border-[hsl(0_84%_60%/0.55)] animate-stop-confirm",
        sending && "opacity-60 cursor-wait",
      )}
    >
      {sending ? (
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
      ) : (
        <span aria-hidden className="text-[11px] leading-none opacity-90">×</span>
      )}
      {label}
    </button>
  );
}

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
}

/**
 * Horizontal session card rendered inside `TerminalDrawer`. The visual
 * contract mirrors the production `WorkflowBox` (rounded-xl, dot, title,
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
    itemInFlight,
    currentStep,
    finalStatus,
    sessions,
  } = workflow;
  const { focusedInstance, setFocusedInstance } = useTerminalDrawer();
  const meta = useWorkflow(workflowName ?? "");
  const queueDepth = useQueueDepth();
  const elapsed = useElapsed(startedAt ?? null);
  const isFocused = focusedInstance === instance;

  if (workflow.crashedOnLaunch) {
    return (
      <div
        className={cn(
          "flex-shrink-0 w-[290px] rounded-xl border border-destructive/30 bg-destructive/5 p-2.5",
          "flex flex-col cursor-pointer transition-colors",
          isFocused && "ring-1 ring-primary",
        )}
        onClick={() => setFocusedInstance(instance)}
      >
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-destructive" />
          <span className="text-[14px] font-semibold text-foreground truncate flex-1">{instance}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive">
            Launch failed
          </span>
        </div>
        <p className="mt-1 text-[10.5px] text-destructive/80 leading-tight">
          Check Queue row for details
        </p>
      </div>
    );
  }

  const browsers = sessions.flatMap((s) => s.browsers);
  const totalBrowsers = browsers.length;
  const authedBrowsers = browsers.filter((b) => b.authState === "authed").length;
  const subline = !active
    ? finalStatus === "failed"
      ? "Run failed"
      : finalStatus === "done"
        ? "Run complete"
        : "Daemon ended"
    : itemInFlight && currentItemId
      ? currentItemId
      : authedBrowsers === totalBrowsers && totalBrowsers > 0
        ? "Ready · waiting for next item"
        : `Authenticating ${authedBrowsers}/${totalBrowsers}`;

  // Status dot color follows the existing rules — running = cyan pulse,
  // ready = green, authing = blue pulse, failed = destructive, ended = grey.
  const statusDot = !active
    ? finalStatus === "failed"
      ? "bg-destructive"
      : "bg-muted-foreground/60"
    : itemInFlight
      ? "bg-[#22d3ee] animate-pulse"
      : authedBrowsers === totalBrowsers && totalBrowsers > 0
        ? "bg-[#4ade80]"
        : "bg-[#60a5fa] animate-pulse";

  // Card border tint reflects "current state" — in-flight cards get a
  // subtle cyan ring so an operator can pick out the working session
  // among many at a glance. Focused trumps in-flight (primary ring).
  const borderClass = isFocused
    ? "border-primary shadow-[0_0_0_1px_hsl(var(--primary)/0.6),0_0_14px_hsl(var(--primary)/0.18)]"
    : itemInFlight && active
      ? "border-[#22d3ee]/30 shadow-[0_0_0_1px_rgba(34,211,238,0.10)]"
      : "border-border";

  // Footer right slot — current step in mono, color-coded by lifecycle
  // family. Falls back to the same subline copy when no step is set.
  const stepLabel = !active
    ? finalStatus === "done"
      ? "complete"
      : finalStatus === "failed"
        ? "failed"
        : "ended"
    : currentStep
      ? formatStepName(currentStep)
      : authedBrowsers === totalBrowsers && totalBrowsers > 0
        ? "idle · waiting"
        : "authenticating";

  const stepClass = !active
    ? "text-muted-foreground"
    : itemInFlight
      ? "text-[#22d3ee]"
      : currentStep && /auth/i.test(currentStep)
        ? "text-[#60a5fa]"
        : authedBrowsers === totalBrowsers && totalBrowsers > 0
          ? "text-muted-foreground"
          : "text-[#60a5fa]";

  // Workflow icon — resolved from the registry's `iconName` declaration,
  // with a generic `Workflow` fallback + console.warn for missing entries.
  const Icon = getWorkflowIcon(meta?.iconName);

  // Queue depth for this workflow (per-workflow scope; shows aggregate
  // queue not just this daemon's slice — fine for at-a-glance signal).
  const queued = workflowName ? queueDepth[workflowName] ?? 0 : 0;

  // Step list for micro pipeline — pulled from registry. Cap at ~10 dots
  // so wide step lists don't blow out the card. Highlight current step.
  const steps = meta?.steps ?? [];
  const currentIdx = currentStep ? steps.findIndex((s) => s === currentStep) : -1;

  return (
    <div
      className={cn(
        "flex-shrink-0 w-[290px] rounded-xl border bg-card/60 transition-[border-color,box-shadow,opacity]",
        "flex flex-col cursor-pointer",
        active ? "" : "opacity-55",
        borderClass,
      )}
      onClick={() => setFocusedInstance(isFocused ? null : instance)}
      role="article"
      aria-label={`${instance} session`}
    >
      <div className="px-2.5 pt-2 pb-2.5 flex flex-col gap-2 flex-1">
        {/* Header: dot + (icon + title + subline) + right-stack */}
        <div className="flex items-start gap-2 min-w-0">
          <span className={cn("w-2 h-2 rounded-full flex-shrink-0 mt-1.5", statusDot)} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <Icon
                aria-hidden
                className="w-3 h-3 flex-shrink-0 text-muted-foreground"
                strokeWidth={2}
              />
              <span
                className="text-[14px] font-semibold text-foreground leading-tight truncate"
                title={instance}
              >
                {instance}
              </span>
            </div>
            <div
              className="mt-0.5 text-[10.5px] font-mono text-muted-foreground truncate leading-tight"
              title={subline}
            >
              {subline}
            </div>
          </div>

          {/* Right-stack: × stop on top, elapsed below. Both share width
              via min-w on the column so they read as one anchored unit. */}
          <div className="flex flex-col gap-1 items-stretch flex-shrink-0 min-w-[64px]">
            {active && pidAlive && workflowName ? (
              <StopPill workflow={workflowName} instance={instance} />
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

        {/* 2×2 grid of system tiles (existing visual contract preserved). */}
        {browsers.length > 0 && (
          <div className="grid grid-cols-2 gap-1">
            {browsers.map((b) => (
              <div
                key={b.browserId}
                className={cn(
                  "rounded-md border px-1.5 py-1 min-w-0 transition-colors",
                  authBg[b.authState],
                )}
                title={`${b.system} · ${authLabel[b.authState]}`}
              >
                <div className="flex items-center gap-1 min-w-0">
                  <AuthIcon
                    state={b.authState}
                    className={cn("w-3 h-3 flex-shrink-0", authColor[b.authState])}
                  />
                  <span className="text-[11px] font-mono text-foreground truncate leading-none">
                    {b.system}
                  </span>
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

        {/* Micro step pipeline — small dots showing lifecycle position
            for the instance's current step. Only renders when we have
            both a registered step list and at least 2 steps. */}
        {steps.length >= 2 && (
          <div className="flex items-center gap-0 mt-auto pt-1" aria-hidden>
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
                      "w-1.5 h-1.5 rounded-full flex-shrink-0",
                      done && "bg-[#4ade80]/85",
                      running && "bg-primary shadow-[0_0_0_2px_rgba(184,135,82,0.18)]",
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
