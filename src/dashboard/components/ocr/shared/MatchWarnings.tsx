import { cn } from "@/lib/utils";
import {
  formatMatchConfidencePercent,
  matchConfidenceBadgeClass,
  matchConfidenceTier,
} from "./match-confidence";

/**
 * Confidence badge for an auto-matched record — same visual language as
 * `PrepRecordWorkflowStatusBadge` (`PrepReviewFormCard.tsx`): a small
 * rounded/bordered chip toned by tier (success/warning/destructive).
 */
export function MatchConfidenceBadge({ confidence }: { confidence: number }) {
  const tier = matchConfidenceTier(confidence);
  return (
    <span
      title={`Automated match confidence: ${formatMatchConfidencePercent(confidence)}`}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        matchConfidenceBadgeClass(tier),
      )}
    >
      Match confidence {formatMatchConfidencePercent(confidence)}
    </span>
  );
}

export interface MatchWarningsProps {
  matchState?: string;
  warnings?: string[];
  matchConfidence?: number;
}

/**
 * Low-confidence-match warning line + confidence badge, shared by the
 * editable Oath/EC cards (`OathRecordView`/`EcRecordView` — the cards an
 * operator actually approves from) and the read-only checklist
 * (`VerifyRecordView`, also the approved-record audit path via
 * `readonly-record.ts`). Mirrors the warning-line classes `VerifyRecordView`
 * used before this was extracted (same `text-xs text-muted-foreground/80`
 * treatment) so all three surfaces read identically; adds the confidence
 * badge so a low-confidence auto-match is visually salient — not just a line
 * of muted text — exactly where the operator can approve a wrong EID.
 */
export function MatchWarnings({ matchState, warnings, matchConfidence }: MatchWarningsProps) {
  const hasWarnings = matchState === "unresolved" || (warnings?.length ?? 0) > 0;
  const hasConfidence = typeof matchConfidence === "number";
  if (!hasWarnings && !hasConfidence) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {hasConfidence && <MatchConfidenceBadge confidence={matchConfidence} />}
      {hasWarnings && (
        <div className="text-xs text-muted-foreground/80">
          {matchState === "unresolved" && <span className="mr-2">Could not resolve employee.</span>}
          {warnings?.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}
    </div>
  );
}
