import { log } from "../../utils/log.js";
import { diffAddressFields, titleCaseSegment } from "./format.js";
import { composeResolvedStreet, parseHouseNumber } from "./street.js";
import type { AddressConfidence, AddressInput, AddressResolution, ResolvedAddress } from "./types.js";

const CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder/locations";

interface CensusComponents {
  /**
   * TIGER block address RANGE endpoints — **NOT** the matched house number.
   * `3401`/`3499` for a hit on `3449 Invicta Way`. Never build a street from these
   * (see `street.ts`); they are kept only for diagnostics.
   */
  fromAddress?: string;
  toAddress?: string;
  preDirection?: string;
  streetName?: string;
  suffixType?: string;
  city?: string;
  state?: string;
  zip?: string;
}

interface CensusMatch {
  matchedAddress?: string;
  addressComponents?: CensusComponents;
}

interface CensusResponse {
  result?: { addressMatches?: CensusMatch[] };
}

/** Street NAME only — pre-direction + name + suffix. Carries NO house number by design. */
function buildStreetNameFromComponents(c: CensusComponents): string {
  const pre = (c.preDirection ?? "").trim();
  const name = (c.streetName ?? "").trim();
  const suffix = (c.suffixType ?? "").trim();
  return [pre, name, suffix].filter(Boolean).join(" ");
}

function mapCensusMatch(match: CensusMatch, input: AddressInput): ResolvedAddress | null {
  const c = match.addressComponents;
  if (!c) return null;
  // House number + unit come from the ORIGINAL street; Census only supplies the name.
  const street = composeResolvedStreet(input.street, titleCaseSegment(buildStreetNameFromComponents(c)));
  const city = (c.city ?? "").trim();
  const state = (c.state ?? "").trim();
  const zip = (c.zip ?? "").trim();
  if (!street && !city && !state && !zip) return null;
  return {
    street,
    city: city ? titleCaseSegment(city) : "",
    state,
    zip,
    country: "US",
  };
}

/**
 * Honest confidence — the old hardcoded `"exact"` defeated the `confidence ===
 * "unverified"` gate downstream. `exact` only when Census matched the SAME house
 * number the operator's form carried; otherwise the geocoder snapped to a
 * neighbouring building, so the match is `approximate` at best.
 */
function censusConfidence(input: AddressInput, match: CensusMatch): AddressConfidence {
  const inputHouse = parseHouseNumber(input.street);
  const matchedHouse = parseHouseNumber(match.matchedAddress);
  if (!inputHouse || !matchedHouse) return "approximate";
  return inputHouse.toLowerCase() === matchedHouse.toLowerCase() ? "exact" : "approximate";
}

export async function geocodeWithCensus(
  input: AddressInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AddressResolution | null> {
  const street = (input.street ?? "").trim();
  const city = (input.city ?? "").trim();
  const state = (input.state ?? "").trim();
  const zip = (input.zip ?? "").trim();

  const params = new URLSearchParams({ benchmark: "4", format: "json" });
  let path: string;

  if (street && (city || state || zip)) {
    params.set("street", street);
    if (city) params.set("city", city);
    if (state) params.set("state", state);
    if (zip) params.set("zip", zip);
    path = "address";
  } else {
    const { formatAddressOneLine } = await import("./format.js");
    const line = formatAddressOneLine({ ...input, country: null });
    if (!line.trim()) return null;
    params.set("address", line);
    path = "onelineaddress";
  }

  const url = `${CENSUS_BASE}/${path}?${params.toString()}`;

  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  } catch (err) {
    log.warn(`[address/census] request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (!res.ok) {
    log.warn(`[address/census] HTTP ${res.status}`);
    return null;
  }

  let data: CensusResponse;
  try {
    data = (await res.json()) as CensusResponse;
  } catch {
    log.warn("[address/census] invalid JSON response");
    return null;
  }

  const match = data.result?.addressMatches?.[0];
  if (!match) return null;

  const mapped = mapCensusMatch(match, input);
  if (!mapped) return null;

  const changes = diffAddressFields(input, mapped);
  if (changes.length === 0) return null;

  return {
    address: mapped,
    confidence: censusConfidence(input, match),
    source: "census",
    matchedLine: match.matchedAddress,
    changes,
  };
}
