/**
 * OCR form spec for UCSD R&R Emergency Contact forms. Implements `OcrFormSpec`
 * so OCR's orchestrator runs this form-type generically.
 *
 * Replaces schemas + match logic that lived in `preview-schema.ts` + `prepare.ts`
 * (both deleted in Task 25).
 */
import { z } from "zod/v4";
import { normalizeUcpathEmployeeId } from "../../../domain/identity/eid.js";
import {
  matchAgainstRoster,
  compareUsAddresses,
  normalizeEid,
} from "../../matching/index.js";
import { normalizePersonNameForCompare } from "../../../domain/identity/person-name.js";
import type { OcrFormSpec, LookupKind } from "../../../workflows/ocr/types.js";
import type { EmergencyContactRecord } from "../../../workflows/emergency-contact/schema.js";
import { DocumentTypeSchema, LLM_HIGH_CONFIDENCE, MatchStateSchema, VerificationSchema } from "./shared.js";

// ─── Permissive OCR-pass schemas ───────────────────────────
//
// These are intentionally LOOSER than the strict downstream schemas in
// `src/workflows/emergency-contact/schema.ts`.  The vision LLM never sets
// `sameAddressAsEmployee` (it is a computed field, not on the paper form) and
// may leave `name` / `relationship` blank on a partially-filled form.  Using the
// strict schema here caused per-page `finalize()` to drop every EC record with
// the error "expected boolean, received undefined" → whole PDF appeared empty.
//
// The strict schemas still validate at the EC daemon boundary (when the approved
// input is re-parsed); strictness belongs there, not during extraction.

/**
 * Permissive address shape for the OCR pass.  `street` is nullable/optional so
 * a partially-extracted address does not drop the whole record.
 */
const PermissiveAddressOcrSchema = z.object({
  street: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
});

/**
 * Permissive emergency-contact shape for the OCR pass.
 *
 * Key differences from the strict `EmergencyContactSchema`:
 * - `sameAddressAsEmployee`: optional (the LLM never sets it; we default it
 *   using the same blank-address logic the strict schema's `.transform` uses).
 * - `name` / `relationship`: nullable+optional so a partially-filled form still
 *   extracts instead of being dropped.  The operator completes them in review.
 * - `address`: uses the permissive address schema so partial address data
 *   survives.
 */
const PermissiveEmergencyContactOcrSchema = z
  .object({
    name: z.string().nullable().optional(),
    relationship: z.string().nullable().optional(),
    primary: z.boolean().default(true),
    /**
     * Intentionally optional: `sameAddressAsEmployee` is a COMPUTED field never
     * present on the paper form, so the vision LLM never emits it.  We default it
     * here with the same logic as the strict schema's `.transform`: when the
     * contact has no address, force same-as-employee = true so UCPath gets the
     * employee's address rather than nothing.
     */
    sameAddressAsEmployee: z.boolean().optional(),
    address: PermissiveAddressOcrSchema.nullable().optional(),
    cellPhone: z.string().nullable().optional(),
    homePhone: z.string().nullable().optional(),
    workPhone: z.string().nullable().optional(),
  })
  .transform((c) => {
    // Mirror the strict schema's blank-address rule so the downstream cast
    // (`as EmergencyContactRecord`) is always safe: when there is no contact
    // address, assume same-as-employee.
    const hasAddress = c.address != null && c.address.street != null && c.address.street.trim().length > 0;
    const sameAddress = c.sameAddressAsEmployee ?? !hasAddress;
    return {
      ...c,
      sameAddressAsEmployee: sameAddress,
      address: sameAddress ? null : c.address,
    };
  });

const PermissiveEmployeeSchema = z.object({
  name: z.string().nullable().optional(),
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
  homeAddress: PermissiveAddressOcrSchema.nullable().optional(),
  homePhone: z.string().nullable().optional(),
  cellPhone: z.string().nullable().optional(),
});

export const PermissiveRecordSchema = z.object({
  formKind: z.literal("emergency-contact").default("emergency-contact"),
  sourcePage: z.number().int().positive(),
  employee: PermissiveEmployeeSchema,
  emergencyContact: PermissiveEmergencyContactOcrSchema,
  notes: z.array(z.string()).default([]),
  documentType: DocumentTypeSchema,
  originallyMissing: z.array(z.string()).default([]),
});
export type PermissiveRecord = z.infer<typeof PermissiveRecordSchema>;

