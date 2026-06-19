import { levenshteinDistance } from "./levenshtein.js";

// ─── Name match ────────────────────────────────────────────

export interface NameMatchResult {
  /** 0..1 confidence. */
  score: number;
  reason: "exact" | "token-set" | "fuzzy" | "none";
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
  return scoreNameMatchFromTokens(
    at, [...at].sort().join(" "), new Set(at),
    bt, [...bt].sort().join(" "), new Set(bt),
  );
}

/**
 * Scoring kernel — accepts pre-tokenized inputs so callers that scan many
 * rows (e.g. matchAgainstRoster) avoid re-tokenizing the same string N times.
 */
function scoreNameMatchFromTokens(
  at: readonly string[],
  aSorted: string,
  aSet: ReadonlySet<string>,
  bt: readonly string[],
  bSorted: string,
  bSet: ReadonlySet<string>,
): NameMatchResult {
  if (at.length === 0 || bt.length === 0) return { score: 0, reason: "none" };
  if (aSorted === bSorted) return { score: 1.0, reason: "exact" };

  const inter = [...aSet].filter((x) => bSet.has(x));
  // Require both sides to have at least 2 distinct tokens before entering
  // the token-set tier. Without this guard, "John John" collapses to a
  // 1-element set and would match "John X" at ratio 1/1 = 1.0.
  // Require token-set to be a near-subset on the smaller side — i.e. all
  // (or nearly all) tokens of the shorter name appear in the longer one.
  // This keeps "John Michael Doe" vs "John Doe" as a strong match while
  // rejecting "John Doee" vs "John Doe" (only 1/2 tokens match — the
  // difference is a Levenshtein-1 case caught by the fuzzy tier below).
  if (aSet.size >= 2 && bSet.size >= 2 && inter.length / Math.min(aSet.size, bSet.size) >= 0.8) {
    return { score: 0.9, reason: "token-set" };
  }

const d = levenshteinDistance(at.join(" "), bt.join(" "));
  if (d <= 2) return { score: 0.7, reason: "fuzzy" };

  return { score: 0, reason: "none" };
}

// ─── Name similarity tier (order-insensitive) ──────────────

/** Max per-token Levenshtein distance still counted as a spelling variant. */
export const TOKEN_VARIANT_MAX = 2;

/**
 * Three-way name comparison for "same person?" decisions where one side may be
 * a misspelling of the other (e.g. Kuali "Balmaceda, Jaden" vs the UCPath
 * detail-page "Jayden Balmaceda").
 *
 *   - `"same"`      — identical token multiset (order-insensitive), OR every
 *                     token of the shorter name is an EXACT token of the longer
 *                     (the longer side may carry extra middle names).
 *   - `"similar"`   — every token of the shorter name finds a partner within
 *                     `TOKEN_VARIANT_MAX` edits and at least one is a non-exact
 *                     variant (a typo / spelling drift) → same person, fix the
 *                     spelling.
 *   - `"different"` — some token of the shorter name has NO partner within
 *                     `TOKEN_VARIANT_MAX` edits → the names name different
 *                     people (or one side is empty).
 *
 * Unlike `scoreNameMatch`'s fuzzy tier (Levenshtein on the UNSORTED joined
 * tokens, which inflates the distance on a First-Last vs Last-First swap), this
 * aligns token-by-token, so name-order differences never masquerade as a
 * mismatch.
 */
export type NameSimilarityTier = "same" | "similar" | "different";

export function classifyNameSimilarity(a: string, b: string): NameSimilarityTier {
  const at = tokenize(a);
  const bt = tokenize(b);
  if (at.length === 0 || bt.length === 0) return "different";

  // Order-insensitive exact: identical multiset of tokens → same spelling.
  if ([...at].sort().join(" ") === [...bt].sort().join(" ")) return "same";

  // Align the shorter token list against the longer one (extra middle names on
  // the longer side are tolerated). Every shorter token must find a partner
  // within TOKEN_VARIANT_MAX edits; one+ non-exact partner makes it "similar".
  const [small, large] = at.length <= bt.length ? [at, bt] : [bt, at];
  let anyVariant = false;
  for (const token of small) {
    let best = Infinity;
    for (const other of large) {
      best = Math.min(best, levenshteinDistance(token, other));
      if (best === 0) break;
    }
    if (best > TOKEN_VARIANT_MAX) return "different";
    if (best > 0) anyVariant = true;
  }
  return anyVariant ? "similar" : "same";
}

/**
 * Re-spell `name` using `authoritative`'s tokens while PRESERVING `name`'s
 * format (token order, comma, spacing). Only word tokens of `name` that are a
 * near-match (Levenshtein ≤ `TOKEN_VARIANT_MAX`) to an authoritative token — and
 * are not already an exact match — are replaced, with the authoritative token
 * verbatim. Exact-match and unmatched tokens are left untouched.
 *
 * Use after `classifyNameSimilarity` returns `"similar"` to fix a misspelling in
 * place: e.g. `correctNameSpelling("Balmaceda, Jaden", "Jayden Balmaceda")`
 * → `"Balmaceda, Jayden"`. This keeps the Kuali "Last, First" comma format
 * rather than reconstructing it from the UCPath "First Last" name (which would
 * mangle compound last names).
 */
