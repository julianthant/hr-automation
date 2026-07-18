/**
 * Pure hire-date corroboration for the i9-check person-lookup path.
 *
 * When person-match does not resolve an Empl ID, we run a Person Org name
 * lookup and accept a candidate only when the I-9 "First Day of Employment"
 * is within ±7 days of that candidate's UCPath Last Hire (`startDate`, with
 * assignment EFFDT as fallback) — same tolerance person-lookup uses for
 * CRM↔UCPath date matching.
 */
import { datesWithinDays } from "../person-lookup/crm-search.js";

export const I9_HIRE_DATE_TOLERANCE_DAYS = 7;

export interface HireDateLookupCandidate {
  emplId: string;
  name: string;
  /** UCPath Last Hire (preferred). */
  startDate?: string;
  /** Assignment EFFDT — used only when Last Hire is blank. */
  effectiveDate?: string;
}

export type HireDateLookupOutcome =
  | {
      status: "found";
      emplId: string;
      matchedName: string;
      startDate: string;
    }
  | { status: "not-found"; candidateCount: number }
  | {
      status: "ambiguous";
      candidateCount: number;
      reason: "multiple-hire-date-matches" | "missing-hire-date";
    };

function uniqueByEmplId(
  candidates: HireDateLookupCandidate[],
): HireDateLookupCandidate[] {
  const seen = new Set<string>();
  const out: HireDateLookupCandidate[] = [];
  for (const c of candidates) {
    const id = c.emplId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(c);
  }
  return out;
}

function ucpathHireDate(c: HireDateLookupCandidate): string {
  return (c.startDate || c.effectiveDate || "").trim();
}

/**
 * Filter Person Org name-search results by I-9 hire date (±toleranceDays).
 *
 * - Empty results → not-found.
 * - Missing I-9 hireDate → ambiguous (never accept a name-only hit).
 * - Exactly one Empl ID within tolerance → found.
 * - Zero within tolerance → not-found.
 * - Two+ distinct Empl IDs within tolerance → ambiguous.
 */
export function selectPersonLookupByHireDate(
  hireDate: string | undefined,
  results: readonly HireDateLookupCandidate[],
  toleranceDays: number = I9_HIRE_DATE_TOLERANCE_DAYS,
): HireDateLookupOutcome {
  const unique = uniqueByEmplId([...results]);
  if (unique.length === 0) {
    return { status: "not-found", candidateCount: 0 };
  }

  const i9Hire = hireDate?.trim() ?? "";
  if (!i9Hire) {
    return {
      status: "ambiguous",
      candidateCount: unique.length,
      reason: "missing-hire-date",
    };
  }

  const matched = unique.filter((c) => {
    const ucDate = ucpathHireDate(c);
    return ucDate.length > 0 && datesWithinDays(i9Hire, ucDate, toleranceDays);
  });

  if (matched.length === 1) {
    const hit = matched[0]!;
    return {
      status: "found",
      emplId: hit.emplId,
      matchedName: hit.name,
      startDate: ucpathHireDate(hit),
    };
  }
  if (matched.length === 0) {
    return { status: "not-found", candidateCount: unique.length };
  }
  return {
    status: "ambiguous",
    candidateCount: matched.length,
    reason: "multiple-hire-date-matches",
  };
}
