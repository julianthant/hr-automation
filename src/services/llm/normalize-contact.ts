/**
 * Contact-field normalization for OCR'd Emergency Contact / oath records.
 *
 * Splits by RISK, not by convenience:
 *   - **Deterministic** fields (phone, US state, ZIP) are canonicalized by RULE
 *     — no LLM, no rate cost, no chance of a model inventing a digit.
 *   - **Fuzzy** fields (a free-text `relationship` the rule table can't map, a
 *     one-line address string that needs splitting) fall through to the shared
 *     free-tier LLM pool (`completeJson`) — which only fires on the rare messy
 *     value, so common forms never touch an API key.
 *
 * Every change is reported as a `NormalizationChange` (field, from, to, method)
 * so the caller can SURFACE it (as a review warning) rather than silently
 * rewriting operator-visible data bound for UCPath. The primitive normalizes;
 * the human still confirms at the OCR approval gate.
 */
import { z } from "zod/v4";
import { log } from "../../utils/log.js";
import { completeJson } from "./complete.js";
import {
  inferEmergencyContactSameAddress,
  hasMeaningfulAddress,
} from "../matching/match.js";
import { resolveAddress } from "../address/index.js";
import { isLikelyUsAddress, normalizeCountryHint } from "../address/format.js";

export interface NormalizationChange {
  /** Dotted field path, e.g. `emergencyContact.cellPhone`. */
  field: string;
  from: string;
  to: string;
  /** `rule` = deterministic; `llm` = free-tier model; `geocode` = address API enrichment. */
  method: "rule" | "llm" | "geocode";
}

// ─── Deterministic rules ──────────────────────────────────────

/**
 * Normalize a phone number for UCPath review. US numbers → `(XXX) XXX-XXXX`.
 * International numbers (country code present, 11–15 digits) → `+CC …` grouped
 * format. Returns null when there aren't enough digits to canonicalize safely
 * (partial/garbled OCR is left untouched, not fabricated).
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  const intl = formatInternationalPhone(digits);
  if (intl) return intl;
  return null;
}

/** Group international digits as +CC blocks (China +86 gets a dedicated layout). */
function formatInternationalPhone(digits: string): string | null {
  if (digits.length < 11 || digits.length > 15) return null;
  if (digits.startsWith("86") && digits.length >= 13) {
    const national = digits.slice(2);
    if (national.length >= 11) {
      return `+86 ${national.slice(0, 3)} ${national.slice(3, 7)} ${national.slice(7)}`;
    }
  }
  const ccLen = digits.startsWith("1") ? 1 : digits.length >= 12 ? 2 : 3;
  const cc = digits.slice(0, ccLen);
  const rest = digits.slice(ccLen);
  if (rest.length < 7) return null;
  const chunks: string[] = [];
  for (let i = 0; i < rest.length; i += 3) {
    chunks.push(rest.slice(i, i + 3));
  }
  return `+${cc} ${chunks.join(" ")}`.trim();
}

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC",
};
const US_STATE_ABBRS = new Set(Object.values(US_STATES));

/** Normalize a US state to its 2-letter USPS code, or null if unrecognized. */
export function normalizeUsState(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (US_STATE_ABBRS.has(upper)) return upper;
  return US_STATES[trimmed.toLowerCase()] ?? null;
}

/** Normalize a US ZIP to `NNNNN` or `NNNNN-NNNN`, or null if not enough digits. */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return null;
}

// ─── Relationship canonicalization ────────────────────────────

/** The controlled vocabulary the LLM (and rule table) map free text onto. */
export const CANONICAL_RELATIONSHIPS = [
  "Spouse", "Partner", "Parent", "Child", "Sibling", "Grandparent",
  "Grandchild", "Relative", "Friend", "Guardian", "Other",
] as const;
export type CanonicalRelationship = (typeof CANONICAL_RELATIONSHIPS)[number];

const RELATIONSHIP_RULES: Record<string, CanonicalRelationship> = {
  spouse: "Spouse", husband: "Spouse", wife: "Spouse", "significant other": "Partner",
  partner: "Partner", boyfriend: "Partner", girlfriend: "Partner", fiance: "Partner", fiancee: "Partner",
  mother: "Parent", father: "Parent", mom: "Parent", dad: "Parent", parent: "Parent", mum: "Parent",
  son: "Child", daughter: "Child", child: "Child", kid: "Child",
  brother: "Sibling", sister: "Sibling", sibling: "Sibling", bro: "Sibling", sis: "Sibling",
  grandmother: "Grandparent", grandfather: "Grandparent", grandma: "Grandparent",
  grandpa: "Grandparent", grandparent: "Grandparent",
  grandson: "Grandchild", granddaughter: "Grandchild", grandchild: "Grandchild",
  aunt: "Relative", uncle: "Relative", cousin: "Relative", niece: "Relative",
  nephew: "Relative", "in-law": "Relative", relative: "Relative",
  friend: "Friend", roommate: "Friend", neighbor: "Friend",
  guardian: "Guardian", other: "Other",
};

