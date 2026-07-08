/**
 * Pure display-mapping for an OCR record's `matchConfidence` (0–1, stamped by
 * `applyDisambiguationStd` in `src/services/ocr/forms/shared.ts` for an
 * LLM-disambiguated EID, or a roster-candidate score). Extracted so the
 * confidence→tier bucketing is unit-tested once and shared by every renderer
 * that shows a confidence badge (Oath/EC editable cards, the read-only
 * verify-style checklist).
 *
 * Thresholds: `high` starts at the backend's own `LLM_HIGH_CONFIDENCE` cutoff
 * (0.6) — below that the server never auto-resolves to `matched` and always
 * attaches a review warning, so a confidence below 0.6 must never read as
 * "high" here. `low` further isolates near-coin-flip picks (<0.4) so those
 * are visually distinct from a borderline 0.4–0.6 pick.
 */
export type MatchConfidenceTier = "high" | "medium" | "low";

const HIGH_CONFIDENCE_THRESHOLD = 0.6;
const LOW_CONFIDENCE_THRESHOLD = 0.4;

export function matchConfidenceTier(confidence: number): MatchConfidenceTier {
  if (!Number.isFinite(confidence)) return "low";
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (confidence >= LOW_CONFIDENCE_THRESHOLD) return "medium";
  return "low";
}

/** Tone classes matching the existing badge pattern (`PrepRecordWorkflowStatusBadge`). */
const TIER_BADGE_CLASS: Record<MatchConfidenceTier, string> = {
  high: "border-success/40 bg-success/10 text-success",
  medium: "border-warning/40 bg-warning/10 text-warning",
  low: "border-destructive/40 bg-destructive/10 text-destructive",
};

export function matchConfidenceBadgeClass(tier: MatchConfidenceTier): string {
  return TIER_BADGE_CLASS[tier];
}

const TIER_LABEL: Record<MatchConfidenceTier, string> = {
  high: "high",
  medium: "medium",
  low: "low",
};

export function matchConfidenceTierLabel(tier: MatchConfidenceTier): string {
  return TIER_LABEL[tier];
}

/** Renders e.g. `0.4` -> `"40%"`. Clamps to [0, 1] before formatting so a
 * malformed value (out-of-range, never expected past the Zod schema) still
 * renders something sane instead of "-12%"/"140%". */
export function formatMatchConfidencePercent(confidence: number): string {
  const clamped = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
  return `${Math.round(clamped * 100)}%`;
}
