import { log } from "../../utils/log.js";
import { geocodeWithCensus } from "./census.js";
import { hasResolvableStreet, isLikelyUsAddress } from "./format.js";
import { geocodeWithNominatim } from "./nominatim.js";
import type { AddressInput, AddressResolution } from "./types.js";

export interface ResolveAddressOptions {
  /** Inject fetch for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** When false, skip external API calls (rules-only callers). */
  enableGeocoding?: boolean;
}

/**
 * Enrich a partial or messy address using free geocoding APIs.
 *
 * - **US:** Census Geocoder first (authoritative street ranges), Nominatim fallback.
 * - **International:** Nominatim (OpenStreetMap) — global, free, 1 req/sec public limit.
 *
 * Returns `null` when the input is too sparse, APIs miss, or no field would change.
 * Never throws — callers treat a miss as "no enrichment" (fail loud at review, not here).
 */
export async function resolveAddress(
  input: AddressInput,
  opts: ResolveAddressOptions = {},
): Promise<AddressResolution | null> {
  if (!hasResolvableStreet(input)) return null;
  if (opts.enableGeocoding === false) return null;

  const fetchImpl = opts.fetch ?? fetch;

  try {
    if (isLikelyUsAddress(input)) {
      const census = await geocodeWithCensus(input, fetchImpl);
      if (census) return census;
    }
    return await geocodeWithNominatim(input, fetchImpl);
  } catch (err) {
    log.warn(`[address/resolve] enrichment error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export type { AddressInput, AddressResolution, ResolvedAddress, AddressChange } from "./types.js";
export { formatAddressOneLine, hasResolvableStreet, isLikelyUsAddress, isUsCountry, normalizeCountryHint, diffAddressFields } from "./format.js";
