import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";
import { DS_STATUS, StatusPill, dsStatusText, type DsStatus } from "./demo-ui";

/**
 * DEV-ONLY — the eight ratified queue statuses, as the shell consumes them.
 *
 * This is the whole status vocabulary of the rebuild. It replaces today's
 * six near-identical status→icon/tone maps and the three resolvers that decode
 * status out of `step` strings (`failed` + `step:"cancelled"` = Cancelled,
 * `running` + `step:"awaiting-approval"` = needs review, and so on). Here a
 * status is a value, not something inferred.
 *
 * It is now an ADAPTER, not a second opinion. Until 2026-07-26 this file
 * carried its own hue/icon table, and it had drifted from the ratified one in
 * `ds/primitives-status.tsx` (DESIGN.md's table) on three of the eight:
 * Queued and Cancelled were amber, and Running was the near-white primary.
 * The result on screen was four statuses — Waiting on you, Queued, Done with
 * warnings and Cancelled — wearing one indistinguishable amber tint, which is
 * exactly the failure the four-channel separation exists to prevent. Every
 * name below now resolves through `DS_STATUS`, so the queue chip, the Status
 * Bar pill, the rail and the catalog cannot disagree about what a status is.
 */

export type ProposedStatus = DsStatus;

interface ProposedStatusSpec {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /**
   * The icon's class when it is rendered ALONE on a panel surface (a row's
   * leading glyph), spin included. Not the in-chip tone — see `soloTone`.
   */
  iconClass: string;
  /** what this status means for the operator — shown in the gallery */
  meaning: string;
}

export const PROPOSED_STATUS: Record<ProposedStatus, ProposedStatusSpec> = Object.fromEntries(
  (Object.keys(DS_STATUS) as ProposedStatus[]).map((status) => {
    const spec = DS_STATUS[status];
    return [
      status,
      {
        label: spec.label,
        icon: spec.icon,
        iconClass: cn(spec.soloTone, spec.spin && "animate-spin motion-reduce:animate-none"),
        meaning: spec.meaning,
      },
    ];
  }),
) as Record<ProposedStatus, ProposedStatusSpec>;

/**
 * A collapsed row must say how OLD the decision is, not just that there is one.
 * "Waiting on you" is a state; "Waiting on you · 10m" is a priority — it is the
 * difference between a queue you scan and a queue you triage.
 */
export function statusText(status: ProposedStatus, age?: string): string {
  return dsStatusText(status, age);
}

/**
 * The row-level status chip. A thin wrapper over the one ratified `StatusPill`
 * so a status can never be rendered two ways: `hideIcon` is for the places that
 * already lead with this exact glyph, and `label` is only ever "Rejected" — a
 * record that never became work and therefore has no status of its own.
 */
export function StatusBadge({
  status,
  label,
  age,
  hideIcon,
}: {
  status: ProposedStatus;
  label?: string;
  age?: string;
  hideIcon?: boolean;
}) {
  return <StatusPill status={status} label={label} age={age} size="sm" hideIcon={hideIcon} />;
}
