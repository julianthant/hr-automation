import { z } from "zod";
import {
  displayPersonName,
  normalizeName,
  parseLastFirstName,
} from "../../domain/identity/person-name.js";
import {
  normalizeUcpathEmployeeId,
  isUcpathEmployeeId,
  normalizeEid,
} from "../../domain/identity/eid.js";
import { PARENT_SUBJECT_FRAGMENT } from "../../domain/delegation-input-fragments.js";

export { normalizeName };

export const PERSON_LOOKUP_MODES = ["search", "match"] as const;

const PERSON_LOOKUP_SHARED_FRAGMENT = {
  mode: z.enum(PERSON_LOOKUP_MODES).default("search"),
  crmCheck: z.boolean().optional(),
  ...PARENT_SUBJECT_FRAGMENT,
};

/**
 * Per-item shape for the Person Lookup shared-context-pool batch mode. Two
 * input shapes:
 *
 * - `{ name }`   — name-search flow. Multi-strategy parse + search by
 *                  Last/First/Middle, then CRM cross-verification +
 *                  active-status disposition.
 * - `{ emplId }` — direct EID search. Drills into the single result, captures
 *                  HR status + department + Person Org Summary screenshot, and
 *                  derives active-status. CRM cross-verification is skipped for
 *                  EID inputs (the EID already identifies the person).
 *
 * Both inputs accept an optional `keepNonHdh` flag. When set, the handler
 * returns the result regardless of HDH dept (operator review + the prep flow
 * need to surface non-HDH employees as flagged-but-visible).
 */
export const PersonLookupNameInputSchema = z.object({
  name: z.string().min(1),
  keepNonHdh: z.boolean().optional(),
  ...PERSON_LOOKUP_SHARED_FRAGMENT,
  /**
   * When true, person-lookup runs an extra CRM-date step that stamps
   * `employmentDate` (CRM First Day of Service) and `oathDate` (CRM Date
   * Signed) onto output data. Used by the OCR `verify` flow; omitted for
   * normal lookups so they stay fast.
   */
  includeCrmDates: z.boolean().optional(),
});

export const PersonLookupEidInputSchema = z.object({
  emplId: z.string()
    .transform((value) => normalizeUcpathEmployeeId(value))
    .pipe(z.string().regex(/^10\d{6}$/, "Empl ID must be 8 digits starting with 10")),
  name: z.string().min(1).optional(),
  keepNonHdh: z.boolean().optional(),
  ...PERSON_LOOKUP_SHARED_FRAGMENT,
  /**
   * When true, person-lookup runs an extra CRM-date step that stamps
   * `employmentDate` (CRM First Day of Service) and `oathDate` (CRM Date
   * Signed) onto output data. Used by the OCR `verify` flow; omitted for
   * normal lookups so they stay fast.
   */
  includeCrmDates: z.boolean().optional(),
});

/**
 * Match-mode input for UCPath HR-Tasks person search. A legal name plus at
 * least one hard identifier is required because the PeopleSoft search offers
 * only NID- and DOB-based search orders; a name alone cannot be submitted.
 */
export const PersonLookupMatchInputSchema = z
  .object({
    lastName: z.string().min(1, "Last name is required"),
    firstName: z.string().min(1, "First name is required"),
    /** National ID (SSN), digits only — dashes stripped by the caller. */
    ssn: z.string().optional(),
    /** Date of birth, MM/DD/YYYY. */
    dob: z.string().optional(),
    ...PERSON_LOOKUP_SHARED_FRAGMENT,
  })
  .refine((input) => Boolean(input.ssn?.trim() || input.dob?.trim()), {
    message:
      "UCPath person search requires an SSN or a date of birth — provide at least one",
  });

export const PersonLookupItemSchema = z.union([
  PersonLookupNameInputSchema,
  PersonLookupEidInputSchema,
  PersonLookupMatchInputSchema,
]);

// Use the input types so existing callers may omit `mode`; the schemas still
// resolve the parsed handler value to mode="search" via the Zod default.
export type PersonLookupItem = z.input<typeof PersonLookupItemSchema>;
export type PersonLookupNameInput = z.input<typeof PersonLookupNameInputSchema>;
export type PersonLookupEidInput = z.input<typeof PersonLookupEidInputSchema>;
export type PersonLookupMatchInput = z.input<typeof PersonLookupMatchInputSchema>;
export type PersonLookupSearchInput = PersonLookupNameInput | PersonLookupEidInput;
export type PersonLookupMode = (typeof PERSON_LOOKUP_MODES)[number];

