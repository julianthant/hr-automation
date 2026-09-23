import {
  classifyNameSimilarity,
  type NameSimilarityTier,
} from "../../services/matching/match.js";

/** Which roster name UCPath's transaction name was proved against. */
export type ProcessEidNameSource = "lived" | "legal" | "none";

export interface ProcessEidNameVerdict {
  /** False means UCPath holds a DIFFERENT person for this transaction number. */
  matched: boolean;
  tier: NameSimilarityTier;
  matchedAgainst: ProcessEidNameSource;
  /** Operator-facing summary, e.g. `same as Legal Name`. */
  label: string;
}

const TIER_RANK: Record<NameSimilarityTier, number> = {
  same: 2,
  similar: 1,
  different: 0,
};

const SOURCE_LABEL: Record<ProcessEidNameSource, string> = {
  lived: "Lived Name",
  legal: "Legal Name",
  none: "roster name",
};

/**
 * Prove that the transaction number searched in UCPath belongs to the roster
 * row that supplied it, by comparing UCPath's own transaction name against the
 * roster's names.
 *
 * BOTH roster names are compared and the best tier wins, because a roster row
 * legitimately carries two spellings of one person (`Rita Li` / `Guangyi Li`,
 * `Chris Campos` / `Christopher Campos`) and UCPath holds exactly one of them.
 * `similar` counts as proof — `Stone` vs `Stoney` is one edit — but it is
 * reported, so a run says which name matched and how closely.
 *
 * `different` against both names is a MISMATCH, and the caller must fail the
 * row rather than record its EID: the number is the roster's, the person is
 * not.
 */
export function verifyUcpathTransactionName(
  ucpathName: string,
  roster: { livedName: string; legalName?: string },
): ProcessEidNameVerdict {
  const candidates: Array<{ source: ProcessEidNameSource; value: string }> = [
    { source: "lived", value: roster.livedName },
    ...(roster.legalName ? [{ source: "legal" as const, value: roster.legalName }] : []),
  ];

  let best: ProcessEidNameVerdict = {
    matched: false,
    tier: "different",
    matchedAgainst: "none",
    label: "no roster name matched",
  };
  let bestRank = 0;
  for (const candidate of candidates) {
    if (!candidate.value.trim()) continue;
    const tier = classifyNameSimilarity(ucpathName, candidate.value);
    if (TIER_RANK[tier] <= bestRank) continue;
    bestRank = TIER_RANK[tier];
    best = {
      matched: true,
      tier,
      matchedAgainst: candidate.source,
      label: `${tier} as ${SOURCE_LABEL[candidate.source]}`,
    };
  }
  return best;
}

/** The exact message a name mismatch fails with — names both sides, fails loud. */
export function processEidNameMismatchMessage(opts: {
  transactionId: string;
  ucpathName: string;
  livedName: string;
  legalName?: string;
}): string {
  const rosterNames = opts.legalName && opts.legalName !== opts.livedName
    ? `"${opts.livedName}" (lived) / "${opts.legalName}" (legal)`
    : `"${opts.livedName}"`;
  return (
    `Transaction ${opts.transactionId} belongs to "${opts.ucpathName}" in UCPath, ` +
    `but the roster row lists ${rosterNames}. No EID was recorded — correct the ` +
    `transaction number or the name at the source.`
  );
}
