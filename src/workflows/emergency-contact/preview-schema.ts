import { z } from "zod/v4";
import { AddressSchema, EmergencyContactSchema, RecordSchema } from "./schema.js";

// ─── Permissive OCR-pass schema ────────────────────────────
//
// The strict EmployeeSchema requires `employeeId: \d{5,}`. OCR'd records
// frequently lack the EID (it gets filled in later from the roster or
// eid-lookup), so we relax that constraint just for the LLM output. The
// orchestrator (`prepare.ts`) fills the EID before any record is enqueued
// as a child kernel item — at that point the strict RecordSchema applies.
//
// All other constraints (name, contact relationship, etc.) are preserved.

const PermissiveEmployeeSchema = z.object({
  name: z.string().min(1),
  employeeId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ?? "").trim()),
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

const PermissiveRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  employee: PermissiveEmployeeSchema,
  emergencyContact: EmergencyContactSchema,
  notes: z.array(z.string()).default([]),
});

/**
 * Per-record state in the preview row.
 *
 * The matchState progression:
 *   extracted   → just OCR'd, no roster check yet
 *   matched     → resolved synchronously via form-EID or roster lookup
 *   lookup-pending  → no roster match; queued for eid-lookup daemon
 *   lookup-running  → eid-lookup daemon claimed and is searching
 *   resolved    → eid-lookup returned an EID
 *   unresolved  → eid-lookup returned no EID, or daemon failed
 *
 * Only `resolved` and `matched` count as approvable states.
 */
export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

// ─── Verification (cross-workflow) ────────────────────────
//
// Populated by stage 5 of the OCR + Roster Method (Person Org Summary
// verification via the eid-lookup daemon). State semantics:
//   verified       — active employee in HDH dept
//   inactive       — employee found but hrStatus != "Active"
//   non-hdh        — employee active but department not in HDH whitelist
//   lookup-failed  — Person Org Summary search returned nothing or errored
export const VerificationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("verified"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("inactive"),
    hrStatus: z.string(),
    department: z.string().optional(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("non-hdh"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("lookup-failed"),
    error: z.string(),
    checkedAt: z.string(),
  }),
]);
export type Verification = z.infer<typeof VerificationSchema>;

export const PreviewRecordSchema = PermissiveRecordSchema.extend({
  matchState: MatchStateSchema,
  matchSource: z.enum(["form", "roster", "eid-lookup", "llm"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z
    .array(
      z.object({
        eid: z.string(),
        name: z.string(),
        score: z.number(),
      }),
    )
    .optional(),
  addressMatch: z.enum(["match", "differ", "missing"]).optional(),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
});
export type PreviewRecord = z.infer<typeof PreviewRecordSchema>;

export const PrepareRowDataSchema = z.object({
  mode: z.literal("prepare"),
  pdfPath: z.string(),
  pdfOriginalName: z.string(),
  rosterMode: z.enum(["download", "existing"]),
  rosterPath: z.string(),
  pageImagesDir: z.string().optional(),
  records: z.array(PreviewRecordSchema),
  ocrProvider: z.string().optional(),
  ocrAttempts: z.number().int().nonnegative().optional(),
  ocrCached: z.boolean().optional(),
});
export type PrepareRowData = z.infer<typeof PrepareRowDataSchema>;

/**
 * Schema fed to ocrDocument — array of records with a permissive
 * `employee.employeeId` (nullable / empty allowed). The orchestrator
 * fills in the real EID via roster match or eid-lookup before any
 * record is enqueued as a child kernel item, where the strict
 * `RecordSchema` (with `\d{5,}` EID regex) takes over.
 *
 * The same-address-when-null transform on `EmergencyContactSchema`
 * still fires through this nested usage.
 */
export const OcrOutputSchema = z.array(PermissiveRecordSchema);
