import { AlertTriangle, CheckCircle2, Clock, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The shared per-status count tally — a status ICON + number per status, with
 * NO text label. The icon shape (not just color) carries the meaning, so each
 * count is self-explanatory and reuses the exact iconography of the rows it
 * summarizes (EntryItem / member rows). Used by every queue surface that
 * summarizes member status (batch group cards, operation coordinator rows) so
 * the treatment can't drift.
 *
 * Renders a fragment of `<span>`s, not a wrapper — the caller owns the flex
 * row (gap / font / nowrap) and can append trailing content (e.g. a count
 * badge) in the same row. Each count keeps an `aria-label` ("1 done") so screen
 * readers still get the status.
 */
export interface StatusCountValues {
  done: number;
  running: number;
  queued: number;
  failed: number;
}

interface CountSpec {
  key: keyof StatusCountValues;
  label: string;
  icon: LucideIcon;
  tone: string;
  spin?: boolean;
}

const COUNT_SPECS: CountSpec[] = [
  { key: "done", label: "done", icon: CheckCircle2, tone: "text-success" },
  { key: "running", label: "running", icon: Loader2, tone: "text-primary", spin: true },
  { key: "queued", label: "queued", icon: Clock, tone: "text-warning" },
  { key: "failed", label: "failed", icon: AlertTriangle, tone: "text-destructive" },
];

function StatusCount({ spec, n }: { spec: CountSpec; n: number }) {
  const Icon = spec.icon;
  return (
    <span
      aria-label={`${n} ${spec.label}`}
      className={cn("inline-flex shrink-0 items-center gap-1 whitespace-nowrap tabular-nums", spec.tone)}
    >
      <Icon
        aria-hidden
        className={cn("size-3", spec.spin && "animate-spin motion-reduce:animate-none")}
      />
      {n}
    </span>
  );
}

export function StatusCounts({
  counts,
  /** Show done/running/queued even when 0 (failed always hides at 0). */
  includeZeros = true,
}: {
  counts: StatusCountValues;
  includeZeros?: boolean;
}) {
  return (
    <>
      {COUNT_SPECS.map((spec) => {
        const n = counts[spec.key];
        // `failed` only ever shows when non-zero; the others honor includeZeros.
        if (spec.key === "failed" ? n <= 0 : !includeZeros && n <= 0) return null;
        return <StatusCount key={spec.key} spec={spec} n={n} />;
      })}
    </>
  );
}
