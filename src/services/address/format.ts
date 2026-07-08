import type { AddressInput, ResolvedAddress } from "./types.js";

const US_ALIASES = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america"]);

const COUNTRY_ALIASES: Record<string, string> = {
  china: "CN",
  "people's republic of china": "CN",
  prc: "CN",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  canada: "CA",
  mexico: "MX",
  india: "IN",
  "south korea": "KR",
  korea: "KR",
  japan: "JP",
  taiwan: "TW",
  germany: "DE",
  france: "FR",
  australia: "AU",
  brazil: "BR",
  philippines: "PH",
  vietnam: "VN",
};

/** Normalize a country hint to ISO 3166-1 alpha-2 when recognized; else return trimmed input. */
export function normalizeCountryHint(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  const alias = COUNTRY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed;
}

export function isUsCountry(country: string | null | undefined): boolean {
  if (!country) return true;
  const norm = normalizeCountryHint(country);
  if (!norm) return true;
  if (norm.length === 2) return norm.toUpperCase() === "US";
  return US_ALIASES.has(norm.toLowerCase());
}

/** True when the input looks US-domestic (explicit country or US-shaped state/ZIP). */
export function isLikelyUsAddress(input: AddressInput): boolean {
  const country = (input.country ?? "").trim();
  if (country) return isUsCountry(country);
  const zip = (input.zip ?? "").replace(/\D/g, "");
  if (/^\d{5}(\d{4})?$/.test(zip)) return true;
  const state = (input.state ?? "").trim();
  if (/^[A-Za-z]{2}$/.test(state)) return true;
  return false;
}

export function formatAddressOneLine(input: AddressInput): string {
  return [input.street, input.city, input.state, input.zip, input.country]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(", ");
}

export function hasResolvableStreet(input: AddressInput): boolean {
  const line = formatAddressOneLine(input);
  return line.trim().length >= 8;
}

/** Build field-level diffs between the input and a resolved address. */
export function diffAddressFields(
  before: AddressInput,
  after: ResolvedAddress,
): import("./types.js").AddressChange[] {
  const changes: import("./types.js").AddressChange[] = [];
  const pairs: Array<[keyof ResolvedAddress, string | null | undefined]> = [
    ["street", before.street],
    ["city", before.city],
    ["state", before.state],
    ["zip", before.zip],
  ];
  for (const [field, fromRaw] of pairs) {
    const from = (fromRaw ?? "").trim();
    const to = (after[field] ?? "").trim();
    if (!to) continue;
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

/** Title-case-ish cleanup for display fields without inventing missing parts. */
export function titleCaseSegment(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  if (trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)) {
    return trimmed
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      if (/^\d/.test(word)) return word;
      if (word === word.toUpperCase() && word.length <= 4) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}
