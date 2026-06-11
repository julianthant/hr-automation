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
import {
  DocumentTypeSchema,
  LLM_HIGH_CONFIDENCE,
  MatchStateSchema,
  VerificationSchema,
  assertCarryForwardKindCompatible,
  isForceResearchFlagRecord,
  ocrChildItemIdPrefix,
} from "./shared.js";

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
  formKind: z.enum(["oath", "emergency-contact", "unknown"]).default("emergency-contact"),
  sourcePage: z.number().int().positive(),
  // `z.preprocess(v => v ?? {}, …)` because the prompt tells the model to NULL
  // EC-specific fields (employee, emergencyContact) on non-EC pages (oath/unknown
  // classified inside an EC run). A bare non-nullable object would schema-drop
  // that correctly-classified wrong-form page (per-page.ts then flips it to
  // success:false → data loss). Coercing `null → {}` lets the permissive
  // sub-schemas fill their defaults, keeping downstream `record.employee.X` /
  // `record.emergencyContact.X` reads null-safe. Mirrors the 2026-06-04
  // documentType tolerant-coercion precedent.
  employee: z.preprocess((v) => v ?? {}, PermissiveEmployeeSchema),
  emergencyContact: z.preprocess((v) => v ?? {}, PermissiveEmergencyContactOcrSchema),
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

The PDF is a stack of UCSD R&R Emergency Contact Information forms. BEFORE extracting fields, classify each page:
- "emergency-contact" — UCSD R&R Emergency Contact Information form
- "oath"              — UC loyalty oath / patent acknowledgment form (UPAY585, UPAY586, or a multi-row sign-in sheet)
- "unknown"           — blank, irrelevant, or does not match any of the above

For each page produce one record with:
- formKind: classify as "emergency-contact", "oath", or "unknown". Set "oath" if the page is a UC loyalty oath form, "unknown" for blank/irrelevant pages. Leave EC-specific fields (employee, emergencyContact) null for non-EC pages.

For each page also:
1. Classify document type: "expected" if any recognized form (EC or oath); "unknown" for blank/irrelevant pages.
2. After extracting fields, list which expected EC fields were BLANK or ILLEGIBLE on the paper (for non-EC pages use []).
   The expected EC fields: employee.name, employee.employeeId, emergencyContact.name, emergencyContact.relationship, emergencyContact.address, emergencyContact.cellPhone/homePhone/workPhone (any one suffices).

OUTPUT SHAPE (CRITICAL — must be a FLAT JSON ARRAY at the top level):

\`\`\`json
[
  { "formKind": "emergency-contact", "sourcePage": 1, "employee": { "name": "Doe, Jane", "employeeId": "10000001" }, "emergencyContact": { "name": "Doe, John", "relationship": "Spouse" }, "documentType": "expected", "originallyMissing": [], "notes": [] }
]
\`\`\`

Do NOT wrap records in a page object. Do NOT nest under "records" or "data" keys. The top-level value MUST be a JSON array. Each element is exactly one record (one per page).

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
        documentType: record.documentType ?? "expected",
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
        documentType: record.documentType ?? "expected",
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
      documentType: record.documentType ?? "expected",
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
    // Only reject merging two DIFFERENT known kinds (mirrors verify.applyCarryForward).
    // Legacy JSONL rows (parsed without Zod defaults) may have formKind undefined —
    // tolerate them. Also tolerate "oath"/"unknown" classifications (a re-run that
    // re-classified the same page); carry v2 formKind forward.
    assertCarryForwardKindCompatible("emergency-contact", v1.formKind, v2.formKind);
    return {
      // Spread v2 WITHOUT pinning formKind: the v2 record reflects this run's
      // re-classification, so its kind (which may differ from v1's "emergency-
      // contact" if the page was re-classified) carries forward — identical to
      // oath.applyCarryForward, which deliberately omits its own formKind pin.
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

  isForceResearchFlag: isForceResearchFlagRecord,

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
      return `${ocrChildItemIdPrefix("emergency-contact")}-${parentRunId}-r${index}`;
    },
    canFanOut(record): boolean {
      // Skip records EXPLICITLY classified as non-EC pages (oath or unknown) —
      // they have no EC-shape fields. A record with no formKind (legacy/partial
      // row) defaults to emergency-contact, so it still fans out (preserves the
      // prior "every selected EC record fans out" behavior).
      const kind = record.formKind as string | undefined;
      if (kind === "oath" || kind === "unknown") return false;
      // EID-completeness gate (F12, mirrors oath's `hasOathSignerInput`): an EC
      // child is enqueued by EID — the daemon navigates UCPath to that person.
      // A blank/invalid EID would fan out a child guaranteed to fail at
      // navigation, so skip it (the approve route keeps per-record itemIds in
      // sync with what actually enqueues).
      const emplId = normalizeUcpathEmployeeId(record.employee?.employeeId ?? "");
      return /^\d{5,}$/.test(emplId);
    },
  },

  rosterMode: "required",
  // F5: brand a STANDALONE EC OCR run `ec-…` (matches EC's own approve-target
  // workflow code). Without this, a standalone EC run fell back to the OCR
  // default `oc-…`. An EC PDF run started as an operation still derives `ec`
  // from `operationTraceCode("emergency-contact")` first; this covers the bare
  // OCR-hub EC upload (no operation intent).
  traceCode: "ec",
};
