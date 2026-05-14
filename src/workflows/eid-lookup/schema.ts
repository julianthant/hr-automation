import { z } from "zod";
import { displayPersonName } from "../../domain/identity/person-name.js";
import { normalizeUcpathEmployeeId } from "../../domain/identity/eid.js";

/** Common input shape for both no-CRM and CRM-on lookups. */
export const EidLookupInputSchema = z.object({
  names: z.array(z.string().min(1)).min(1),
  workers: z.number().int().positive(),
});

export type EidLookupInput = z.infer<typeof EidLookupInputSchema>;

/** CRM-on input is the same shape — separate alias for clarity at call sites. */
export const EidLookupCrmInputSchema = EidLookupInputSchema;

export type EidLookupCrmInput = EidLookupInput;

/**
 * Per-item shape for the shared-context-pool batch mode. Two input shapes:
 *
 * - `{ name }`   — original name-search flow. Multi-strategy parse +
 *                  search by Last/First/Middle.
 * - `{ emplId }` — verification-only flow used by the prep orchestrators
 *                  (OCR + Roster Method stage 5). Direct EID search,
 *                  drills into the single result, captures HR status +
 *                  department + Person Org Summary screenshot.
 *
 * Both inputs accept an optional `keepNonHdh` flag. When set, the handler
 * returns the result regardless of HDH dept (the prep flow needs to surface
 * non-HDH employees as flagged-but-visible). CLI invocations omit the flag
 * so the existing HDH-rejection behavior is preserved.
 */
export const EidLookupNameInputSchema = z.object({
  name: z.string().min(1),
  keepNonHdh: z.boolean().optional(),
  parentSubject: z.string().optional(),
});

export const EidLookupEidInputSchema = z.object({
  emplId: z.string()
    .transform((value) => normalizeUcpathEmployeeId(value))
    .pipe(z.string().regex(/^10\d{6}$/, "Empl ID must be 8 digits starting with 10")),
  keepNonHdh: z.boolean().optional(),
  parentSubject: z.string().optional(),
});

export const EidLookupItemSchema = z.union([
  EidLookupNameInputSchema,
  EidLookupEidInputSchema,
]);

export type EidLookupItem = z.infer<typeof EidLookupItemSchema>;
export type EidLookupNameInput = z.infer<typeof EidLookupNameInputSchema>;
export type EidLookupEidInput = z.infer<typeof EidLookupEidInputSchema>;

/** Type guard: input is the EID-search variant. */
export function isEidInput(input: EidLookupItem): input is EidLookupEidInput {
  return "emplId" in input;
}

/**
 * Normalize a raw "Last, First Middle" input string to a consistent display
 * format: title-cased parts separated by a single `", "`.
 *
 * Intended to be applied at the CLI boundary so every downstream consumer
 * (search form fields, tracker `searchName`, dashboard detail cell) sees the
 * same casing regardless of how the user typed it. UCPath and CRM forms are
 * case-insensitive so title-casing doesn't affect matching.
 *
 * Behavior:
 *   - "zaw, hein thant"    → "Zaw, Hein Thant"
 *   - "SMITH, JOHN"        → "Smith, John"
 *   - "  smith , john  "   → "Smith, John"   (trim + single-space collapse)
 *   - "plain string"       → "plain string"  (no comma → unchanged; search.ts
 *                            will throw its own format error downstream)
 *   - "smith,"             → "smith,"        (empty first → unchanged)
 */
export function normalizeName(raw: string): string {
  const display = displayPersonName(raw);
  return display || raw;
}