/** Type guard: input is the EID-search variant. */
export function isEidInput(input: PersonLookupItem): input is PersonLookupEidInput {
  return "emplId" in input;
}

/** Type guard: input is the HR-Tasks Search/Match variant. */
export function isMatchInput(input: PersonLookupItem): input is PersonLookupMatchInput {
  return "lastName" in input && "firstName" in input;
}

/** Runtime mode resolution for parsed inputs and legacy callers that omit it. */
export function resolvePersonLookupMode(input: PersonLookupItem): PersonLookupMode {
  return input.mode === "match" ? "match" : "search";
}

/** CRM defaults on for Search mode and off for Match mode. */
export function resolvePersonLookupCrmCheck(input: PersonLookupItem): boolean {
  return input.crmCheck ?? resolvePersonLookupMode(input) === "search";
}

function matchInputName(input: PersonLookupMatchInput): string {
  return displayPersonName(`${input.lastName}, ${input.firstName}`);
}

function matchInputPresenceHint(input: PersonLookupMatchInput): string {
  return [input.dob?.trim() ? "DOB" : "", input.ssn?.trim() ? "SSN" : ""]
    .filter(Boolean)
    .join(" + ");
}

/**
 * Parse one dashboard Match-mode person line.
 *
 * Format: `Last, First, DOB, SSN`. The last two comma-separated fields are
 * always DOB then SSN; all preceding fields are joined back into the name.
 * `x` (case-insensitive) means the identifier is unavailable.
 */
export function parsePersonLookupMatchLine(line: string): PersonLookupMatchInput {
  const raw = line.trim();
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length < 3) {
    throw new Error(
      `Person Lookup Match input "${raw}" must contain name, DOB, and SSN fields`,
    );
  }

  const dobRaw = parts.at(-2) ?? "";
  const ssnRaw = parts.at(-1) ?? "";
  const nameRaw = parts.slice(0, -2).join(", ");
  const parsedName = parseLastFirstName(nameRaw);
  if (!parsedName) {
    throw new Error(
      `Person Lookup Match input "${raw}" must name the person as "Last, First"`,
    );
  }

  const dob = /^x$/i.test(dobRaw) ? undefined : dobRaw;
  const ssn = /^x$/i.test(ssnRaw) ? undefined : ssnRaw;
  if (!dob?.trim() && !ssn?.trim()) {
    throw new Error(
      `Person Lookup Match input "${raw}" cannot use x for both DOB and SSN`,
    );
  }
  return PersonLookupMatchInputSchema.parse({
    mode: "match",
    lastName: parsedName.lastName,
    firstName: parsedName.firstName,
    ...(dob ? { dob } : {}),
    ...(ssn ? { ssn } : {}),
  });
}

/**
 * Map a raw operator query string to a typed input. A query that is all
 * digits/spaces/dashes and parses as a UCPath EID becomes an `{ emplId }`
 * input; anything else is treated as a `{ name }`.
 */
export function buildPersonLookupCliInput(query: string): PersonLookupNameInput | { emplId: string } {
  const trimmed = query.trim();
  if (trimmed.length > 0 && /^[\d\s-]+$/.test(trimmed) && isUcpathEmployeeId(normalizeEid(trimmed))) {
    return { emplId: query };
  }
  return { name: query };
}

/** Operator-facing display string for a Person Lookup input. */
export function displayPersonLookupInput(input: PersonLookupItem): string {
  if (isMatchInput(input)) {
    const hint = matchInputPresenceHint(input);
    return `${matchInputName(input)}${hint ? ` (${hint})` : ""}`;
  }
  if (isEidInput(input)) return input.name ? `${input.name} (${input.emplId})` : input.emplId;
  return displayPersonName(input.name) || input.name.trim();
}

/** Stable per-item id derived from the input. */
export function derivePersonLookupItemId(input: PersonLookupItem): string {
  if (isMatchInput(input)) return displayPersonLookupInput(input);
  if (isEidInput(input)) return input.emplId;
  return normalizeName(input.name);
}
