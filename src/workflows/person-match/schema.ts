import { z } from "zod/v4";
import { PARENT_SUBJECT_FRAGMENT } from "../../domain/delegation-input-fragments.js";

/**
 * Input schema for the Person Match workflow — **identity-based**.
 *
 * Identifies a person by legal name plus at least one hard identifier (SSN or
 * date of birth) and checks whether UCPath already knows them, via the same
 * HR-Tasks person search onboarding uses to discriminate new hires from
 * rehires (`searchPerson` in `src/systems/ucpath/navigate.ts`).
 *
 * UCPath person search offers only NID-based or DOB-based search orders, so a
 * record with neither an SSN nor a DOB cannot be searched at all — the schema
 * rejects it up front (fail loud at enqueue, not mid-run).
 *
 * `parentSubject` carries the inherited group label from the parent workflow
 * that delegated this match (e.g. an I-9 OCR run that fanned it out).
 */
export const PersonMatchInputSchema = z
  .object({
    lastName: z.string().min(1, "Last name is required"),
    firstName: z.string().min(1, "First name is required"),
    /** National ID (SSN), digits only — dashes stripped by the caller. */
    ssn: z.string().optional(),
    /** Date of birth, MM/DD/YYYY. */
    dob: z.string().optional(),
    ...PARENT_SUBJECT_FRAGMENT,
  })
  .refine((input) => Boolean(input.ssn?.trim() || input.dob?.trim()), {
    message:
      "UCPath person search requires an SSN or a date of birth — provide at least one",
  });

export type PersonMatchInput = z.infer<typeof PersonMatchInputSchema>;
