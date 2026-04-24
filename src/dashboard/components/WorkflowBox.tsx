import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Check, X, KeyRound, Loader2, Hourglass, Square, CircleX } from "lucide-react";
import type { AuthState, WorkflowInstanceState } from "./types";
import { formatStepName } from "./types";

/**
 * Soft-stops the daemon behind this WorkflowBox via POST /api/daemon/stop.
 * Click once → soft stop. Click again within 4s → force stop. Resets on
 * SSE `pidAlive` flip (component unmounts) or after a 4s fallback so the
 * button doesn't get stuck if the daemon is wedged in auth / Duo.
 */
function EndDaemonButton({ workflow }: { workflow: string }) {
  const [sending, setSending] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);

  const postStop = async (force: boolean) => {
    setSending(true);
    const toastId = toast.loading(
      force ? `Force-stopping ${workflow} daemon…` : `Stopping ${workflow} daemon…`,
    );
    try {
      const res = await fetch("/api/daemon/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow, force }),
      });
      const json = (await res.json()) as { ok: boolean; stopped?: number; error?: string };
      if (!res.ok || !json.ok) {
        toast.error(`Failed to stop daemon: ${json.error ?? `HTTP ${res.status}`}`, { id: toastId });
        return;
      }
      toast.success(
        force
          ? `Force-stop sent — ${json.stopped ?? 0} daemon(s) killed`
          : `Soft-stop sent — ${json.stopped ?? 0} daemon(s) will drain and exit`,
        { id: toastId },
      );
      if (!force) {
        setConfirmForce(true);
        setTimeout(() => setConfirmForce(false), 4_000);
      } else {
        setConfirmForce(false);
      }
    } catch (err) {
      toast.error(`Failed to stop daemon: ${(err as Error).message}`, { id: toastId });
    } finally {
      setSending(false);
    }
  };

  const title = confirmForce
    ? `Click to hard-kill the ${workflow} daemon (abandons in-flight work)`
    : `Soft-stop the ${workflow} daemon (drain in-flight then exit)`;
  const Icon = confirmForce ? CircleX : Square;

  return (
    <button
      type="button"
      disabled={sending}
      onClick={() => postStop(confirmForce)}
      className={cn(
        "w-6 h-6 inline-flex items-center justify-center rounded-md transition-colors flex-shrink-0",
        "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
        confirmForce && "text-destructive bg-destructive/10 ring-1 ring-destructive/40",
        "disabled:opacity-50 disabled:cursor-not-allowed",
      )}
      title={title}
      aria-label={title}
    >
      {sending ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Icon className="w-3.5 h-3.5" strokeWidth={2.25} />
      )}
    </button>
  );
}

/* ----------------------------------------------------------------------
 * Auth-state visual tokens. Single source of truth for every system
 * tile so colors, icons, and labels never drift between surfaces.
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

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
}

export function WorkflowBox({ workflow }: WorkflowBoxProps) {
  const {
    instance,
    workflow: workflowName,
    active,
    pidAlive,
    currentItemId,
    itemInFlight,
    currentStep,
    finalStatus,
    sessions,
  } = workflow;

  if (workflow.crashedOnLaunch) {
    return (
      <div className="flex-shrink-0 rounded-xl border border-destructive/30 bg-destructive/5 p-2.5">
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
      ? currentStep
        ? `${currentItemId} · ${formatStepName(currentStep)}`
        : currentItemId
      : authedBrowsers === totalBrowsers && totalBrowsers > 0
        ? "Ready · waiting for next item"
        : `Authenticating ${authedBrowsers}/${totalBrowsers}`;

  const statusDot = !active
    ? finalStatus === "failed"
      ? "bg-destructive"
      : "bg-muted-foreground/60"
    : itemInFlight
      ? "bg-[#22d3ee] animate-pulse"
      : authedBrowsers === totalBrowsers && totalBrowsers > 0
        ? "bg-[#4ade80]"
        : "bg-[#60a5fa] animate-pulse";

  return (
    <div
      className={cn(
        "flex-shrink-0 rounded-xl border bg-card/60 transition-opacity",
        active ? "border-border shadow-[0_0_0_1px_rgba(167,139,250,0.06)]" : "border-border/50 opacity-55",
      )}
    >
      <div className="px-2.5 pt-2 pb-2.5">
        {/* Header: dot + title/subline stack + End icon */}
        <div className="flex items-start gap-2 min-w-0">
          <span className={cn("w-2 h-2 rounded-full flex-shrink-0 mt-1.5", statusDot)} />
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold text-foreground leading-tight truncate">
              {instance}
            </div>
            <div
              className="mt-0.5 text-[10.5px] font-mono text-muted-foreground truncate leading-tight"
              title={subline}
            >
              {subline}
            </div>
          </div>
          {active && pidAlive && workflowName && <EndDaemonButton workflow={workflowName} />}
        </div>

        {/* 2×2 grid of system tiles — each browser is a tile with icon,
            system name, and uppercase state caption. Tile border color
            encodes auth state so the grid is scannable at a glance. */}
        {browsers.length > 0 && (
          <div className="mt-2 grid grid-cols-2 gap-1">
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
      </div>
    </div>
  );
}
