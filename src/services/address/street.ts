/**
 * Street-line primitives that make a geocoder structurally unable to corrupt an
 * operator-visible street.
 *
 * Two failure modes this module exists to prevent (both observed live 2026-07-13,
 * 3/3 EC records corrupted):
 *
 *  1. **House-number rewrite.** Census `addressComponents.fromAddress`/`toAddress`
 *     are the TIGER **block address RANGE** (e.g. 3401–3499), NOT the matched
 *     house number — building the street from `fromAddress` moved `3449 Invicta
 *     Way` to `3429 Invicta Way`, a different building.
 *  2. **Dropped unit.** No geocoder's component set carries the secondary
 *     designator, so `1177 Market St. Apt 1208` came back as `1101 Market St` —
 *     apartment gone.
 *
 * Contract: a geocoder may only correct the **street NAME / suffix / pre-direction**
 * (`Candlewood In` → `Candlewood Ln`). The house number and any unit token always
 * come from the ORIGINAL (OCR'd) street. Per the project's fail-loud rule, when a
 * candidate street would change either, the caller keeps the original verbatim.
 */

/** Leading house number of a street line — `"3449"` from `"3449 Invicta Way"`. */
export function parseHouseNumber(street: string | null | undefined): string | null {
  const m = /^\s*(\d+[A-Za-z]?(?:[-–]\d+[A-Za-z]?)?)(?=\s|$)/.exec(street ?? "");
  return m ? m[1] : null;
}

/**
 * Secondary-unit designators. Word-bounded so a street NAME can't false-positive
 * (`Flower St` never matches `fl`). A bare `#4` counts too.
 */
const UNIT_KEYWORDS =
  "apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|spc|trlr|trailer";
const UNIT_RE = new RegExp(String.raw`(?:\b(?:${UNIT_KEYWORDS})\b\.?\s*#?\s*[\w-]+|#\s*[\w-]+)`, "gi");

/** Every unit/secondary token in a street line, normalized for comparison. */
export function extractUnitTokens(street: string | null | undefined): string[] {
  const matches = (street ?? "").match(UNIT_RE) ?? [];
  return matches.map((t) => t.replace(/[.\s#]+/g, "").toLowerCase());
}

/**
 * The trailing unit portion of a street line, VERBATIM — `"Apt 1208"` from
 * `"1177 Market St. Apt 1208"`. `null` when the line carries no unit.
 */
export function extractUnitSuffix(street: string | null | undefined): string | null {
  const line = (street ?? "").trim();
  if (!line) return null;
  UNIT_RE.lastIndex = 0;
  const m = UNIT_RE.exec(line);
  if (!m || m.index == null) return null;
  return line.slice(m.index).replace(/^[,\s]+/, "").trim() || null;
}

/**
 * Compose a resolved street from the geocoder's street NAME plus the original's
 * house number and unit. Returns `""` when there is no usable name part — the
 * caller then keeps the original street.
 */
export function composeResolvedStreet(originalStreet: string | null | undefined, streetName: string): string {
  const name = streetName.trim();
  if (!name) return "";
  const house = parseHouseNumber(originalStreet);
  const unit = extractUnitSuffix(originalStreet);
  return [house, name, unit].filter(Boolean).join(" ");
}

/**
 * The choke-point guard: may `candidate` replace `original`?
 *
 * `false` when the candidate would (a) change/add/remove the leading house number,
 * or (b) drop a unit token the original carried. Extra units on the candidate are
 * fine (a geocoder never invents one, but adding info is not corruption).
 */
export function isSafeStreetReplacement(
  original: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const cand = (candidate ?? "").trim();
  if (!cand) return false;
  if (parseHouseNumber(original) !== parseHouseNumber(cand)) return false;
  const candUnits = new Set(extractUnitTokens(cand));
  return extractUnitTokens(original).every((t) => candUnits.has(t));
}
