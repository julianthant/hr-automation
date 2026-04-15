import { z } from "zod/v4";
import fs from "node:fs";
import { parse as parseYaml } from "yaml";

// ── Address ────────────────────────────────────────────────

export const AddressSchema = z.object({
  street: z.string().min(1),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
});
export type Address = z.infer<typeof AddressSchema>;

// ── Employee context (informational — used for display + verification) ──

export const EmployeeSchema = z.object({
  name: z.string().min(1),
  employeeId: z.string().regex(/^\d{5,}$/, "Employee ID must be numeric (5+ digits)"),
  pid: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  workLocation: z.string().nullable().optional(),
  supervisor: z.string().nullable().optional(),
  workEmail: z.string().nullable().optional(),
  personalEmail: z.string().nullable().optional(),
  homeAddress: AddressSchema.nullable().optional(),
  homePhone: z.string().nullable().optional(),
  cellPhone: z.string().nullable().optional(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

// ── Emergency contact (the actual input to UCPath) ────────

export const EmergencyContactSchema = z.object({
  name: z.string().min(1),
  /** Raw relationship text from the form (e.g. "Mom", "Dad", "Parent"). Mapped to UCPath dropdown at runtime. */
  relationship: z.string().min(1),
  /** Always true per form conventions — single emergency contact per record. */
  primary: z.boolean().default(true),
  /** Computed during extraction by comparing contact address to employee home address. */
  sameAddressAsEmployee: z.boolean(),
  /** Present only when sameAddressAsEmployee is false. */
  address: AddressSchema.nullable().optional(),
  cellPhone: z.string().nullable().optional(),
  homePhone: z.string().nullable().optional(),
  workPhone: z.string().nullable().optional(),
});
export type EmergencyContact = z.infer<typeof EmergencyContactSchema>;

// ── Record + batch ─────────────────────────────────────────

export const RecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  employee: EmployeeSchema,
  emergencyContact: EmergencyContactSchema,
  notes: z.array(z.string()).default([]),
});
export type EmergencyContactRecord = z.infer<typeof RecordSchema>;

export const BatchSchema = z.object({
  pdfPath: z.string().min(1),
  batchName: z.string().min(1),
  records: z.array(RecordSchema).min(1),
});
export type EmergencyContactBatch = z.infer<typeof BatchSchema>;

// ── Loader ─────────────────────────────────────────────────

/**
 * Load and validate a batch YAML file.
 * Throws a descriptive error if the file is missing or schema-invalid.
 */
export function loadBatch(yamlPath: string): EmergencyContactBatch {
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Batch file not found: ${yamlPath}`);
  }
  const raw = fs.readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw);
  const result = BatchSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(`Batch YAML is invalid:\n  ${issues}`);
  }
  return result.data;
}
