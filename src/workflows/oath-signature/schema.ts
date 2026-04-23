import { z } from "zod/v4";

/**
 * Input schema for the Oath Signature workflow.
 *
 * `emplId` is the UCPath employee ID (5+ digits). `date` is optional —
 * when omitted, the workflow accepts whatever value UCPath prefills on
 * the Add-New-Oath-Signature-Date detail form (today's date). When
 * provided, it overrides the prefill. Must be MM/DD/YYYY to match
 * PeopleSoft's date textbox format.
 */
export const OathSignatureInputSchema = z.object({
  emplId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
  date: z
    .string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, "Date must be in MM/DD/YYYY format")
    .optional(),
});

export type OathSignatureInput = z.infer<typeof OathSignatureInputSchema>;
