import type { ComponentType, SVGProps } from "react";
import { AlertTriangle, Ban, CheckCircle2, Clock, Loader2, PauseCircle, UserRoundSearch } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * DEV-ONLY — the eight ratified queue statuses and their chip.
 *
 * This is the whole status vocabulary of the rebuild. It replaces today's
 * six near-identical status→icon/tone maps and the three resolvers that decode
 * status out of `step` strings (`failed` + `step:"cancelled"` = Cancelled,
 * `running` + `step:"awaiting-approval"` = needs review, and so on). Here a
 * status is a value, not something inferred.
 *
 * Moved out of the retired `dev/proposals/` folder — the demo is the surface
 * of record now.
 */

export type ProposedStatus =
  | "queued"
  | "running"
  | "waiting"
  | "parked"
  | "verifiedDone"
  | "doneWarnings"
  | "failed"
  | "cancelled";

interface ProposedStatusSpec {
  label: string;
  badge: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  iconClass: string;
  /** what this status means for the operator — shown in the gallery */
  meaning: string;
}

export const PROPOSED_STATUS: Record<ProposedStatus, ProposedStatusSpec> = {
  queued: {
    label: "Queued",
    badge: "bg-warning/12 text-warning border border-warning/30",
    icon: Clock,
    iconClass: "text-warning",
    meaning: "Accepted, nothing has run. Can be bumped or cancelled.",
  },
  running: {
    label: "Running",
    badge: "bg-primary/15 text-primary border border-primary/30",
    icon: Loader2,
    iconClass: "text-primary animate-spin motion-reduce:animate-none",
    meaning: "A worker owns it right now. Only cancel is offered.",
  },
  waiting: {
    label: "Waiting on you",
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: UserRoundSearch,
    iconClass: "text-warning",
    meaning: "Stopped at a gate for a decision. Nothing is written until you answer.",
  },
  parked: {
    label: "Write parked",
    badge: "bg-log-violet/12 text-log-violet border border-log-violet/35",
    icon: PauseCircle,
    iconClass: "text-log-violet",
    meaning: "A write may or may not have landed. Never auto-retried — you resolve present or absent.",
  },
  verifiedDone: {
    label: "Verified done",
    badge: "bg-success/12 text-success border border-success/30",
    icon: CheckCircle2,
    iconClass: "text-success",
    meaning: "Finished AND read back from the system. The receipt carries the proof.",
  },
  doneWarnings: {
    label: "Done with warnings",
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: CheckCircle2,
    iconClass: "text-warning",
    meaning: "Finished, but something needs your eyes — a fallback, a gap, a rejected page.",
  },
  failed: {
    label: "Failed",
    badge: "bg-destructive/12 text-destructive border border-destructive/30",
    icon: AlertTriangle,
    iconClass: "text-destructive",
    meaning: "Stopped on an error. Retry replays the same input.",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-warning/12 text-warning border border-warning/40",
    icon: Ban,
    iconClass: "text-warning",
    meaning: "You stopped it. Amber, not red — a deliberate act is not a failure.",
  },
};

/**
 * A collapsed row must say how OLD the decision is, not just that there is one.
 * "Waiting on you" is a state; "Waiting on you · 10m" is a priority — it is the
 * difference between a queue you scan and a queue you triage.
 */
export function statusText(status: ProposedStatus, age?: string): string {
  const base = PROPOSED_STATUS[status].label;
  return age ? `${base} · ${age}` : base;
}

export function StatusBadge({ status, label, age }: { status: ProposedStatus; label?: string; age?: string }) {
  const spec = PROPOSED_STATUS[status];
  return (
    <span className={cn("shrink-0 rounded-md px-2 py-0.5 font-sans text-[10px] font-medium tracking-wide", spec.badge)}>
      {label ?? statusText(status, age)}
    </span>
  );
}