export const OcrOutputSchema = z.array(PermissiveRecordSchema);
export type OcrOutput = z.infer<typeof OcrOutputSchema>;

// ─── Preview record ────────────────────────────────────────

export const PreviewRecordSchema = PermissiveRecordSchema.extend({
  matchState: MatchStateSchema,
  matchSource: z.enum(["form", "roster", "eid-lookup", "llm"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z
    .array(z.object({ eid: z.string(), name: z.string(), score: z.number() }))
    .optional(),
  addressMatch: z.enum(["match", "differ", "missing"]).optional(),
  documentType: DocumentTypeSchema,
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

  async matchRecord({ record, roster }): Promise<PreviewRecord> {
    // Stage 1: form-EID. If the operator transcribed an EID on the paper,
    // trust it (subject to verification later).
    const formEid = normalizeUcpathEmployeeId(normalizeEid(record.employee.employeeId));
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
    const result = matchAgainstRoster(roster, record.employee.name ?? "");
    if (
      result.candidates.length === 1 &&
      result.candidates[0].eid &&
      result.candidates[0].score >= ROSTER_AUTO_ACCEPT
    ) {
      const top = result.candidates[0];
      const rosterRow = roster.find((r) => r.eid === top.eid);
      // `compareUsAddresses` checks `!a.street` internally and returns "missing"
      // when the street is blank — safe to cast the permissive address here.
      const addressMatch =
        rosterRow && rosterRow.street
          ? compareUsAddresses(
              record.employee.homeAddress as { street: string } | null | undefined,
              { street: rosterRow.street, city: rosterRow.city, state: rosterRow.state, zip: rosterRow.zip },
            )
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
            ? [`Single roster candidate "${top.name}" accepted (score ${top.score.toFixed(2)}); active-check will verify`]
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
          ? [`${result.candidates.length} roster candidates need LLM disambiguation`]
          : [`No roster match above ${ROSTER_AUTO_ACCEPT} — falling back to eid-lookup`],
    };
  },

  applyDisambiguation({ record, result }): PreviewRecord {
    const resultEid = normalizeUcpathEmployeeId(result.eid);
    if (resultEid.length === 0) {
      return {
        ...record,
        employee: { ...record.employee, employeeId: "" },
        matchState: "lookup-pending",
        matchSource: "llm",
        warnings: [
          ...(record.warnings ?? []),
          "LLM disambiguation: no roster candidate matched — falling back to eid-lookup by name",
        ],
      };
    }

    if (result.confidence < LLM_HIGH_CONFIDENCE) {
      return {
        ...record,
        employee: { ...record.employee, employeeId: resultEid },
        matchState: "lookup-pending",
        matchSource: "llm",
        matchConfidence: result.confidence,
        warnings: [
          ...(record.warnings ?? []),
          `LLM picked EID ${resultEid} but low confidence (${result.confidence.toFixed(2)}) — review`,
        ],
      };
    }

    return {
      ...record,
      employee: { ...record.employee, employeeId: resultEid },
      matchState: "matched",
      matchSource: "llm",
      matchConfidence: result.confidence,
      warnings: record.warnings ?? [],
    };
  },

  needsLookup(record): LookupKind {
    if (record.verification) return null;
    if (record.matchState === "lookup-pending") return "name";
    if (record.matchState === "matched" && normalizeUcpathEmployeeId(record.employee.employeeId)) return "verify";
    return null;
  },

  carryForwardKey(record): string {
    return normalizePersonNameForCompare(record.employee.name);
  },

  applyCarryForward({ v2, v1 }): PreviewRecord {
    // See oath.applyCarryForward for the rationale on the per-form-type
    // assertion + why we tolerate `undefined` from legacy JSONL rows.
    if (
      (v1.formKind !== undefined && v1.formKind !== "emergency-contact") ||
      (v2.formKind !== undefined && v2.formKind !== "emergency-contact")
    ) {
      throw new Error(
        `emergency-contact.applyCarryForward: cross-form-type carry-forward not supported (v1=${v1.formKind}, v2=${v2.formKind})`,
      );
    }
    return {
      ...v2,
      formKind: "emergency-contact",
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
    deriveItemId(_record, parentRunId, index): string {
      return `ocr-ec-${parentRunId}-r${index}`;
    },
  },

  rosterMode: "required",
};
