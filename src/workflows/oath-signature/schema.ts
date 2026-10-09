import { z } from "zod/v4";
import { PARENT_SUBJECT_FRAGMENT } from "../../domain/delegation-input-fragments.js";

/**
 * Input schema for the Oath Signature workflow — **EID-only**.
 *
 * One EID, one UCPath transaction, one row. `emplId` is the UCPath employee ID
 * (5+ digits). `date` is optional; when omitted, the workflow accepts whatever
 * value UCPath prefills on the Add-New-Oath-Signature-Date detail form (today's
 * date). When provided, it overrides the prefill. Must be MM/DD/YYYY to match
 * PeopleSoft's date textbox format.
 *
 * The paper-roster PDF variant was removed (2026-06-02): OCR is now the prep /
 * approval hub, and on approve it fans out one EID signer row per approved
 * record into THIS workflow plus one ServiceNow ticket row into `oath-upload`.
 * oath-signature no longer runs OCR or delegates to itself — that self-fan-out
 * deadlocked the single-worker daemon.
 *
 * Shared fields:
 *  - `dryRun` — skip the UCPath Save click.
 *  - `parentSubject` — operator-facing label inherited from the OCR run that
 *    fanned this signer out.
 */
export const OathSignatureInputSchema = z.object({
  emplId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
  name: z.string().optional(),
  date: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Date must be in MM/DD/YYYY format")
    .optional(),
  dryRun: z.boolean().optional(),
  ...PARENT_SUBJECT_FRAGMENT,
});

export type OathSignatureInput = z.infer<typeof OathSignatureInputSchema>;
/** Alias kept for callers that distinguish the signer shape by name. */
export type OathSignerInput = OathSignatureInput;
