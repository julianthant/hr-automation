import { z } from "zod";
import {
  displayPersonName,
  normalizeName,
} from "../../domain/identity/person-name.js";
import {
  normalizeUcpathEmployeeId,
  isUcpathEmployeeId,
  normalizeEid,
} from "../../domain/identity/eid.js";

export { normalizeName };

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
  parentSubject: z.string().optional(),
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
  parentSubject: z.string().optional(),
  /**
   * When true, person-lookup runs an extra CRM-date step that stamps
   * `employmentDate` (CRM First Day of Service) and `oathDate` (CRM Date
   * Signed) onto output data. Used by the OCR `verify` flow; omitted for
   * normal lookups so they stay fast.
   */
  includeCrmDates: z.boolean().optional(),
});

export const PersonLookupItemSchema = z.union([
  PersonLookupNameInputSchema,
  PersonLookupEidInputSchema,
]);

export type PersonLookupItem = z.infer<typeof PersonLookupItemSchema>;
export type PersonLookupNameInput = z.infer<typeof PersonLookupNameInputSchema>;
export type PersonLookupEidInput = z.infer<typeof PersonLookupEidInputSchema>;

/** Type guard: input is the EID-search variant. */
export function isEidInput(input: PersonLookupItem): input is PersonLookupEidInput {
  return "emplId" in input;
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
  if (isEidInput(input)) return input.name ? `${input.name} (${input.emplId})` : input.emplId;
  return displayPersonName(input.name) || input.name.trim();
}

/** Stable per-item id derived from the input. */
export function derivePersonLookupItemId(input: PersonLookupItem): string {
  if (isEidInput(input)) return input.emplId;
  return normalizeName(input.name);
}
