import { z } from "zod/v4";

/**
 * Input schema for the I9 Lookup workflow — **name-based**.
 *
 * Identifies an employee by last + first name (as required by I-9 Complete's
 * search interface) and looks up who signed Section 2 of their I-9
 * (the "authorized representative" / oath signer).
 *
 * `ssn` is optional but sharpens the search when the name is ambiguous.
 * `parentSubject` carries the inherited group label from the parent workflow
 * that delegated this lookup (e.g. an OCR run that fanned it out).
 */
export const I9LookupInputSchema = z.object({
  lastName: z.string().min(1, "Last name is required"),
  firstName: z.string().min(1, "First name is required"),
  ssn: z.string().optional(),
  parentSubject: z.string().optional(),
});

export type I9LookupInput = z.infer<typeof I9LookupInputSchema>;
