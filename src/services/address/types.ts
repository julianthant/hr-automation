/** Partial address input — one-line or structured, US or international. */
export interface AddressInput {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  /** ISO 3166-1 alpha-2 (e.g. `CN`) or a country name hint. */
  country?: string | null;
}

/** Structured address suitable for UCPath / review surfaces. */
export interface ResolvedAddress {
  street: string;
  city: string;
  state: string;
  zip: string;
  /** ISO 3166-1 alpha-2 when the geocoder returned one. */
  country?: string;
}

export type AddressConfidence = "exact" | "approximate" | "unverified";
export type AddressSource = "nominatim" | "census" | "none";

export interface AddressChange {
  field: keyof ResolvedAddress;
  from: string;
  to: string;
}

export interface AddressResolution {
  address: ResolvedAddress;
  confidence: AddressConfidence;
  source: AddressSource;
  /** Provider's canonical one-line match, when available. */
  matchedLine?: string;
  changes: AddressChange[];
}
