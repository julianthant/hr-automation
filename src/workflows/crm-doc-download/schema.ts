import { z } from "zod/v4";
import { DELEGATION_CONTEXT_FRAGMENT } from "../../domain/delegation-input-fragments.js";

export const CrmDocDownloadInputSchema = z.object({
  email: z.string().email().optional(),
  emplId: z.string().regex(/^\d{5,}$/, "EID must be numeric (5+ digits)").optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  middleName: z.string().optional(),
  folderPath: z.string().min(1).optional(),
  docIndices: z.array(z.number().int().min(0)).nonempty().optional(),
  ...DELEGATION_CONTEXT_FRAGMENT,
}).refine((input) => input.email || input.emplId, {
  message: "email or emplId is required",
});

export type CrmDocDownloadInput = z.infer<typeof CrmDocDownloadInputSchema>;