/**
 * Map a free-text relationship to the canonical vocabulary by RULE. Returns the
 * canonical value, `"__already"` when the input is already canonical, or null
 * when the rule table has no confident mapping (→ LLM fallback).
 */
export function canonicalizeRelationshipRule(
  raw: string | null | undefined,
): CanonicalRelationship | "__already" | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if ((CANONICAL_RELATIONSHIPS as readonly string[]).includes(trimmed)) return "__already";
  if (RELATIONSHIP_RULES[lower]) return RELATIONSHIP_RULES[lower];
  // "-in-law" (and "in law") is an affinity qualifier, not a blood relation —
  // check it BEFORE the general substring pass below, since insertion order in
  // RELATIONSHIP_RULES would otherwise match "mother"/"son"/"sister" etc. first
  // and wrongly canonicalize "mother-in-law" → Parent, "son-in-law" → Child,
  // "sister-in-law" → Sibling. Every in-law is Relative, never blood-tier.
  if (lower.includes("in-law") || lower.includes("in law")) return "Relative";
  // Substring pass for compound phrases ("my older brother", "step-mother").
  for (const [needle, canon] of Object.entries(RELATIONSHIP_RULES)) {
    if (lower.includes(needle)) return canon;
  }
  return null;
}

const RelationshipLlmSchema = z.object({
  relationship: z.enum(CANONICAL_RELATIONSHIPS),
  confidence: z.number().min(0).max(1),
});

/**
 * Canonicalize a relationship: rule table first, LLM only for the leftover
 * free text. Returns `{ value, method }` or null (blank / already-canonical /
 * pool exhausted / low-confidence). `cacheDir` isolates the usage tracker in
 * tests; `pool` injects a fake pool.
 */
export async function canonicalizeRelationship(
  raw: string | null | undefined,
  opts: { cacheDir?: string; pool?: Parameters<typeof completeJson>[0]["pool"] } = {},
): Promise<{ value: CanonicalRelationship; method: "rule" | "llm" } | null> {
  const ruled = canonicalizeRelationshipRule(raw);
  if (ruled === "__already") return null;
  if (ruled) return { value: ruled, method: "rule" };
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  const result = await completeJson({
    prompt: `Map this free-text emergency-contact relationship to exactly ONE of: ${CANONICAL_RELATIONSHIPS.join(", ")}.
Input: "${trimmed}"
Respond with ONLY JSON: {"relationship":"<one of the list>","confidence":0.0-1.0}. Use "Other" if none fit.`,
    schema: RelationshipLlmSchema,
    cacheDir: opts.cacheDir,
    pool: opts.pool,
    logTag: "normalize-rel",
    estTokens: 300,
  });
  if (!result || result.confidence < 0.6) return null;
  return { value: result.relationship, method: "llm" };
}

// ─── Address string splitting ─────────────────────────────────

const AddressLlmSchema = z.object({
  street: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});

/**
 * Split a one-line address string into components via the LLM (the VL-003
 * case: the vision model returned the address as a bare string, coerced to
 * `{ street: <whole line> }`). Returns null on exhaustion / unparseable. Applies
 * the deterministic state/zip rules on top of the model's split for US lines.
 */
export async function splitAddressString(
  line: string,
  opts: { cacheDir?: string; pool?: Parameters<typeof completeJson>[0]["pool"] } = {},
): Promise<{ street: string | null; city: string | null; state: string | null; zip: string | null; country: string | null } | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const result = await completeJson({
    prompt: `Split this mailing address into components. Do not invent missing parts.
Address: "${trimmed}"
Respond with ONLY JSON: {"street":"...","city":"...","state":"province or 2-letter US state","zip":"postal code","country":"2-letter ISO or country name"}. Use null for any part not present.`,
    schema: AddressLlmSchema,
    cacheDir: opts.cacheDir,
    pool: opts.pool,
    logTag: "normalize-addr",
    estTokens: 400,
  });
  if (!result) return null;
  const country = normalizeCountryHint(result.country);
  const us = country ? isLikelyUsAddress({ street: trimmed, country }) : /\b[A-Z]{2}\b/.test(trimmed) || /\d{5}(-\d{4})?\b/.test(trimmed);
  return {
    street: result.street?.trim() || null,
    city: result.city?.trim() || null,
    state: us ? (normalizeUsState(result.state) ?? (result.state?.trim() || null)) : (result.state?.trim() || null),
    zip: us ? (normalizeZip(result.zip) ?? (result.zip?.trim() || null)) : (result.zip?.trim() || null),
    country,
  };
}

