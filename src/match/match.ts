import { levenshteinDistance } from "./levenshtein.js";

// ─── Name match ────────────────────────────────────────────

export interface NameMatchResult {
  /** 0..1 confidence. */
  score: number;
  reason: "exact" | "token-set" | "swap" | "fuzzy" | "none";
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Five-tier name match scoring (handwritten form names vs. roster
 * "Last, First" or "First Last" entries):
 *   - Exact (sorted tokens equal) → 1.0
 *   - Token-set intersect ≥ 50% of max(set sizes) → 0.9
 *   - First/last-name swap (with comma in either side) → 0.85
 *   - Levenshtein ≤ 2 on full normalized name → 0.7
 *   - Otherwise → 0.0
 *
 * Auto-accept threshold for roster matching is 0.85.
 */
export function scoreNameMatch(a: string, b: string): NameMatchResult {
  const at = tokenize(a);
  const bt = tokenize(b);
  if (at.length === 0 || bt.length === 0) return { score: 0, reason: "none" };

  const aSorted = [...at].sort().join(" ");
  const bSorted = [...bt].sort().join(" ");
  if (aSorted === bSorted) return { score: 1.0, reason: "exact" };

  const aSet = new Set(at);
  const bSet = new Set(bt);
  const inter = [...aSet].filter((x) => bSet.has(x));
  // Require token-set to be a near-subset on the smaller side — i.e. all
  // (or nearly all) tokens of the shorter name appear in the longer one.
  // This keeps "John Michael Doe" vs "John Doe" as a strong match while
  // rejecting "John Doee" vs "John Doe" (only 1/2 tokens match — the
  // difference is a Levenshtein-1 case caught by the fuzzy tier below).
  if (inter.length / Math.min(aSet.size, bSet.size) >= 0.8) {
    return { score: 0.9, reason: "token-set" };
  }

  if (a.includes(",") || b.includes(",")) {
    const flip = (s: string): string =>
      s.includes(",") ? s.split(",").map((x) => x.trim()).reverse().join(" ") : s;
    if (tokenize(flip(a)).sort().join(" ") === tokenize(flip(b)).sort().join(" ")) {
      return { score: 0.85, reason: "swap" };
    }
  }

  const d = levenshteinDistance(at.join(" "), bt.join(" "));
  if (d <= 2) return { score: 0.7, reason: "fuzzy" };

  return { score: 0, reason: "none" };
}

// ─── US address normalization + comparison ─────────────────

const ABBREV: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  rd: "road",
  dr: "drive",
  ln: "lane",
  ct: "court",
  pl: "place",
  pkwy: "parkway",
  ter: "terrace",
  apt: "apartment",
  "#": "apartment",
  ste: "suite",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

const STATE_NAMES: Record<string, string> = {
  al: "alabama",
  ak: "alaska",
  az: "arizona",
  ar: "arkansas",
  ca: "california",
  co: "colorado",
  ct: "connecticut",
  de: "delaware",
  fl: "florida",
  ga: "georgia",
  hi: "hawaii",
  id: "idaho",
  il: "illinois",
  in: "indiana",
  ia: "iowa",
  ks: "kansas",
  ky: "kentucky",
  la: "louisiana",
  me: "maine",
  md: "maryland",
  ma: "massachusetts",
  mi: "michigan",
  mn: "minnesota",
  ms: "mississippi",
  mo: "missouri",
  mt: "montana",
  ne: "nebraska",
  nv: "nevada",
  nh: "new hampshire",
  nj: "new jersey",
  nm: "new mexico",
  ny: "new york",
  nc: "north carolina",
  nd: "north dakota",
  oh: "ohio",
  ok: "oklahoma",
  or: "oregon",
  pa: "pennsylvania",
  ri: "rhode island",
  sc: "south carolina",
  sd: "south dakota",
  tn: "tennessee",
  tx: "texas",
  ut: "utah",
  vt: "vermont",
  va: "virginia",
  wa: "washington",
  wv: "west virginia",
  wi: "wisconsin",
  wy: "wyoming",
};

export interface AddressLike {
  street: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface NormalizedAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
}

function expandTokens(s: string): string {
  return s
    .split(/\s+/)
    .map((tok) => {
      const cleaned = tok.replace(/[.,;:#]/g, "");
      return ABBREV[cleaned.toLowerCase()] ?? cleaned;
    })
    .filter(Boolean)
    .join(" ");
}

export function normalizeUsAddress(a: AddressLike): NormalizedAddress {
  const street = expandTokens(a.street ?? "")
    .toLowerCase()
    .replace(/[.,;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const city = (a.city ?? "")
    .toLowerCase()
    .replace(/[.,;:]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const stateRaw = (a.state ?? "").toLowerCase().trim();
  const state = STATE_NAMES[stateRaw] ?? stateRaw;
  const zip = (a.zip ?? "").replace(/[^0-9-]/g, "").split("-")[0] ?? "";
  return { street, city, state, zip };
}

/**
 * Compare two US addresses. Returns:
 *   - "match"   — same ZIP, street within Levenshtein 3 after normalization.
 *   - "differ"  — ZIP differs OR street too far apart.
 *   - "missing" — either side is null/empty (no comparison possible).
 */
export function compareUsAddresses(
  a: AddressLike | null | undefined,
  b: AddressLike | null | undefined,
): "match" | "differ" | "missing" {
  if (!a || !b || !a.street || !b.street) return "missing";
  const an = normalizeUsAddress(a);
  const bn = normalizeUsAddress(b);

  if (!an.zip || !bn.zip) return "missing";
  if (an.zip !== bn.zip) return "differ";

  const d = levenshteinDistance(an.street, bn.street);
  return d <= 3 ? "match" : "differ";
}

// ─── Roster lookup ─────────────────────────────────────────

export interface RosterRow {
  eid: string;
  name: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

export interface RosterMatchResult {
  candidates: Array<{
    eid: string;
    name: string;
    score: number;
    reason: NameMatchResult["reason"];
  }>;
  bestScore: number;
}

/**
 * Score every roster row against `targetName` and return non-zero matches
 * sorted by score (DESC). The caller applies the auto-accept threshold
 * (0.85): >= 0.85 → use top candidate's EID; below → mark "needs review".
 */
export function matchAgainstRoster(
  roster: readonly RosterRow[],
  targetName: string,
): RosterMatchResult {
  const scored = roster
    .map((row) => {
      const m = scoreNameMatch(row.name, targetName);
      return { eid: row.eid, name: row.name, score: m.score, reason: m.reason };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return { candidates: scored, bestScore: scored[0]?.score ?? 0 };
}
