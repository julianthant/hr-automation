import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { BrowserChip } from "./BrowserChip";
import { formatStepName } from "./types";
import type { WorkflowInstanceState } from "./types";

/**
 * "End" button — soft-stops the daemon behind this WorkflowBox via
 * POST /api/daemon/stop. Only rendered when the daemon is still alive
 * AND we can resolve its kebab-case workflow name from the instance
 * label (the stop endpoint requires it).
 */
function EndDaemonButton({ workflow }: { workflow: string }) {
  const [sending, setSending] = useState(false);
  // Click once → soft stop. Click again within 4s → force stop. Resets after
  // the SSE flips `pidAlive` (component unmounts) or after a 4s fallback so
  // the button doesn't get stuck if the daemon is wedged in auth / Duo.
  const [confirmForce, setConfirmForce] = useState(false);

  const postStop = async (force: boolean) => {
    setSending(true);
    const toastId = toast.loading(force ? `Force-stopping ${workflow} daemon…` : `Stopping ${workflow} daemon…`);
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
        // Offer a force-kill escape hatch for 4s — useful when the daemon is
        // stuck in Session.launch / Duo and the soft-stop flag can't land.
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

  const label = sending ? "…" : confirmForce ? "Force?" : "End";
  const title = confirmForce
    ? `Click to hard-kill the ${workflow} daemon (abandons in-flight work)`
    : `Soft-stop the ${workflow} daemon (drain in-flight then exit)`;

  return (
    <button
      type="button"
      disabled={sending}
      onClick={() => postStop(confirmForce)}
      className="text-[10px] font-semibold uppercase tracking-wide text-destructive bg-destructive/10 hover:bg-destructive/20 border border-destructive/40 px-1.5 py-0.5 rounded transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      title={title}
    >
      {label}
    </button>
  );
}

interface WorkflowBoxProps {
  workflow: WorkflowInstanceState;
}

// Step/status pill styled like StepPipeline labels.
// Active + item running:   cyan pill with the doc/item currently being processed
// Active + idle:           dim "Idle" pill (daemon waiting for the next queued item)
// Active + no item event:  cyan pill with current step (legacy/non-daemon fallback)
// Done:                    green "DONE" pill
// Failed:                  red "FAILED" pill
// Fallback:                dim step-name pill when status is unknown
function StatusPill({
  active,
  currentStep,
  currentItemId,
  itemInFlight,
  finalStatus,
}: {
  active: boolean;
  currentStep: string | null;
  currentItemId: string | null;
  itemInFlight: boolean;
  finalStatus: "done" | "failed" | null;
}) {
  if (active && itemInFlight && currentItemId) {
    return (
      <span
        className="text-[10px] font-mono text-[#22d3ee] bg-[#06b6d41a] px-1.5 py-0.5 rounded truncate max-w-[160px]"
        title={currentItemId}
      >
        {currentItemId}
      </span>
    );
  }
  if (active && !itemInFlight) {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded">
        Idle
      </span>
    );
  }
  if (active && currentStep) {
    return (
      <span className="text-[10px] font-mono text-[#22d3ee] bg-[#06b6d41a] px-1.5 py-0.5 rounded">
        {formatStepName(currentStep)}
      </span>
    );
  }
  if (!active && finalStatus === "done") {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#4ade80] bg-[#4ade8012] px-1.5 py-0.5 rounded">
        Done
      </span>
    );
  }
  if (!active && finalStatus === "failed") {
    return (
      <span className="text-[10px] font-semibold uppercase tracking-wide text-destructive bg-destructive/12 px-1.5 py-0.5 rounded">
        Failed
      </span>
    );
  }
  // Fallback: show the last known step name (no generic "starting…" / "ended" label)
  if (currentStep) {
    return (
      <span className="text-[10px] font-mono text-[#6b7280] bg-[#6b72801a] px-1.5 py-0.5 rounded">
        {formatStepName(currentStep)}
      </span>
    );
  }
  return null;
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
      <div className="flex-shrink-0 border-[1.5px] border-destructive/30 rounded-lg p-1.5 bg-destructive/5">
        <div className="flex items-center gap-1 mb-0.5 px-0.5">
          <span className="w-[5px] h-[5px] rounded-full flex-shrink-0 bg-destructive" />
          <span className="text-[11px] font-semibold text-[#c4b5fd]">{instance}</span>
          <span className="flex-1" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-destructive bg-destructive/12 px-1.5 py-0.5 rounded">
            Launch failed
          </span>
        </div>
        <div className="px-0.5">
          <span className="text-[10px] italic text-destructive/80">
            Launch failed — check Queue row for details
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex-shrink-0 border-[1.5px] rounded-lg p-1.5 transition-opacity",
        active
          ? "border-[#7c3aed44] bg-[#7c3aed08]"
          : "border-[#7c3aed22] bg-[#7c3aed04] opacity-45",
      )}
    >
      {/* Header: dot + instance name + step/status pill */}
      <div className="flex items-center gap-1 mb-0.5 px-0.5">
        <span
          className={cn(
            "w-[5px] h-[5px] rounded-full flex-shrink-0",
            active ? "bg-[#4ade80]" : finalStatus === "failed" ? "bg-destructive" : "bg-[#444]",
          )}
        />
        <span className="text-[11px] font-semibold text-[#c4b5fd]">{instance}</span>
        <span className="flex-1" />
        <StatusPill
          active={active}
          currentStep={currentStep}
          currentItemId={currentItemId}
          itemInFlight={itemInFlight}
          finalStatus={finalStatus}
        />
        {active && pidAlive && workflowName && (
          <EndDaemonButton workflow={workflowName} />
        )}
      </div>

      {/* Current step — only shown when the pill is occupied by a doc ID (item in flight) */}
      {active && itemInFlight && currentItemId && currentStep && (
        <div className="px-0.5 mb-1">
          <span className="text-[10px] font-mono text-[#a78bfa] truncate block">
            {formatStepName(currentStep)}
          </span>
        </div>
      )}

      {/* Session boxes — internal sessionId is intentionally not rendered (it's a debug identifier) */}
      <div className="flex gap-1">
        {sessions.map((sess) => (
          <div
            key={sess.sessionId}
            className="border-[1.5px] border-[#2563eb28] rounded-md p-1 bg-[#2563eb06]"
          >
            <div className="flex gap-0.5 flex-wrap">
              {sess.browsers.map((b) => (
                <BrowserChip key={b.browserId} system={b.system} authState={b.authState} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
