import { z } from "zod/v4";

export const KronosPayRuleInputSchema = z.object({
  emplId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
});

export type KronosPayRuleInput = z.infer<typeof KronosPayRuleInputSchema>;