export function correctNameSpelling(name: string, authoritative: string): string {
  const authTokens = authoritative.trim().split(/\s+/).filter(Boolean);
  if (authTokens.length === 0) return name;
  const authLower = authTokens.map((t) => t.toLowerCase());
  return name.replace(/[A-Za-z]+/g, (word) => {
    const lw = word.toLowerCase();
    if (authLower.includes(lw)) return word; // exact token — keep verbatim
    let best: { token: string; d: number } | null = null;
    for (let i = 0; i < authTokens.length; i++) {
      const d = levenshteinDistance(lw, authLower[i]);
      if (d <= TOKEN_VARIANT_MAX && (best === null || d < best.d)) {
        best = { token: authTokens[i], d };
      }
    }
    return best ? best.token : word;
  });
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

/** Pre-tokenized roster row — produced by precomputeRoster(). */
export interface TokenizedRosterRow extends RosterRow {
  readonly _nameTokens: string[];
  readonly _nameSorted: string;
  readonly _nameSet: Set<string>;
}

/**
 * Pre-tokenize every row's name so matchAgainstRoster avoids re-tokenizing
 * the same roster name for each OCR record. Call once after loadRoster and
 * pass the result wherever matchAgainstRoster is called in a loop.
 */
export function precomputeRoster(roster: readonly RosterRow[]): TokenizedRosterRow[] {
  return roster.map((row) => {
    const tokens = tokenize(row.name);
    return { ...row, _nameTokens: tokens, _nameSorted: [...tokens].sort().join(" "), _nameSet: new Set(tokens) };
  });
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
 *
 * Accepts TokenizedRosterRow (from precomputeRoster) to avoid re-tokenizing
 * roster names for every query when called in a per-record loop.
 */
export function matchAgainstRoster(
  roster: readonly RosterRow[],
  targetName: string,
): RosterMatchResult {
  const bt = tokenize(targetName);
  const bSorted = [...bt].sort().join(" ");
  const bSet = new Set(bt);
  const scored = roster
    .map((row) => {
      const pre = row as Partial<TokenizedRosterRow>;
      const at = pre._nameTokens ?? tokenize(row.name);
      const aSorted = pre._nameSorted ?? [...at].sort().join(" ");
      const aSet = pre._nameSet ?? new Set(at);
      const m = scoreNameMatchFromTokens(at, aSorted, aSet, bt, bSorted, bSet);
      return { eid: row.eid, name: row.name, score: m.score, reason: m.reason };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return { candidates: scored, bestScore: scored[0]?.score ?? 0 };
}

/**
 * Coerce arbitrary input (OCR output, form fields, etc.) into a clean
 * digit-only EID string. Strips whitespace, leading/embedded non-digits
 * (e.g. `"A10877384"` → `"10877384"`, `"10877384."` → `"10877384"`).
 * Returns `""` for null/undefined/non-stringy input.
 */
// ─── Hybrid roster match: algorithmic + LLM disambiguation ─

export interface DisambiguatorInput {
  query: string;
  candidates: Array<{ eid: string; name: string; score: number }>;
}

export interface DisambiguatorResult {
  eid: string | null;
  confidence: number;
}

export interface MatchOptions {
  /** Algorithmic-score floor for auto-accept (default 0.85). */
  acceptThreshold?: number;
  /** Algorithmic-score floor for sending to LLM disambiguation (default 0.50). */
  disambiguateThreshold?: number;
  /**
   * Override the disambiguation function. Defaults to `disambiguateMatch`
   * from `src/services/ocr/disambiguate.ts` (Gemini text-only call). Tests pass a
   * stub here so they don't hit the network.
   */
  disambiguator?: (input: DisambiguatorInput) => Promise<DisambiguatorResult>;
}

export interface AsyncMatchResult {
  eid: string | null;
  confidence: number;
  source: "roster" | "llm";
  candidates: RosterMatchResult["candidates"];
}

/**
 * Hybrid name → EID match:
 *   - score >= acceptThreshold (0.85) → accept algorithmically (source: "roster")
 *   - disambiguateThreshold <= score < acceptThreshold → LLM disambiguation
 *     (source: "llm" if the LLM returns an EID; "roster" + null EID otherwise)
 *   - score < disambiguateThreshold → unresolved (eid: null, source: "roster")
 *
 * The LLM disambiguator sees the top 5 candidates plus the OCR'd query.
 * Caller is expected to fall back to eid-lookup when this returns null.
 */
export async function matchAgainstRosterAsync(
  query: string,
  roster: readonly RosterRow[],
  opts: MatchOptions = {},
): Promise<AsyncMatchResult> {
  const accept = opts.acceptThreshold ?? 0.85;
  const llmFloor = opts.disambiguateThreshold ?? 0.5;

  const ranked = matchAgainstRoster(roster, query);

  if (ranked.candidates.length === 0 || ranked.bestScore < llmFloor) {
    return {
      eid: null,
      confidence: 0,
      source: "roster",
      candidates: ranked.candidates,
    };
  }
  if (ranked.bestScore >= accept) {
    return {
      eid: ranked.candidates[0].eid,
      confidence: ranked.bestScore,
      source: "roster",
      candidates: ranked.candidates,
    };
  }

  const disambiguate = opts.disambiguator ?? (await loadDefaultDisambiguator());
  const top5 = ranked.candidates.slice(0, 5).map((c) => ({
    eid: c.eid,
    name: c.name,
    score: c.score,
  }));
  const result = await disambiguate({ query, candidates: top5 });
  return {
    eid: result.eid,
    confidence: result.confidence,
    source: result.eid ? "llm" : "roster",
    candidates: ranked.candidates,
  };
}

/**
 * Lazy import to avoid pulling the Gemini SDK into callers that supply
 * their own disambiguator (notably tests).
 */
async function loadDefaultDisambiguator(): Promise<
  (input: DisambiguatorInput) => Promise<DisambiguatorResult>
> {
  const mod = await import("../ocr/disambiguate.js");
  return mod.disambiguateMatch;
}