// ─── Record-level orchestration (structural, layer-safe) ──────
//
// Operates on a DUCK-TYPED shape so this module never imports the EC
// PreviewRecord type from the workflows layer. The caller (OCR orchestrator)
// passes its record objects; we mutate the phone/relationship/address fields in
// place and return the changes for surfacing as review warnings.

interface NormalizableAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
}
interface NormalizableParty {
  relationship?: string | null;
  cellPhone?: string | null;
  homePhone?: string | null;
  workPhone?: string | null;
  address?: NormalizableAddress | null;
  homeAddress?: NormalizableAddress | null;
  sameAddressAsEmployee?: boolean;
}
export interface NormalizableEcRecord {
  employee?: NormalizableParty | null;
  emergencyContact?: NormalizableParty | null;
  originallyMissing?: string[];
  warnings?: string[];
}

const PHONE_FIELDS = ["cellPhone", "homePhone", "workPhone"] as const;

function normalizeAddressInPlace(
  addr: NormalizableAddress,
  path: string,
  changes: NormalizationChange[],
): void {
  const state = normalizeUsState(addr.state);
  if (state && state !== addr.state) {
    changes.push({ field: `${path}.state`, from: addr.state ?? "", to: state, method: "rule" });
    addr.state = state;
  }
  const zip = normalizeZip(addr.zip);
  if (zip && zip !== addr.zip) {
    changes.push({ field: `${path}.zip`, from: addr.zip ?? "", to: zip, method: "rule" });
    addr.zip = zip;
  }
}

async function enrichAddressInPlace(
  addr: NormalizableAddress,
  path: string,
  changes: NormalizationChange[],
  opts: { fetch?: typeof fetch; enableGeocoding?: boolean },
): Promise<void> {
  if (opts.enableGeocoding === false) return;
  if (!hasMeaningfulAddress(addr)) return;
  const resolution = await resolveAddress(
    {
      street: addr.street,
      city: addr.city,
      state: addr.state,
      zip: addr.zip,
      country: normalizeCountryHint(addr.country),
    },
    { fetch: opts.fetch },
  );
  if (!resolution || resolution.confidence === "unverified") return;

  const before = formatAddressSummary(addr);
  const us = isLikelyUsAddress({
    street: addr.street,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    country: resolution.address.country,
  });

  addr.street = resolution.address.street || addr.street;
  addr.city = resolution.address.city || addr.city;
  addr.state = us
    ? (normalizeUsState(resolution.address.state) ?? (resolution.address.state || addr.state))
    : (resolution.address.state || addr.state);
  addr.zip = us
    ? (normalizeZip(resolution.address.zip) ?? (resolution.address.zip || addr.zip))
    : (resolution.address.zip || addr.zip);
  if (resolution.address.country) {
    addr.country = normalizeCountryHint(resolution.address.country) ?? resolution.address.country;
  } else if (addr.country) {
    addr.country = normalizeCountryHint(addr.country) ?? addr.country;
  }

  const after = formatAddressSummary(addr);
  if (before !== after) {
    changes.push({
      field: `${path}`,
      from: before,
      to: after,
      method: "geocode",
    });
  }
}

