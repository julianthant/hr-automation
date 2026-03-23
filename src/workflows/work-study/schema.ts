import { z } from "zod/v4";

export const WorkStudyInputSchema = z.object({
  emplId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
  effectiveDate: z.string().regex(
    /^\d{2}\/\d{2}\/\d{4}$/,
    "Effective date must be in MM/DD/YYYY format",
  ),
});

export type WorkStudyInput = z.infer<typeof WorkStudyInputSchema>;
