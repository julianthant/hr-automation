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
  evaluateRosterIdentityTrust,
  shouldSkipPersonLookupForRosterTrust,
} from "../../matching/index.js";
import type { NameSimilarityTier } from "../../matching/match.js";
import { normalizePersonNameForCompare } from "../../../domain/identity/person-name.js";
import { resolveOcrPersonDisplayName } from "../../../domain/identity/ocr-person-name.js";
import type { OcrFormSpec, LookupKind } from "../../../workflows/ocr/types.js";
import type { EmergencyContactRecord } from "../../../workflows/emergency-contact/schema.js";
import {
  DocumentTypeSchema,
  MatchStateSchema,
  VerificationSchema,
  applyDisambiguationStd,
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
 * Tolerant wrapper for an OCR-pass address (VL-003). The vision LLM sometimes
 * returns an address as a single STRING (a one-line "123 Main St, City, CA")
 * instead of the structured object — a strict object schema then rejected the
 * field and per-page `finalize()` dropped the WHOLE record (the operator saw
 * fewer approvable EC records than the PDF held). `z.preprocess` coerces a bare
 * string into `{ street: <string> }` so the record survives and the downstream
 * `.transform`'s `c.address.street` read (+ the strict EC daemon-boundary
 * re-parse) keep working; the operator splits the line out in review. `null` /
 * `undefined` short-circuit through `.nullable().optional()` BEFORE the
 * preprocess runs, so only an actual string is coerced. Same "never drop a
 * record over one field" precedent as the 2026-06-07 documentType/employee
 * tolerant-coercion lessons.
 */
const TolerantAddressOcrSchema = z.preprocess(
  (v) => (typeof v === "string" ? { street: v } : v),
  PermissiveAddressOcrSchema,
);

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
    address: TolerantAddressOcrSchema.nullable().optional(),
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
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
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
  homeAddress: TolerantAddressOcrSchema.nullable().optional(),
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
  /** When set to same/similar, person-lookup is skipped — roster EID+name are trusted. */
  rosterNameTrust: z.enum(["same", "similar"]).optional(),
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

function trustedRosterMatchFields(tier: NameSimilarityTier): Pick<
  PreviewRecord,
  "rosterNameTrust" | "warnings"
