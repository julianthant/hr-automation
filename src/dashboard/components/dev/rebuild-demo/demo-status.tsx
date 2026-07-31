import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";
import { DS_STATUS, StatusPill, dsStatusText, dsText, type DsStatus } from "./demo-ui";
// TYPE-ONLY: `demo-wire` imports `ProposedStatus` from this file, so a value
// import here would close a runtime cycle. This one is erased at compile.
import type { MemberOutcomeSpec } from "./demo-wire";

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
   * Color alone — for a parent that wraps icon + text. Never put `iconClass`
   * on that parent: it includes Running's rotation utility and would orbit the
   * digit around the glyph.
   */
  soloTone: string;
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
        soloTone: spec.soloTone,
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

/**
 * A member's OUTCOME — what its run found — as a word in a column.
 *
 * Status and outcome are orthogonal axes and this is the component that keeps
 * them apart. A member can be `Done` with the outcome `Not found`,
 * because looking and finding nothing is a successful run with a negative
 * answer, so an outcome is deliberately NEVER a `StatusPill`: putting a
 * negative answer in status chrome is exactly how `Done · Not found`
 * comes to read as a failure. It is a word, the word is always the
 * differentiator, and the tone only decides how loudly it is said.
 *
 * It lives here rather than in either consumer because BOTH the queue's member
 * lines and the Log Panel's People tab render it, and the People tab spent a
 * wave rendering the old free-text `memberFact` instead — which is how the
 * crammed `S1 + S2 · retain 3y` strings survived the vocabulary that replaced
 * them. One renderer, one place to change the ladder.
 */
const MEMBER_OUTCOME_TONE: Record<MemberOutcomeSpec["tone"], string> = {
  danger: "font-medium text-[color:var(--ds-status-failed-fg)]",
  warn: "font-medium text-[color:var(--ds-status-waiting-fg)]",
  neutral: "text-[color:var(--ds-fg-secondary)]",
  quiet: "text-[color:var(--ds-fg-muted)]",
};

export function MemberOutcomeWord({
  outcome,
  className,
}: {
  outcome: MemberOutcomeSpec;
  className?: string;
}) {
  return (
    <span title={outcome.meaning} className={cn(dsText.meta, "min-w-0 truncate", MEMBER_OUTCOME_TONE[outcome.tone], className)}>
      {outcome.label}
    </span>
  );
}

/**
 * The em dash a member shows in the outcome column before it has answered.
 *
 * A blank cell reads as a value that failed to render; an em dash reads as
 * "nothing yet". The free-text detail is deliberately NOT dropped in here — a
 * column headed `Outcome` holding `person-lookup…` is the two-axes-in-one-column
 * defect the vocabulary exists to end.
 */
export function MemberOutcomePending({ className }: { className?: string }) {
  return <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-faint)]", className)}>—</span>;
}
