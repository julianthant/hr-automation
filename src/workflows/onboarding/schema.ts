import { z } from "zod/v4";
import { ExtractionError } from "../../crm/types.js";

export const EmployeeDataSchema = z.object({
  positionNumber: z.string().min(1, "Position number is required"),
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  ssn: z.string().regex(
    /^\d{3}-\d{2}-\d{4}$/,
    "SSN must be in XXX-XX-XXXX format",
  ),
  address: z.string().min(1, "Address is required"),
  city: z.string().min(1, "City is required"),
  state: z.string().min(1, "State is required"),
  postalCode: z.string().regex(
    /^\d{5}(-\d{4})?$/,
    "Postal code must be XXXXX or XXXXX-XXXX format",
  ),
  wage: z.string().min(1, "Wage is required"),
  effectiveDate: z.string().min(1, "Effective date is required"),
});

export type EmployeeData = z.infer<typeof EmployeeDataSchema>;

/**
 * Validate raw extracted data against the EmployeeData schema.
 * Throws ExtractionError with failedFields on validation failure.
 */
export function validateEmployeeData(
  raw: Record<string, string | null>,
): EmployeeData {
  // Convert null values to undefined so Zod sees them as missing
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    cleaned[key] = value ?? undefined;
  }

  const result = EmployeeDataSchema.safeParse(cleaned);

  if (!result.success) {
    const flat = z.flattenError(result.error);
    const failedFields = Object.keys(flat.fieldErrors);
    const prettyMessage = z.prettifyError(result.error);

    throw new ExtractionError(
      `Validation failed for ${failedFields.length} field(s):\n${prettyMessage}`,
      failedFields,
    );
  }

  return result.data;
}