> {
  return {
    rosterNameTrust: tier === "same" ? "same" : "similar",
    warnings:
      tier === "similar"
        ? ["Roster EID + similar name — skipping person lookup"]
        : [],
  };
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

  async matchRecord({ record, roster }): Promise<PreviewRecord> {
    const ocrName = record.employee.name ?? "";

    // Stage 1: form-EID — cross-check against the SharePoint roster by EID
    // and compare names with classifyNameSimilarity (same/se similar → trust).
    const formEid = normalizeUcpathEmployeeId(normalizeEid(record.employee.employeeId));
    if (formEid) {
      const trust = evaluateRosterIdentityTrust(ocrName, formEid, roster);
      if (trust && shouldSkipPersonLookupForRosterTrust(trust.tier)) {
        const rosterRow = trust.row;
        const addressMatch =
          rosterRow.street
            ? compareUsAddresses(
                record.employee.homeAddress as { street: string } | null | undefined,
                {
                  street: rosterRow.street,
                  city: rosterRow.city,
                  state: rosterRow.state,
                  zip: rosterRow.zip,
                },
              )
            : undefined;
        return {
          ...record,
          employee: { ...record.employee, employeeId: formEid },
          matchState: "matched",
          matchSource: "form",
          matchConfidence: trust.tier === "same" ? 1.0 : 0.9,
          addressMatch,
          documentType: record.documentType ?? "expected",
          originallyMissing: [],
          selected: true,
          ...trustedRosterMatchFields(trust.tier),
        };
      }
      if (trust?.tier === "different") {
        return {
          ...record,
          employee: { ...record.employee, employeeId: formEid },
          matchState: "lookup-pending",
          matchSource: "form",
          documentType: record.documentType ?? "expected",
          originallyMissing: [],
          selected: true,
          warnings: [
            `EID ${formEid} on roster as "${trust.row.name}" but OCR name "${ocrName}" differs — person lookup will verify`,
          ],
        };
      }
      return {
        ...record,
        employee: { ...record.employee, employeeId: formEid },
        matchState: "lookup-pending",
        matchSource: "form",
        documentType: record.documentType ?? "expected",
        originallyMissing: [],
        selected: true,
        warnings: [`EID ${formEid} extracted from form but not in roster — verifying`],
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
      const nameTier = rosterRow
        ? evaluateRosterIdentityTrust(ocrName, top.eid, roster)?.tier
        : undefined;
      const skipLookup = nameTier != null && shouldSkipPersonLookupForRosterTrust(nameTier);
      // `compareUsAddresses` checks `!a.street` internally and returns "missing"
      // when the street is blank — safe to cast the permissive address here.
      const addressMatch =
        rosterRow && rosterRow.street
          ? compareUsAddresses(
              record.employee.homeAddress as { street: string } | null | undefined,
              { street: rosterRow.street, city: rosterRow.city, state: rosterRow.state, zip: rosterRow.zip },
            )
          : undefined;
      if (nameTier === "different") {
        return {
          ...record,
          employee: { ...record.employee, employeeId: top.eid },
          matchState: "lookup-pending",
          rosterCandidates: result.candidates.slice(0, 3),
          documentType: record.documentType ?? "expected",
          originallyMissing: [],
          selected: true,
          warnings: [
            `Roster EID ${top.eid} matched by fuzzy name but OCR name "${ocrName}" differs from roster "${top.name}" — person lookup will verify`,
          ],
        };
      }
      // `skipLookup` already implies `nameTier != null` (see its definition above).
      const trusted = skipLookup && nameTier ? trustedRosterMatchFields(nameTier) : null;
      const scoreWarnings =
        top.score < 1.0
          ? [`Single roster candidate "${top.name}" accepted (score ${top.score.toFixed(2)}); active-check will verify`]
          : [];
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
        warnings: trusted ? trusted.warnings : scoreWarnings,
        ...(trusted ?? {}),
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
    // Shared 3-branch outcome (forms/shared.ts); EC writes the nested
    // `employee.employeeId` and falls back to name lookup on no-candidate.
    return applyDisambiguationStd({
      record,
      result,
      writeEid: (r, eid) => ({ ...r, employee: { ...r.employee, employeeId: eid } }),
      noMatch: {
        matchSource: "llm",
        warning: "LLM disambiguation: no roster candidate matched — falling back to eid-lookup by name",
      },
    });
  },

  needsLookup(record): LookupKind {
    if (record.verification) return null;
    if (record.rosterNameTrust === "same" || record.rosterNameTrust === "similar") return null;
    if (record.matchState === "lookup-pending") {
      const eid = normalizeUcpathEmployeeId(record.employee.employeeId);
      if (eid && record.matchSource === "form") return "verify";
      return "name";
    }
    if (record.matchState === "matched" && normalizeUcpathEmployeeId(record.employee.employeeId)) {
      return "verify";
    }
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
      const employeeName = resolveOcrPersonDisplayName({
        firstName: record.employee.firstName,
        lastName: record.employee.lastName,
        fullName: record.employee.name,
      });
      return {
        sourcePage: record.sourcePage,
        employee: {
          ...record.employee,
          name: employeeName || record.employee.name,
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

  // Loading-phase placeholders must be EC-SHAPED (identity under `employee.*`,
  // contact under `emergencyContact.*`) — the shared oath-shaped default put
  // top-level `printedName`/`employeeId` on EC rows (the E2E-004 shape flip)
  // and crashed `EcRecordView`'s unguarded `record.emergencyContact.X` reads
  // while the Preview tab was open mid-extraction. `sameAddressAsEmployee`
  // defaults true to match the no-address convention above.
  placeholderFields(): Record<string, unknown> {
    return {
      employee: { name: "", employeeId: "" },
      emergencyContact: {
        name: "",
        relationship: "",
        primary: true,
        sameAddressAsEmployee: true,
        address: null,
      },
    };
  },

  // No `traceCode` (E2E-007, reverses F5): a STANDALONE EC upload to the OCR
  // panel brands the OCR default `oc-…`. The spec-level `"ec"` made standalone
  // OCR-hub EC preps grep-collide with real emergency-contact operations; only
  // an operation run derives `ec` (`operationTraceCode("emergency-contact")`).
};
