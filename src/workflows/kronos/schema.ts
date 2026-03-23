import { z } from "zod";

/** Schema for a single employee ID (5+ digit numeric string). */
export const EmployeeIdSchema = z
  .string()
  .regex(/^\d{5,}$/, "Employee ID must be 5+ digits");

/** Schema for kronos batch input. */
export const KronosInputSchema = z.object({
  employeeIds: z.array(EmployeeIdSchema).min(1, "At least one employee ID required"),
  startDate: z.string().default("1/01/2017"),
  endDate: z.string().default("1/31/2026"),
  workers: z.number().int().positive().default(4),
});

export type KronosInput = z.infer<typeof KronosInputSchema>;
