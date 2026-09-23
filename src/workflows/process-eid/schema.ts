import { z } from "zod/v4";

export const ProcessEidSheetInputSchema = z.object({
  source: z.literal("roster-sheet"),
  /**
   * Worksheet name inside an `.xlsx` roster. Omit for a `.csv` roster (one
   * table) or a single-worksheet workbook.
   */
  sheet: z.string().trim().min(1).optional(),
  /**
   * Full path to a roster `.xlsx`/`.csv`. Omit to use the newest local
   * onboarding roster.
   */
  rosterPath: z.string().trim().min(1).optional(),
});

export const ProcessEidPersonInputSchema = z.object({
  source: z.literal("person"),
  livedName: z.string().trim().min(1),
  /** Present only when the roster's legal name differs from the lived name. */
  legalName: z.string().trim().min(1).optional(),
  transactionId: z.string().trim().regex(/^T\d{4,}$/i),
  sheet: z.string().trim().min(1),
  rosterRow: z.number().int().positive(),
  /**
   * A roster defect that makes this row unsafe to look up (today: the same
   * transaction number on two rows). Carried on the input so the row fails
   * loud with the reason instead of the whole roster refusing to expand.
   */
  rosterConflict: z.string().trim().min(1).optional(),
});

export const ProcessEidInputSchema = z.discriminatedUnion("source", [
  ProcessEidSheetInputSchema,
  ProcessEidPersonInputSchema,
]);

export type ProcessEidSheetInput = z.infer<typeof ProcessEidSheetInputSchema>;
export type ProcessEidPersonInput = z.infer<typeof ProcessEidPersonInputSchema>;
export type ProcessEidInput = z.infer<typeof ProcessEidInputSchema>;

export function isProcessEidPersonInput(
  input: ProcessEidInput,
): input is ProcessEidPersonInput {
  return input.source === "person";
}

/** How a sheet-input run labels itself before it expands into person rows. */
export function processEidSheetLabel(input: ProcessEidSheetInput): string {
  if (input.sheet) return input.sheet;
  if (input.rosterPath) {
    const separator = input.rosterPath.lastIndexOf("/");
    return separator >= 0
      ? input.rosterPath.slice(separator + 1)
      : input.rosterPath;
  }
  return "Newest onboarding roster";
}
