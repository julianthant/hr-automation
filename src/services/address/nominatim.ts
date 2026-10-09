import { log } from "../../utils/log.js";
import { diffAddressFields, formatAddressOneLine, titleCaseSegment } from "./format.js";
import { waitForNominatimSlot } from "./rate-limit.js";
import { composeResolvedStreet } from "./street.js";
import type { AddressInput, AddressResolution, ResolvedAddress } from "./types.js";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "hr-automation/1.0 (UCSD HR automation; address enrichment)";

interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  region?: string;
  state_district?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
}

interface NominatimResult {
  display_name?: string;
  importance?: number;
  address?: NominatimAddress;
}

/**
 * Street NAME only. OSM's `house_number` is the number of the node it snapped to —
 * not necessarily the operator's — and no OSM field carries a unit, so the house
 * number + unit come from the ORIGINAL street (`composeResolvedStreet`).
 */
function buildStreet(addr: NominatimAddress, input: AddressInput): string {
  const road = (addr.road ?? "").trim();
  if (!road) return "";
  // When the original carried no house number, compose yields the road name alone
  // — OSM's `house_number` is never grafted onto a street the operator wrote without one.
  return composeResolvedStreet(input.street, titleCaseSegment(road));
}

function pickCity(addr: NominatimAddress): string {
  return (
    addr.city
    ?? addr.town
    ?? addr.village
    ?? addr.municipality
    ?? addr.county
    ?? ""
  );
}

function pickRegion(addr: NominatimAddress): string {
  return addr.state ?? addr.state_district ?? addr.region ?? "";
}

function mapNominatimResult(result: NominatimResult, input: AddressInput): ResolvedAddress | null {
  const addr = result.address;
  if (!addr) return null;
  const street = buildStreet(addr, input);
  const city = pickCity(addr);
  const state = pickRegion(addr);
  const zip = (addr.postcode ?? "").trim();
  if (!street && !city && !state && !zip) return null;
  return {
    street,
    city: city ? titleCaseSegment(city) : "",
    state: state ? titleCaseSegment(state) : "",
    zip,
    country: addr.country_code?.toUpperCase(),
  };
}

function confidenceFromImportance(importance: number | undefined): AddressResolution["confidence"] {
  if (importance == null) return "approximate";
  if (importance >= 0.5) return "exact";
  if (importance >= 0.3) return "approximate";
  return "unverified";
}

export async function geocodeWithNominatim(
  input: AddressInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AddressResolution | null> {
  const line = formatAddressOneLine(input);
  if (!line.trim()) return null;

  await waitForNominatimSlot();

  const params = new URLSearchParams({
    q: line,
    format: "json",
    addressdetails: "1",
    limit: "1",
  });
  const country = (input.country ?? "").trim();
  if (country.length === 2) params.set("countrycodes", country.toLowerCase());

  const url = `${NOMINATIM_BASE}?${params.toString()}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } catch (err) {
    log.warn(`[address/nominatim] request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (!res.ok) {
    log.warn(`[address/nominatim] HTTP ${res.status} for "${line.slice(0, 80)}"`);
    return null;
  }

  let data: NominatimResult[];
  try {
    data = (await res.json()) as NominatimResult[];
  } catch {
    log.warn("[address/nominatim] invalid JSON response");
    return null;
  }

  const hit = data[0];
  if (!hit) return null;

  const mapped = mapNominatimResult(hit, input);
  if (!mapped) return null;

  const changes = diffAddressFields(input, mapped);
  if (changes.length === 0) return null;

  return {
    address: mapped,
    confidence: confidenceFromImportance(hit.importance),
    source: "nominatim",
    matchedLine: hit.display_name,
    changes,
  };
}
