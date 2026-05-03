/**
 * OCR form spec for paper oath rosters. Implements `OcrFormSpec` so OCR's
 * orchestrator can run this form-type generically.
 *
 * Replaces the schemas + match phase that lived in `preview-schema.ts` +
 * `prepare.ts` (both deleted in Task 25 of this plan).
 */
import { z } from "zod/v4";
import { matchAgainstRoster } from "../../match/index.js";
import type { OcrFormSpec, RosterRow, LookupKind } from "../ocr/types.js";
import type { OathSignatureInput } from "./schema.js";

// ─── Verification schema ────────────────────────────────────

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

// ─── OCR-pass record (one row of a paper roster) ──────────

export const OathRosterOcrRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative().optional(),
  printedName: z.string().optional(),
  employeeId: z.string().nullable().optional(),
  employeeSigned: z.boolean().optional(),
  officerSigned: z.boolean().nullable().optional(),
  dateSigned: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v == null) return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
  notes: z.array(z.string()).default([]),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
});
export type OathRosterOcrRecord = z.infer<typeof OathRosterOcrRecordSchema>;

export const OathOcrOutputSchema = z.array(OathRosterOcrRecordSchema);
export type OathOcrOutput = z.infer<typeof OathOcrOutputSchema>;

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

// ─── Preview record (in-flight, post-match) ────────────────

export const OathPreviewRecordSchema = OathRosterOcrRecordSchema.extend({
  employeeId: z.string(),
  matchState: MatchStateSchema,
  matchSource: z.enum(["roster", "eid-lookup", "llm", "form-eid", "manual"]).optional(),
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
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
  forceResearch: z.boolean().optional(),
});
export type OathPreviewRecord = z.infer<typeof OathPreviewRecordSchema>;

// ─── Prompt + match logic ───────────────────────────────────

const OATH_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of paper oath signature documents in one of three formats — each page is one of:
- "signin"  — multi-row sign-in sheet (many records per page)
- "upay585" — single-form per page, UPAY585 (1997, includes Patent Acknowledgment)
- "upay586" — single-form per page, UPAY586 (2015 DocuSign, oath only)
- "unknown" — blank, irrelevant, or doesn't match any of the above

