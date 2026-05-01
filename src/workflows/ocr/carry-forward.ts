/**
 * Pure function: given v1 records (from a previous OCR run on the same
 * sessionId) and v2 records (fresh OCR output), inherit resolved fields
 * from v1 onto v2 by fuzzy-matching on `spec.carryForwardKey()`.
 *
 * Drops carry-forward when v1 record has `forceResearch === true` (set by
 * the operator's per-row ↻ click in the prior version).
 */
import { levenshteinDistance } from "../../match/index.js";
import type { AnyOcrFormSpec } from "./types.js";

const FUZZY_THRESHOLD = 2;

export interface ApplyCarryForwardInput<TPreview> {
  v2Records: TPreview[];
  v1Records: TPreview[];
  spec: AnyOcrFormSpec;
}

export function applyCarryForward<TPreview>(
  input: ApplyCarryForwardInput<TPreview>,
): TPreview[] {
  const { v2Records, v1Records, spec } = input;
  if (v1Records.length === 0) return v2Records;

  const v1WithKeys = v1Records.map((r) => ({ rec: r, key: spec.carryForwardKey(r as never) }));

  return v2Records.map((v2): TPreview => {
    const v2Key = spec.carryForwardKey(v2 as never);
    let bestDist = Number.POSITIVE_INFINITY;
    let best: TPreview | undefined;
    for (const { rec, key } of v1WithKeys) {
      const dist = levenshteinDistance(v2Key, key);
      if (dist < bestDist) {
        bestDist = dist;
        best = rec;
      }
    }
    if (!best || bestDist > FUZZY_THRESHOLD) return v2;
    if (spec.isForceResearchFlag(best as never)) return v2;
    return spec.applyCarryForward({ v2: v2 as never, v1: best as never }) as TPreview;
  });
}
