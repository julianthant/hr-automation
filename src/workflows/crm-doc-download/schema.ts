import { z } from "zod/v4";

export const CrmDocDownloadInputSchema = z.object({
  email: z.string().email().optional(),
  emplId: z.string().regex(/^\d{5,}$/, "EID must be numeric (5+ digits)").optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  middleName: z.string().optional(),
  folderPath: z.string().min(1).optional(),
  docIndices: z.array(z.number().int().min(0)).nonempty().optional(),
  parentSubject: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  taskGroupId: z.string().min(1).optional(),
}).refine((input) => input.email || input.emplId, {
  message: "email or emplId is required",
});

export type CrmDocDownloadInput = z.infer<typeof CrmDocDownloadInputSchema>;
