import { z } from "zod/v4";

export const ProcessEidSheetInputSchema = z.object({
  source: z.literal("roster-sheet"),
  sheet: z.string().trim().min(1),
  /** Internal/test override. Dashboard runs normally use the newest local onboarding roster. */
  rosterPath: z.string().trim().min(1).optional(),
});

export const ProcessEidPersonInputSchema = z.object({
  source: z.literal("person"),
  livedName: z.string().trim().min(1),
  transactionId: z.string().trim().regex(/^T\d{4,}$/i),
  sheet: z.string().trim().min(1),
  rosterRow: z.number().int().positive(),
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