For each page you process:
1. Classify document type. Map "signin"/"upay585"/"upay586" to documentType: "expected"; "unknown" → documentType: "unknown".
2. For each record extract: rowIndex (0-indexed position on the page, starting from 0 for the first record); printedName (always); employeeId if visible; dateSigned if visible; employeeSigned: whether the employee/officer signature line is filled (a scribble counts; an empty box doesn't); officerSigned: whether the authorized-official / witness signature is filled. For sign-in sheets that only have a single signature column, set officerSigned to null. For UPAY585/UPAY586, false when the column is empty.
3. After extraction, list which expected fields were BLANK or ILLEGIBLE on the paper in originallyMissing on each record.

Field-level rules:
- One record per signer. Multi-row sign-in sheets emit multiple records per page; single-form pages emit one.
- rowIndex must be included for every record and must be a non-negative integer starting at 0.
- For handwritten text, use your best transcription. If a field is illegible, set it to null and add it to originallyMissing.
- dateSigned should be transcribed as it appears on the paper (typical formats: MM/DD/YYYY or M/D/YY).
- Output ONLY valid JSON matching the schema. No commentary.`;

const NAME_AUTO_ACCEPT = 0.95;
const NAME_AUTO_ACCEPT_GAP = 0.10;
const NAME_DISAMBIG_FLOOR = 0.40;
const LLM_HIGH_CONFIDENCE = 0.6;

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Spec implementation ────────────────────────────────────

export const oathOcrFormSpec: OcrFormSpec<
  OathRosterOcrRecord,
  OathPreviewRecord,
  OathSignatureInput
> = {
  formType: "oath",
  label: "Oath signature",
  description: "Paper oath rosters / UPAY585 / UPAY586. Approves into the oath-signature daemon.",

  prompt: OATH_OCR_PROMPT,
  ocrRecordSchema: OathRosterOcrRecordSchema,
  ocrArraySchema: OathOcrOutputSchema,
  schemaName: "oath-roster-batch",

  async matchRecord({ record, roster }): Promise<OathPreviewRecord> {
    // Empty printedName + no form-EID means the LLM gave us nothing usable.
    // Surface as a manual record so the operator sees it in the preview pane
    // (with the page image visible) and can type from the source.
    const printedName = (record.printedName ?? "").trim();
    if (!printedName && !(record.employeeId ?? "").trim()) {
      return {
        ...record,
        printedName: "",
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        documentType: record.documentType ?? "expected",
        originallyMissing: ["printedName"],
        selected: false,
        warnings: ["LLM extracted no name from this page — type from the page image on the left"],
      };
    }

    if (!record.employeeSigned) {
      return {
        ...record,
        employeeId: (record.employeeId ?? "").trim(),
        matchState: "extracted",
        documentType: "expected",
        originallyMissing: [],
        selected: false,
        warnings: [],
      };
    }

    // Form-EID short-circuit: when the LLM extracted an EID from the page
    // (UPAY585/586 has an "Employee ID" field), trust the structured value
    // over the handwritten name. Roster-exact match → auto-accept; no roster
    // match → flag for eid-lookup-by-EID (verify-only branch).
    const formEid = (record.employeeId ?? "").trim();
    if (formEid.length > 0) {
      const rosterHit = roster.find((row) => row.eid === formEid);
      if (rosterHit) {
        return {
          ...record,
          employeeId: formEid,
          matchState: "matched",
          matchSource: "form-eid",
          documentType: "expected",
          originallyMissing: [],
          selected: true,
          warnings: [],
        };
      }
      return {
        ...record,
        employeeId: formEid,
        matchState: "lookup-pending",
        matchSource: "form-eid",
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings: [`EID ${formEid} extracted from form but not in roster — verifying`],
      };
    }

    // Name-resolution chain:
    //   - Top score >= NAME_AUTO_ACCEPT (0.95) with no close second → auto-accept
    //     (matchSource: "roster")
    //   - Top score in [NAME_DISAMBIG_FLOOR, NAME_AUTO_ACCEPT) OR close second →
    //     mark lookup-pending; orchestrator's disambiguating phase runs the LLM
    //     and applyDisambiguation patches the record
    //   - Top score < NAME_DISAMBIG_FLOOR (0.40) / no candidates → manual
    //     fall-through (matchSource: "manual"); eid-lookup-by-name still runs
    //     as a backstop downstream
    const ranked = matchAgainstRoster(roster, record.printedName ?? "");
    const top = ranked.candidates[0];
    const second = ranked.candidates[1];
    const topCandidates = ranked.candidates.slice(0, 5);

    if (!top || top.score < NAME_DISAMBIG_FLOOR) {
      return {
        ...record,
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        rosterCandidates: topCandidates,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          ranked.candidates.length > 0
            ? [`Best roster score ${top.score.toFixed(2)} < ${NAME_DISAMBIG_FLOOR} — manual review`]
            : ["No roster match — manual review"],
      };
    }

    const closeSecond = second && top.score - second.score < NAME_AUTO_ACCEPT_GAP;
    if (top.score >= NAME_AUTO_ACCEPT && !closeSecond && top.eid) {
      return {
        ...record,
        employeeId: top.eid,
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: topCandidates,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings: top.score < 1.0
          ? [`Roster matched "${top.name}" (score ${top.score.toFixed(2)})`]
          : [],
      };
    }

    // Ambiguous: defer to the orchestrator's disambiguating phase.
    return {
      ...record,
      employeeId: "",
      matchState: "lookup-pending",
      rosterCandidates: topCandidates,
      documentType: "expected",
      originallyMissing: [],
      selected: true,
      warnings: closeSecond
        ? [`Top score ${top.score.toFixed(2)} but close second ${second!.score.toFixed(2)} — disambiguating`]
        : [`Top score ${top.score.toFixed(2)} in disambiguation band — disambiguating`],
    };
  },

  applyDisambiguation({ record, result }): OathPreviewRecord {
    if (result.eid === null || result.eid.length === 0) {
      // LLM said "none of these" — operator must intervene.
      return {
        ...record,
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        warnings: [
          ...(record.warnings ?? []),
          "LLM disambiguation: no candidate matched — manual review",
        ],
      };
    }

    if (result.confidence < LLM_HIGH_CONFIDENCE) {
      return {
        ...record,
        employeeId: result.eid,
        matchState: "lookup-pending",
        matchSource: "llm",
        matchConfidence: result.confidence,
        warnings: [
          ...(record.warnings ?? []),
          `LLM picked EID ${result.eid} but low confidence (${result.confidence.toFixed(2)}) — review`,
        ],
      };
    }

    return {
      ...record,
      employeeId: result.eid,
      matchState: "matched",
      matchSource: "llm",
      matchConfidence: result.confidence,
      warnings: record.warnings ?? [],
    };
  },

  needsLookup(record): LookupKind {
    if (record.matchState === "extracted") return null;
    if (record.matchState === "lookup-pending") {
      // form-eid lookup-pending → we know the EID, just need to verify it
      if (record.matchSource === "form-eid") return "verify-only";
      // manual = LLM extracted nothing usable; no auto-lookup possible
      // (would dispatch eid-lookup with empty name and fail name.min(1)).
      // Operator will fill the EID directly in the preview pane.
      if (record.matchSource === "manual") return null;
      return "name";
    }
    if (record.matchState === "matched" && record.employeeId) {
      if (record.verification) return null;
      return "verify";
    }
    if (record.matchState === "resolved") return null;
    if (record.matchState === "unresolved") return null;
    return null;
  },

  carryForwardKey(record): string {
    return normalizeName(record.printedName ?? "");
  },

  applyCarryForward({ v2, v1 }): OathPreviewRecord {
    return {
      ...v2,
      employeeId: v1.employeeId || v2.employeeId,
      matchState: v1.matchState !== "lookup-pending" && v1.matchState !== "lookup-running"
        ? v1.matchState
        : v2.matchState,
      matchSource: v1.matchSource ?? v2.matchSource,
      matchConfidence: v1.matchConfidence ?? v2.matchConfidence,
      verification: v1.verification ?? v2.verification,
      selected: v1.selected,
    };
  },

  isForceResearchFlag(record): boolean {
    return record.forceResearch === true;
  },

  approveTo: {
    workflow: "oath-signature",
    deriveInput(record): OathSignatureInput {
      return {
        emplId: record.employeeId,
        ...(record.dateSigned ? { date: record.dateSigned } : {}),
      };
    },
    deriveItemId(_record, parentRunId, index): string {
      return `ocr-oath-${parentRunId}-r${index}`;
    },
  },

  recordRendererId: "OathRecordView",
  rosterMode: "required",
};