function formatAddressSummary(addr: NormalizableAddress): string {
  return [addr.street, addr.city, addr.state, addr.zip, addr.country]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

async function normalizePartyInPlace(
  party: NormalizableParty,
  path: string,
  changes: NormalizationChange[],
  opts: { cacheDir?: string; pool?: Parameters<typeof completeJson>[0]["pool"]; fetch?: typeof fetch; enableGeocoding?: boolean },
): Promise<void> {
  for (const f of PHONE_FIELDS) {
    const cur = party[f];
    const norm = normalizePhone(cur);
    if (norm && norm !== cur) {
      changes.push({ field: `${path}.${f}`, from: cur ?? "", to: norm, method: "rule" });
      party[f] = norm;
    }
  }
  for (const addrKey of ["address", "homeAddress"] as const) {
    const addr = party[addrKey];
    if (!addr || typeof addr !== "object") continue;
    const street = addr.street?.trim() ?? "";
    const needsSplit =
      street.length > 0
      && !addr.city?.trim()
      && !addr.state?.trim()
      && street.includes(",");
    if (needsSplit) {
      const split = await splitAddressString(street, opts);
      if (split?.street) {
        const merged = {
          street: split.street,
          city: split.city ?? addr.city,
          state: split.state ?? addr.state,
          zip: split.zip ?? addr.zip,
          country: split.country ?? addr.country,
        };
        changes.push({
          field: `${path}.${addrKey}`,
          from: street,
          to: [merged.street, merged.city, merged.state, merged.zip].filter(Boolean).join(", "),
          method: "llm",
        });
        party[addrKey] = merged;
      }
    }
    normalizeAddressInPlace(party[addrKey]!, `${path}.${addrKey}`, changes);
    await enrichAddressInPlace(party[addrKey]!, `${path}.${addrKey}`, changes, opts);
  }
  if (path.endsWith("emergencyContact") && party.relationship) {
    const canon = await canonicalizeRelationship(party.relationship, opts);
    if (canon && canon.value !== party.relationship) {
      changes.push({ field: `${path}.relationship`, from: party.relationship, to: canon.value, method: canon.method });
      party.relationship = canon.value;
    }
  }
}

function applySameAddressInference(
  record: NormalizableEcRecord,
  changes: NormalizationChange[],
): void {
  const contact = record.emergencyContact;
  if (!contact || typeof contact !== "object") return;
  const inferred = inferEmergencyContactSameAddress(
    record.employee?.homeAddress ?? null,
    contact,
  );
  const prevSame = contact.sameAddressAsEmployee;
  const prevAddr = contact.address;
  if (
    typeof prevSame === "boolean"
    && inferred.sameAddressAsEmployee !== prevSame
  ) {
    changes.push({
      field: "emergencyContact.sameAddressAsEmployee",
      from: String(prevSame ?? ""),
      to: String(inferred.sameAddressAsEmployee),
      method: "rule",
    });
    contact.sameAddressAsEmployee = inferred.sameAddressAsEmployee;
  }
  if (inferred.address !== prevAddr) {
    contact.address = inferred.address ?? null;
  }
  if (
    inferred.sameAddressAsEmployee
    && hasMeaningfulAddress(record.employee?.homeAddress)
    && !hasMeaningfulAddress(contact.address)
    && (record as { originallyMissing?: string[] }).originallyMissing?.includes("emergencyContact.address")
  ) {
    // Signal only — caller surfaces as a review warning.
    (record as { warnings?: string[] }).warnings = [
      ...((record as { warnings?: string[] }).warnings ?? []),
      "Contact address was illegible on the paper — verify same-address checkbox",
    ];
  }
}

/**
 * Normalize one OCR'd Emergency Contact record IN PLACE (phones/state/zip by
 * rule, relationship by rule-then-LLM). Returns the list of changes made so the
 * caller can surface them as review warnings. Never throws — LLM exhaustion just
 * means fewer changes. Common forms make only rule changes (no API call).
 */
export async function normalizeEmergencyContactRecord(
  record: NormalizableEcRecord,
  opts: { cacheDir?: string; pool?: Parameters<typeof completeJson>[0]["pool"]; fetch?: typeof fetch; enableGeocoding?: boolean } = {},
): Promise<NormalizationChange[]> {
  const changes: NormalizationChange[] = [];
  try {
    if (record.emergencyContact && typeof record.emergencyContact === "object") {
      await normalizePartyInPlace(record.emergencyContact, "emergencyContact", changes, opts);
    }
    if (record.employee && typeof record.employee === "object") {
      await normalizePartyInPlace(record.employee, "employee", changes, opts);
    }
    applySameAddressInference(record, changes);
  } catch (err) {
    log.warn(`[normalize-contact] normalization error (kept original values): ${err instanceof Error ? err.message : String(err)}`);
  }
  return changes;
}

/** One-line summary of normalization changes for a review warning. */
export function summarizeNormalizationChanges(changes: NormalizationChange[]): string | null {
  if (changes.length === 0) return null;
  const parts = changes.map((c) => `${c.field.split(".").pop()} "${c.from}"→"${c.to}"`);
  return `Normalized: ${parts.join("; ")}`;
}
