import { z } from "zod/v4";

const isoDate = z.iso.date();

export const WorkStudyInputSchema = z.object({
  emplId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
  effectiveDate: z.string()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/, { message: "Effective date must be in MM/DD/YYYY format", abort: true })
    .refine((value) => {
      const [month, day, year] = value.split("/");
      return isoDate.safeParse([year, month, day].join("-")).success;
    }, "Effective date must be a valid calendar date"),
  dryRun: z.boolean().optional(),
});

export type WorkStudyInput = z.infer<typeof WorkStudyInputSchema>;
