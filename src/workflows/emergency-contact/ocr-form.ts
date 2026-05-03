/**
 * OCR form spec for UCSD R&R Emergency Contact forms. Implements `OcrFormSpec`
 * so OCR's orchestrator runs this form-type generically.
 *
 * Replaces schemas + match logic that lived in `preview-schema.ts` + `prepare.ts`
 * (both deleted in Task 25).
 */
import { z } from "zod/v4";
import {
  matchAgainstRoster,
  compareUsAddresses,
  normalizeEid,
} from "../../match/index.js";
import type { OcrFormSpec, RosterRow, LookupKind } from "../ocr/types.js";
import {
  AddressSchema,
  EmergencyContactSchema,
  type EmergencyContactRecord,
} from "./schema.js";
import { VerificationSchema, type Verification } from "../oath-signature/ocr-form.js";

// ─── Permissive OCR-pass schema ────────────────────────────

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

export const PermissiveRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  employee: PermissiveEmployeeSchema,
  emergencyContact: EmergencyContactSchema,
  notes: z.array(z.string()).default([]),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
});
export type PermissiveRecord = z.infer<typeof PermissiveRecordSchema>;

export const OcrOutputSchema = z.array(PermissiveRecordSchema);
export type OcrOutput = z.infer<typeof OcrOutputSchema>;

// ─── Match state ─────────────────────────────────────────────

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

export { VerificationSchema, type Verification } from "../oath-signature/ocr-form.js";

// ─── Preview record ────────────────────────────────────────

export const PreviewRecordSchema = PermissiveRecordSchema.extend({
  matchState: MatchStateSchema,
  matchSource: z.enum(["form", "roster", "eid-lookup", "llm"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z
    .array(z.object({ eid: z.string(), name: z.string(), score: z.number() }))
    .optional(),
  addressMatch: z.enum(["match", "differ", "missing"]).optional(),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
  forceResearch: z.boolean().optional(),
});
export type PreviewRecord = z.infer<typeof PreviewRecordSchema>;

// ─── Prompt + constants ────────────────────────────────────

const EC_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of UCSD R&R Emergency Contact Information forms — one form per page (occasionally a page may not be a form at all). For each page produce one record.

For each page:
1. Classify document type: "expected" if UCSD R&R Emergency Contact form; "unknown" otherwise.
2. After extracting fields, list which expected fields were BLANK or ILLEGIBLE on the paper.
   The expected fields: employee.name, employee.employeeId, emergencyContact.name, emergencyContact.relationship, emergencyContact.address, emergencyContact.cellPhone/homePhone/workPhone (any one suffices).

Field-level rules:
- Extract every record visible; one per page.
- For handwritten text use your best transcription; if illegible set null and add to originallyMissing.
- Phone numbers normalized to "(XXX) XXX-XXXX" when digits clear.
- Addresses: US format. Pull street/city/state(2-letter)/zip into separate fields.
- Do not invent data. If a field is blank, return null and list in originallyMissing.
- Output ONLY valid JSON matching the schema. No commentary.`;

const ROSTER_AUTO_ACCEPT = 0.85;

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Spec ──────────────────────────────────────────────────

export const emergencyContactOcrFormSpec: OcrFormSpec<
  PermissiveRecord,
  PreviewRecord,
  EmergencyContactRecord
> = {
  formType: "emergency-contact",
  label: "Emergency contact",
  description: "UCSD R&R Emergency Contact forms. Approves into the emergency-contact daemon.",

  prompt: EC_OCR_PROMPT,
  ocrRecordSchema: PermissiveRecordSchema,
  ocrArraySchema: OcrOutputSchema,
  schemaName: "emergency-contact-batch",

  matchRecord({ record, roster }): PreviewRecord {
    // Stage 1: form-EID. If the operator transcribed an EID on the paper,
    // trust it (subject to verification later).
    const formEid = normalizeEid(record.employee.employeeId);
    if (formEid) {
      return {
        ...record,
        employee: { ...record.employee, employeeId: formEid },
        matchState: "matched",
        matchSource: "form",
        matchConfidence: 1.0,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings: [],
      };
    }
    // Stage 2: roster match by name. Auto-accept only when the matched
    // roster row carries a UCPath EID — when the SharePoint roster has
    // no UCPath ID for that person yet (column blank or absent), fall
    // through to the eid-lookup branch so the downstream daemon resolves
    // the EID instead of trusting an empty string.
    const result = matchAgainstRoster(roster, record.employee.name);
    if (result.bestScore >= ROSTER_AUTO_ACCEPT && result.candidates[0].eid) {
      const top = result.candidates[0];
      const rosterRow = roster.find((r) => r.eid === top.eid);
      const addressMatch =
        rosterRow && rosterRow.street
          ? compareUsAddresses(record.employee.homeAddress ?? null, {
              street: rosterRow.street,
              city: rosterRow.city,
              state: rosterRow.state,
              zip: rosterRow.zip,
            })
          : undefined;
      return {
        ...record,
        employee: { ...record.employee, employeeId: top.eid },
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: result.candidates.slice(0, 3),
        addressMatch,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          top.score < 1.0
            ? [`Roster fuzzy-matched "${top.name}" (score ${top.score.toFixed(2)})`]
            : [],
      };
    }
    return {
      ...record,
      employee: { ...record.employee, employeeId: "" },
      matchState: "lookup-pending",
      rosterCandidates: result.candidates.slice(0, 3),
      documentType: "expected",
      originallyMissing: [],
      selected: true,
      warnings:
        result.candidates.length > 0
          ? [`Best roster score ${result.bestScore.toFixed(2)} < ${ROSTER_AUTO_ACCEPT} — needs eid-lookup`]
          : ["No roster match — falling back to eid-lookup"],
    };
  },

  needsLookup(record): LookupKind {
    if (record.verification) return null;
    if (record.matchState === "lookup-pending") return "name";
    if (record.matchState === "matched" && record.employee.employeeId) return "verify";
    return null;
  },

  carryForwardKey(record): string {
    return normalizeName(record.employee.name);
  },

  applyCarryForward({ v2, v1 }): PreviewRecord {
    return {
      ...v2,
      employee: {
        ...v2.employee,
        employeeId: v1.employee.employeeId || v2.employee.employeeId,
      },
      matchState: v1.matchState !== "lookup-pending" && v1.matchState !== "lookup-running"
        ? v1.matchState
        : v2.matchState,
      matchSource: v1.matchSource ?? v2.matchSource,
      matchConfidence: v1.matchConfidence ?? v2.matchConfidence,
      verification: v1.verification ?? v2.verification,
      addressMatch: v1.addressMatch ?? v2.addressMatch,
      selected: v1.selected,
    };
  },

  isForceResearchFlag(record): boolean {
    return record.forceResearch === true;
  },

  approveTo: {
    workflow: "emergency-contact",
    deriveInput(record): EmergencyContactRecord {
      return {
        sourcePage: record.sourcePage,
        employee: {
          ...record.employee,
          employeeId: record.employee.employeeId,
        },
        emergencyContact: record.emergencyContact,
        notes: record.notes ?? [],
      } as EmergencyContactRecord;
    },
    deriveItemId(record, parentRunId, index): string {
      return `ocr-ec-${parentRunId}-r${index}`;
    },
  },

  recordRendererId: "EcRecordView",
  rosterMode: "required",
};
