import { z } from "zod";
export { normalizeName } from "../../domain/identity/person-name.js";
import { normalizeUcpathEmployeeId } from "../../domain/identity/eid.js";

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

