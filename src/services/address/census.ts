import { log } from "../../utils/log.js";
import { diffAddressFields, titleCaseSegment } from "./format.js";
import type { AddressInput, AddressResolution, ResolvedAddress } from "./types.js";

const CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder/locations";

interface CensusComponents {
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

function buildStreetFromComponents(c: CensusComponents): string {
  const number = (c.fromAddress ?? "").trim();
  const pre = (c.preDirection ?? "").trim();
  const name = (c.streetName ?? "").trim();
  const suffix = (c.suffixType ?? "").trim();
  const parts = [number, pre, name, suffix].filter(Boolean);
  return parts.join(" ");
}

function mapCensusMatch(match: CensusMatch): ResolvedAddress | null {
  const c = match.addressComponents;
  if (!c) return null;
  const street = buildStreetFromComponents(c);
  const city = (c.city ?? "").trim();
  const state = (c.state ?? "").trim();
  const zip = (c.zip ?? "").trim();
  if (!street && !city && !state && !zip) return null;
  return {
    street: street ? titleCaseSegment(street) : "",
    city: city ? titleCaseSegment(city) : "",
    state,
    zip,
    country: "US",
  };
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

  const mapped = mapCensusMatch(match);
  if (!mapped) return null;

  const changes = diffAddressFields(input, mapped);
  if (changes.length === 0) return null;

  return {
    address: mapped,
    confidence: "exact",
    source: "census",
    matchedLine: match.matchedAddress,
    changes,
  };
}
